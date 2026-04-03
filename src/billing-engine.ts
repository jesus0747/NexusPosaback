// ─── FASE 12: Billing Engine ──────────────────────────────────────────────────
//
// Single source of truth for:
//   - Plan feature catalog (what each plan unlocks)
//   - Entitlement cache (tenant plan + status + feature overrides, 5-min TTL)
//   - Active status guard (isActive → false if suspended/canceled)
//   - Feature gate (canUseFeature → boolean)
//   - Lifecycle: suspend, activate, cancel, upgrade, record billing events
//
// Architecture rule: this module is pure business logic — no HTTP, no Express.
// Routes import from here; this module imports only DB + types.

import { db } from "@workspace/db";
import { nexusTenants, nexusBillingEvents } from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import crypto from "node:crypto";

// ─── Feature flag definition ──────────────────────────────────────────────────
//
// Tier mapping:
//   BASIC      → core POS + orders only
//   PRO        → + KDS + reports/analytics + inventory
//   ENTERPRISE → + multi-device + advanced sync + API + branding + support

export interface TenantFeatures {
  kds: boolean;                 // Kitchen Display System tab            (Pro+)
  advanced_analytics: boolean;  // Reports, revenue charts & exports     (Pro+)
  multi_device: boolean;        // Advanced multi-device sync            (Enterprise)
  customer_display: boolean;    // Customer-facing order screen          (Enterprise)
  modifier_groups: boolean;     // Item modifiers / add-ons              (Basic+)
  inventory_tracking: boolean;  // Stock qty management                  (Pro+)
  advanced_sync: boolean;       // Real-time cross-device event sync     (Enterprise)
  multi_printer: boolean;       // SDK multi-printer support             (Enterprise)
  api_access: boolean;          // External API / webhook integrations   (Enterprise)
  custom_branding: boolean;     // Logo, colors, receipt header          (Enterprise)
  priority_support: boolean;    // SLA-backed support channel            (Enterprise)
}

// ─── Plan catalog ─────────────────────────────────────────────────────────────

export interface PlanDefinition {
  name: string;
  tagline: string;              // Short tier description shown in UI
  price_monthly_cents: number;  // 0 = free
  price_yearly_cents: number;   // 0 = free / not offered
  features: TenantFeatures;
  stripe_price_monthly?: string;
  stripe_price_yearly?: string;
}

export const PLAN_CATALOG: Record<string, PlanDefinition> = {
  // ── Tier 1: Basic (free) ─────────────────────────────────────────────────
  basic: {
    name: "Basic",
    tagline: "Solo POS + Orders",
    price_monthly_cents: 0,
    price_yearly_cents: 0,
    features: {
      kds: false,
      advanced_analytics: false,
      multi_device: false,
      customer_display: false,
      modifier_groups: true,
      inventory_tracking: false,
      advanced_sync: false,
      multi_printer: false,    // IP-only fallback, single printer
      api_access: false,
      custom_branding: false,
      priority_support: false,
    },
  },

  // ── Tier 2: Pro ($49/mo) ─────────────────────────────────────────────────
  pro: {
    name: "Pro",
    tagline: "KDS + Reports",
    price_monthly_cents: 4900,   // $49/mo
    price_yearly_cents: 47040,   // $470.40/yr (save 20 %)
    features: {
      kds: true,
      advanced_analytics: true,
      multi_device: false,
      customer_display: false,
      modifier_groups: true,
      inventory_tracking: true,
      advanced_sync: false,
      multi_printer: false,    // IP-only, single printer — upgrade for SDK
      api_access: false,
      custom_branding: false,
      priority_support: false,
    },
  },

  // ── Tier 3: Enterprise ($199/mo) ─────────────────────────────────────────
  enterprise: {
    name: "Enterprise",
    tagline: "Multi-device + Advanced Sync",
    price_monthly_cents: 19900,  // $199/mo
    price_yearly_cents: 191040,  // $1,910.40/yr (save 20 %)
    features: {
      kds: true,
      advanced_analytics: true,
      multi_device: true,
      customer_display: true,
      modifier_groups: true,
      inventory_tracking: true,
      advanced_sync: true,
      multi_printer: true,     // Full SDK, unlimited printers
      api_access: true,
      custom_branding: true,
      priority_support: true,
    },
  },

  // ── Legacy alias: starter → basic ────────────────────────────────────────
  // Kept for backward compatibility with existing DB rows.
  starter: {
    name: "Basic",
    tagline: "Solo POS + Orders",
    price_monthly_cents: 0,
    price_yearly_cents: 0,
    features: {
      kds: false,
      advanced_analytics: false,
      multi_device: false,
      customer_display: false,
      modifier_groups: true,
      inventory_tracking: false,
      advanced_sync: false,
      multi_printer: false,
      api_access: false,
      custom_branding: false,
      priority_support: false,
    },
  },
};

// ─── Entitlement cache ────────────────────────────────────────────────────────
// Avoid a DB round-trip on every event push.
// TTL = 5 minutes; invalidated on any lifecycle mutation.

export interface TenantEntitlement {
  tenant_id: string;
  plan: string;
  status: string;            // active | suspended | canceled | trialing
  features: TenantFeatures;
  trial_ends_at: Date | null;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  cached_at: number;         // Date.now() ms
}

const CACHE_TTL_MS = 5 * 60 * 1_000; // 5 minutes
const entitlementCache = new Map<string, TenantEntitlement>();

function isCacheValid(entry: TenantEntitlement): boolean {
  return Date.now() - entry.cached_at < CACHE_TTL_MS;
}

function invalidate(tenantId: string): void {
  entitlementCache.delete(tenantId);
}

// Merge plan defaults with custom_features overrides (jsonb).
function buildFeatures(plan: string, customFeatures: unknown): TenantFeatures {
  const base = PLAN_CATALOG[plan]?.features ?? PLAN_CATALOG["starter"]!.features;
  if (!customFeatures || typeof customFeatures !== "object") return { ...base };
  return { ...base, ...(customFeatures as Partial<TenantFeatures>) };
}

async function fetchAndCache(tenantId: string): Promise<TenantEntitlement | null> {
  const [row] = await db
    .select({
      tenant_id: nexusTenants.tenant_id,
      plan: nexusTenants.plan,
      status: nexusTenants.status,
      trial_ends_at: nexusTenants.trial_ends_at,
      custom_features: nexusTenants.custom_features,
      stripe_customer_id: nexusTenants.stripe_customer_id,
      stripe_subscription_id: nexusTenants.stripe_subscription_id,
    })
    .from(nexusTenants)
    .where(eq(nexusTenants.tenant_id, tenantId))
    .limit(1);

  if (!row) return null;

  const entitlement: TenantEntitlement = {
    tenant_id: tenantId,
    plan: row.plan,
    status: row.status,
    features: buildFeatures(row.plan, row.custom_features),
    trial_ends_at: row.trial_ends_at,
    stripe_customer_id: row.stripe_customer_id ?? null,
    stripe_subscription_id: row.stripe_subscription_id ?? null,
    cached_at: Date.now(),
  };

  entitlementCache.set(tenantId, entitlement);
  return entitlement;
}

// ─── Public read API ──────────────────────────────────────────────────────────

export async function getEntitlement(tenantId: string): Promise<TenantEntitlement | null> {
  const cached = entitlementCache.get(tenantId);
  if (cached && isCacheValid(cached)) return cached;
  return fetchAndCache(tenantId);
}

export async function isActive(tenantId: string): Promise<boolean> {
  const e = await getEntitlement(tenantId);
  if (!e) return false;
  if (e.status === "active") return true;
  // trialing: active until trial_ends_at
  if (e.status === "trialing") {
    if (!e.trial_ends_at) return true;
    return new Date() < e.trial_ends_at;
  }
  return false; // suspended | canceled
}

export async function canUseFeature(
  tenantId: string,
  feature: keyof TenantFeatures
): Promise<boolean> {
  const e = await getEntitlement(tenantId);
  if (!e) return false;
  if (!(await isActive(tenantId))) return false;
  return e.features[feature] === true;
}

// ─── Billing event logger ─────────────────────────────────────────────────────

type BillingEventType =
  | "plan_changed"
  | "payment_received"
  | "payment_failed"
  | "suspended"
  | "activated"
  | "canceled"
  | "trial_started"
  | "trial_ended"
  | "subscription_created"
  | "subscription_renewed"
  | "subscription_failed"
  | "subscription_suspended";

export async function recordBillingEvent(
  tenantId: string,
  type: BillingEventType,
  details: Record<string, unknown> = {},
  actor = "system"
): Promise<void> {
  await db.insert(nexusBillingEvents).values({
    id: crypto.randomUUID(),
    tenant_id: tenantId,
    type,
    details,
    actor,
  });
}

// ─── Lifecycle mutations ──────────────────────────────────────────────────────

export async function upgradePlan(
  tenantId: string,
  newPlan: string,
  actor = "admin"
): Promise<void> {
  const current = await getEntitlement(tenantId);
  if (!PLAN_CATALOG[newPlan]) throw new Error(`Unknown plan: ${newPlan}`);

  await db
    .update(nexusTenants)
    .set({ plan: newPlan, updated_at: new Date() })
    .where(eq(nexusTenants.tenant_id, tenantId));

  await recordBillingEvent(tenantId, "plan_changed", {
    from: current?.plan ?? "unknown",
    to: newPlan,
  }, actor);

  invalidate(tenantId);
}

export async function suspendTenant(
  tenantId: string,
  reason: string,
  actor = "system"
): Promise<void> {
  await db
    .update(nexusTenants)
    .set({ status: "suspended", updated_at: new Date() })
    .where(eq(nexusTenants.tenant_id, tenantId));

  await recordBillingEvent(tenantId, "suspended", { reason }, actor);
  invalidate(tenantId);
}

export async function activateTenant(
  tenantId: string,
  actor = "system"
): Promise<void> {
  await db
    .update(nexusTenants)
    .set({ status: "active", updated_at: new Date() })
    .where(eq(nexusTenants.tenant_id, tenantId));

  await recordBillingEvent(tenantId, "activated", {}, actor);
  invalidate(tenantId);
}

export async function cancelSubscription(
  tenantId: string,
  reason: string,
  actor = "system"
): Promise<void> {
  await db
    .update(nexusTenants)
    .set({ status: "canceled", updated_at: new Date() })
    .where(eq(nexusTenants.tenant_id, tenantId));

  await recordBillingEvent(tenantId, "canceled", { reason }, actor);
  invalidate(tenantId);
}

export async function startTrial(
  tenantId: string,
  trialDays: number,
  plan: string,
  actor = "system"
): Promise<void> {
  const trialEnd = new Date(Date.now() + trialDays * 86_400_000);

  await db
    .update(nexusTenants)
    .set({
      status: "trialing",
      plan,
      trial_ends_at: trialEnd,
      updated_at: new Date(),
    })
    .where(eq(nexusTenants.tenant_id, tenantId));

  await recordBillingEvent(tenantId, "trial_started", {
    plan,
    trial_days: trialDays,
    trial_ends_at: trialEnd.toISOString(),
  }, actor);

  invalidate(tenantId);
}

export async function recordPayment(
  tenantId: string,
  amountCents: number,
  currency: string,
  stripePaymentIntentId?: string,
  actor = "system"
): Promise<void> {
  await recordBillingEvent(tenantId, "payment_received", {
    amount_cents: amountCents,
    currency,
    stripe_payment_intent_id: stripePaymentIntentId,
  }, actor);
}

// ─── Subscription flow events (FASE 12 subscription flow) ────────────────────

export async function onSubscriptionCreated(
  tenantId: string,
  plan: string,
  stripeSubscriptionId: string,
  stripeCustomerId: string
): Promise<void> {
  await db
    .update(nexusTenants)
    .set({
      plan,
      status: "active",
      stripe_customer_id: stripeCustomerId,
      stripe_subscription_id: stripeSubscriptionId,
      updated_at: new Date(),
    })
    .where(eq(nexusTenants.tenant_id, tenantId));

  await recordBillingEvent(tenantId, "subscription_created", {
    plan,
    stripe_subscription_id: stripeSubscriptionId,
    stripe_customer_id: stripeCustomerId,
  });

  invalidate(tenantId);
}

export async function onSubscriptionRenewed(
  tenantId: string,
  amountCents: number,
  currency: string,
  stripeInvoiceId: string
): Promise<void> {
  await db
    .update(nexusTenants)
    .set({ status: "active", updated_at: new Date() })
    .where(eq(nexusTenants.tenant_id, tenantId));

  await recordBillingEvent(tenantId, "subscription_renewed", {
    amount_cents: amountCents,
    currency,
    stripe_invoice_id: stripeInvoiceId,
  });

  invalidate(tenantId);
}

export async function onSubscriptionFailed(
  tenantId: string,
  stripeInvoiceId: string,
  reason: string
): Promise<void> {
  await recordBillingEvent(tenantId, "subscription_failed", {
    stripe_invoice_id: stripeInvoiceId,
    reason,
  });
  // Don't suspend immediately — Stripe retries. Suspension on subscription.deleted.
}

export async function onSubscriptionSuspended(
  tenantId: string,
  stripeSubscriptionId: string,
  reason: string
): Promise<void> {
  await db
    .update(nexusTenants)
    .set({ status: "suspended", updated_at: new Date() })
    .where(eq(nexusTenants.tenant_id, tenantId));

  await recordBillingEvent(tenantId, "subscription_suspended", {
    stripe_subscription_id: stripeSubscriptionId,
    reason,
  });

  invalidate(tenantId);
}

// ─── Cache diagnostics ────────────────────────────────────────────────────────

export function getCacheSnapshot(): Array<{
  tenant_id: string;
  plan: string;
  status: string;
  age_ms: number;
}> {
  const now = Date.now();
  return [...entitlementCache.values()].map((e) => ({
    tenant_id: e.tenant_id,
    plan: e.plan,
    status: e.status,
    age_ms: now - e.cached_at,
  }));
}
