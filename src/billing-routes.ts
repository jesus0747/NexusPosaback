// ─── FASE 12: Billing Routes ──────────────────────────────────────────────────
//
// Device endpoints (require Bearer token auth):
//   GET  /nexus/billing/entitlement     — plan, status, features, limits
//
// Admin endpoints (require X-Admin-Key header):
//   GET  /nexus/admin/billing/tenants   — all tenants with billing info
//   GET  /nexus/admin/billing/:id       — single tenant billing detail
//   POST /nexus/admin/billing/:id/plan  — change plan
//   POST /nexus/admin/billing/:id/suspend
//   POST /nexus/admin/billing/:id/activate
//   POST /nexus/admin/billing/:id/cancel
//   GET  /nexus/admin/billing/:id/history — billing events log

import { Router, type IRouter } from "express";
import { z } from "zod";
import { db } from "@workspace/db";
import { nexusDevices, nexusTenants, nexusBillingEvents, nexusEvents } from "@workspace/db/schema";
import { eq, desc, gte, and, sql, lt } from "drizzle-orm";
import {
  getEntitlement,
  isActive,
  PLAN_CATALOG,
  upgradePlan,
  suspendTenant,
  activateTenant,
  cancelSubscription,
  recordBillingEvent,
  getCacheSnapshot,
} from "./billing-engine.js";
import { getLimits } from "./tenant-limits.js";

const router: IRouter = Router();

// ─── Device auth helper (same as routes.ts) ───────────────────────────────────

async function resolveDevice(
  authHeader: string | undefined
): Promise<{ device_id: string; tenant_id: string } | null> {
  if (!authHeader?.startsWith("Bearer ")) return null;
  const token = authHeader.slice(7);
  const [device] = await db
    .select({ device_id: nexusDevices.device_id, tenant_id: nexusDevices.tenant_id })
    .from(nexusDevices)
    .where(eq(nexusDevices.token, token))
    .limit(1);
  return device ?? null;
}

// ─── Admin key guard ──────────────────────────────────────────────────────────

function requireAdmin(
  req: { headers: Record<string, string | string[] | undefined> },
  res: { status: (n: number) => { json: (b: unknown) => void } }
): boolean {
  const expected = process.env["NEXUS_ADMIN_KEY"];
  // If no key is configured: allow in dev, reject in production
  if (!expected) {
    if (process.env["NODE_ENV"] === "production") {
      res.status(401).json({ error: "NEXUS_ADMIN_KEY not configured" });
      return false;
    }
    return true; // dev mode: open access
  }
  const key = req.headers["x-admin-key"];
  if (key !== expected) {
    res.status(401).json({ error: "Admin key required" });
    return false;
  }
  return true;
}

// ─── GET /nexus/billing/entitlement ──────────────────────────────────────────
// Returns the full entitlement for the authenticated device's tenant.
// Android app fetches this on startup + every 5 minutes to stay in sync.

router.get("/nexus/billing/entitlement", async (req, res) => {
  const auth = await resolveDevice(req.headers["authorization"]);
  if (!auth) {
    res.status(401).json({ error: "Device not registered or invalid token" });
    return;
  }

  const entitlement = await getEntitlement(auth.tenant_id);
  if (!entitlement) {
    res.status(404).json({ error: "Tenant not found" });
    return;
  }

  const limits = getLimits(entitlement.plan);

  res.json({
    tenant_id: auth.tenant_id,
    plan: entitlement.plan,
    plan_name: PLAN_CATALOG[entitlement.plan]?.name ?? entitlement.plan,
    status: entitlement.status,
    active: await isActive(auth.tenant_id),
    features: entitlement.features,
    limits: {
      max_devices: limits.maxDevices,
      max_events_per_day: limits.maxEventsPerDay,
      max_events_per_month: limits.maxEventsPerMonth,
    },
    trial_ends_at: entitlement.trial_ends_at?.toISOString() ?? null,
  });
});

// ─── GET /nexus/admin/billing/tenants ────────────────────────────────────────

router.get("/nexus/admin/billing/tenants", async (req, res) => {
  if (!requireAdmin(req as Parameters<typeof requireAdmin>[0], res as Parameters<typeof requireAdmin>[1])) return;

  const tenantIdFilter = typeof req.query["tenant_id"] === "string"
    ? req.query["tenant_id"]
    : undefined;

  const rows = await db
    .select({
      tenant_id: nexusTenants.tenant_id,
      name: nexusTenants.name,
      plan: nexusTenants.plan,
      status: nexusTenants.status,
      billing_email: nexusTenants.billing_email,
      trial_ends_at: nexusTenants.trial_ends_at,
      stripe_customer_id: nexusTenants.stripe_customer_id,
      stripe_subscription_id: nexusTenants.stripe_subscription_id,
      created_at: nexusTenants.created_at,
    })
    .from(nexusTenants)
    .then((all) =>
      tenantIdFilter ? all.filter((r) => r.tenant_id === tenantIdFilter) : all
    );

  const result = rows.map((r) => {
    const limits = getLimits(r.plan);
    return {
      ...r,
      plan_name: PLAN_CATALOG[r.plan]?.name ?? r.plan,
      limits,
      features: PLAN_CATALOG[r.plan]?.features,
    };
  });

  // Transform PLAN_CATALOG into the shape the admin panel expects
  const plans: Record<string, {
    name: string;
    tagline: string;
    monthlyPrice: number;
    yearlyPrice: number;
    features: typeof PLAN_CATALOG[string]["features"];
    limits: ReturnType<typeof getLimits>;
  }> = {};
  for (const [key, def] of Object.entries(PLAN_CATALOG)) {
    plans[key] = {
      name: def.name,
      tagline: def.tagline,
      monthlyPrice: Math.round(def.price_monthly_cents / 100),
      yearlyPrice: Math.round(def.price_yearly_cents / 100),
      features: def.features,
      limits: getLimits(key),
    };
  }
  res.json({ tenants: result, plans });
});

// ─── GET /nexus/admin/billing/:tenantId ──────────────────────────────────────

router.get("/nexus/admin/billing/:tenantId", async (req, res) => {
  if (!requireAdmin(req as Parameters<typeof requireAdmin>[0], res as Parameters<typeof requireAdmin>[1])) return;

  const { tenantId } = req.params;
  const entitlement = await getEntitlement(tenantId!);
  if (!entitlement) {
    res.status(404).json({ error: "Tenant not found" });
    return;
  }

  const limits = getLimits(entitlement.plan);

  res.json({
    tenant_id: tenantId,
    plan: entitlement.plan,
    plan_name: PLAN_CATALOG[entitlement.plan]?.name ?? entitlement.plan,
    status: entitlement.status,
    active: await isActive(tenantId!),
    features: entitlement.features,
    limits,
    trial_ends_at: entitlement.trial_ends_at?.toISOString() ?? null,
    stripe_customer_id: entitlement.stripe_customer_id,
    stripe_subscription_id: entitlement.stripe_subscription_id,
  });
});

// ─── POST /nexus/admin/billing/:tenantId/plan ─────────────────────────────────

const PlanChangeBody = z.object({
  plan: z.enum(["starter", "pro", "enterprise"]),
  actor: z.string().optional(),
});

router.post("/nexus/admin/billing/:tenantId/plan", async (req, res) => {
  if (!requireAdmin(req as Parameters<typeof requireAdmin>[0], res as Parameters<typeof requireAdmin>[1])) return;

  const parsed = PlanChangeBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid body", details: parsed.error.issues });
    return;
  }

  const { tenantId } = req.params;
  try {
    await upgradePlan(tenantId!, parsed.data.plan, parsed.data.actor ?? "admin");
    res.json({ ok: true, plan: parsed.data.plan });
  } catch (err: unknown) {
    res.status(400).json({ error: err instanceof Error ? err.message : "Failed" });
  }
});

// ─── POST /nexus/admin/billing/:tenantId/suspend ──────────────────────────────

router.post("/nexus/admin/billing/:tenantId/suspend", async (req, res) => {
  if (!requireAdmin(req as Parameters<typeof requireAdmin>[0], res as Parameters<typeof requireAdmin>[1])) return;

  const { tenantId } = req.params;
  const reason = typeof req.body?.reason === "string" ? req.body.reason : "Admin suspended";
  const actor = typeof req.body?.actor === "string" ? req.body.actor : "admin";

  await suspendTenant(tenantId!, reason, actor);
  res.json({ ok: true, status: "suspended" });
});

// ─── POST /nexus/admin/billing/:tenantId/activate ─────────────────────────────

router.post("/nexus/admin/billing/:tenantId/activate", async (req, res) => {
  if (!requireAdmin(req as Parameters<typeof requireAdmin>[0], res as Parameters<typeof requireAdmin>[1])) return;

  const { tenantId } = req.params;
  const actor = typeof req.body?.actor === "string" ? req.body.actor : "admin";

  await activateTenant(tenantId!, actor);
  res.json({ ok: true, status: "active" });
});

// ─── POST /nexus/admin/billing/:tenantId/cancel ───────────────────────────────

router.post("/nexus/admin/billing/:tenantId/cancel", async (req, res) => {
  if (!requireAdmin(req as Parameters<typeof requireAdmin>[0], res as Parameters<typeof requireAdmin>[1])) return;

  const { tenantId } = req.params;
  const reason = typeof req.body?.reason === "string" ? req.body.reason : "Admin canceled";
  const actor = typeof req.body?.actor === "string" ? req.body.actor : "admin";

  await cancelSubscription(tenantId!, reason, actor);
  res.json({ ok: true, status: "canceled" });
});

// ─── GET /nexus/admin/billing/:tenantId/history ───────────────────────────────

router.get("/nexus/admin/billing/:tenantId/history", async (req, res) => {
  if (!requireAdmin(req as Parameters<typeof requireAdmin>[0], res as Parameters<typeof requireAdmin>[1])) return;

  const { tenantId } = req.params;
  const limit = Math.min(parseInt(String(req.query["limit"] ?? "50"), 10), 200);

  const events = await db
    .select()
    .from(nexusBillingEvents)
    .where(eq(nexusBillingEvents.tenant_id, tenantId!))
    .orderBy(desc(nexusBillingEvents.created_at))
    .limit(limit);

  res.json({ events, total: events.length });
});

// ─── GET /nexus/admin/billing/:tenantId/usage ─────────────────────────────────
// Real-time usage metrics drawn from the event store + limits from plan.

router.get("/nexus/admin/billing/:tenantId/usage", async (req, res) => {
  if (!requireAdmin(req as Parameters<typeof requireAdmin>[0], res as Parameters<typeof requireAdmin>[1])) return;

  const { tenantId } = req.params;

  // ── Time boundaries ─────────────────────────────────────────────────────────
  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  const monthMs = startOfMonth.getTime();
  const todayMs = startOfToday.getTime();
  const thirtyDaysMs = thirtyDaysAgo.getTime();

  // ── Entitlement for limits ───────────────────────────────────────────────────
  const entitlement = await getEntitlement(tenantId!);

  // ── Aggregate queries (all run in parallel) ──────────────────────────────────
  const [
    ordersMonthRow,
    eventsMonthRow,
    eventsTodayRow,
    activeDevicesRow,
    paymentsMonthRow,
    printVolumeRow,
  ] = await Promise.all([
    // Orders this month
    db
      .select({ count: sql<number>`COUNT(*)::int` })
      .from(nexusEvents)
      .where(
        and(
          eq(nexusEvents.tenant_id, tenantId!),
          eq(nexusEvents.type, "ORDER_CREATED"),
          gte(nexusEvents.timestamp, monthMs)
        )
      )
      .then((r) => r[0]),

    // All events this month (vs monthly limit)
    db
      .select({ count: sql<number>`COUNT(*)::int` })
      .from(nexusEvents)
      .where(
        and(
          eq(nexusEvents.tenant_id, tenantId!),
          gte(nexusEvents.timestamp, monthMs)
        )
      )
      .then((r) => r[0]),

    // Events today (vs daily limit)
    db
      .select({ count: sql<number>`COUNT(*)::int` })
      .from(nexusEvents)
      .where(
        and(
          eq(nexusEvents.tenant_id, tenantId!),
          gte(nexusEvents.timestamp, todayMs)
        )
      )
      .then((r) => r[0]),

    // Active devices last 30 days
    db
      .select({ count: sql<number>`COUNT(DISTINCT device_id)::int` })
      .from(nexusEvents)
      .where(
        and(
          eq(nexusEvents.tenant_id, tenantId!),
          gte(nexusEvents.timestamp, thirtyDaysMs)
        )
      )
      .then((r) => r[0]),

    // Payments processed this month (ORDER_PAID)
    db
      .select({
        count: sql<number>`COUNT(*)::int`,
        total_cents: sql<number>`COALESCE(SUM((payload->>'total')::numeric * 100)::int, 0)`,
      })
      .from(nexusEvents)
      .where(
        and(
          eq(nexusEvents.tenant_id, tenantId!),
          eq(nexusEvents.type, "ORDER_PAID"),
          gte(nexusEvents.timestamp, monthMs)
        )
      )
      .then((r) => r[0]),

    // Print volume this month (RECEIPT_PRINTED or ORDER_PAID as proxy)
    db
      .select({ count: sql<number>`COUNT(*)::int` })
      .from(nexusEvents)
      .where(
        and(
          eq(nexusEvents.tenant_id, tenantId!),
          sql`${nexusEvents.type} IN ('RECEIPT_PRINTED', 'ORDER_PAID')`,
          gte(nexusEvents.timestamp, monthMs)
        )
      )
      .then((r) => r[0]),
  ]);

  // Registered devices (from devices table)
  const [registeredRow] = await db
    .select({ count: sql<number>`COUNT(*)::int` })
    .from(nexusDevices)
    .where(eq(nexusDevices.tenant_id, tenantId!));

  const limits = entitlement
    ? getLimits(entitlement.plan)
    : { maxDevices: 2, maxEventsPerDay: 1000, maxEventsPerMonth: 20000 };

  res.json({
    period: {
      month: startOfMonth.toISOString().slice(0, 7), // "2026-04"
      label: startOfMonth.toLocaleString("en-US", { month: "long", year: "numeric" }),
    },
    metrics: {
      orders_this_month: ordersMonthRow?.count ?? 0,
      active_devices_30d: activeDevicesRow?.count ?? 0,
      registered_devices: registeredRow?.count ?? 0,
      print_volume_this_month: printVolumeRow?.count ?? 0,
      payments_this_month: paymentsMonthRow?.count ?? 0,
      payments_total_cents: paymentsMonthRow?.total_cents ?? 0,
      events_today: eventsTodayRow?.count ?? 0,
      events_this_month: eventsMonthRow?.count ?? 0,
    },
    limits,
  });
});

// ─── GET /nexus/admin/billing/cache ───────────────────────────────────────────

router.get("/nexus/admin/billing/cache", async (req, res) => {
  if (!requireAdmin(req as Parameters<typeof requireAdmin>[0], res as Parameters<typeof requireAdmin>[1])) return;
  res.json({ cache: getCacheSnapshot() });
});

// ─── POST /nexus/admin/billing/:tenantId/record-payment ───────────────────────

const RecordPaymentBody = z.object({
  amount_cents: z.number().int().positive(),
  currency: z.string().default("usd"),
  stripe_payment_intent_id: z.string().optional(),
  actor: z.string().optional(),
});

router.post("/nexus/admin/billing/:tenantId/record-payment", async (req, res) => {
  if (!requireAdmin(req as Parameters<typeof requireAdmin>[0], res as Parameters<typeof requireAdmin>[1])) return;

  const parsed = RecordPaymentBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid body", details: parsed.error.issues });
    return;
  }

  const { tenantId } = req.params;
  await recordBillingEvent(
    tenantId!,
    "payment_received",
    {
      amount_cents: parsed.data.amount_cents,
      currency: parsed.data.currency,
      stripe_payment_intent_id: parsed.data.stripe_payment_intent_id,
    },
    parsed.data.actor ?? "admin"
  );

  res.json({ ok: true });
});

export default router;
