// ─── Tenant Cache ─────────────────────────────────────────────────────────────
//
// In-memory read-through cache for per-tenant data.
//
// Rule: cache NEVER replaces events — only accelerates reads.
// Invalidation is event-driven: every POST /sync/events triggers invalidation
// for the affected tenant.
//
// Cache entries:
//  - ordersSnapshot  : reconstructed active orders Map (invalidated on any event push)
//  - menuPayload     : latest MENU_UPDATED event payload (invalidated on MENU_UPDATED)
//  - statsSnapshot   : aggregated revenue/order stats (TTL = 2min)
//
// There is NO TTL for ordersSnapshot or menuPayload — they are exact reflections
// of the event log state at a given moment and are invalidated immediately on change.

import { db } from "@workspace/db";
import { nexusEvents, nexusTenants } from "@workspace/db/schema";
import { eq, desc } from "drizzle-orm";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface CachedOrderItem {
  id: string;
  name: string;
  price: number;
  emoji?: string;
  quantity: number;
}

export interface CachedOrder {
  id: string;
  tableNumber: string;
  items: CachedOrderItem[];
  status: string;
  total: number;
  createdAt: number;
  deviceId: string;
  payment?: {
    paymentId: string;
    method: string;
    subtotal: number;
    tip: number;
    total: number;
    cashTendered?: number;
    change?: number;
    paidAt: number;
  };
  refund?: {
    refundId: string;
    amount: number;
    reason: string;
    refundedAt: number;
  };
}

interface OrdersEntry {
  orders: Map<string, CachedOrder>;
  paidOrderIds: Set<string>;
  builtAt: number;
}

interface MenuEntry {
  payload: Record<string, unknown>;
  version: number;
  cachedAt: number;
}

interface StatsEntry {
  stats: Record<string, unknown>;
  cachedAt: number;
}

// ─── Cache stores ─────────────────────────────────────────────────────────────

const ordersCache = new Map<string, OrdersEntry>();
const menuCache   = new Map<string, MenuEntry>();
const statsCache  = new Map<string, StatsEntry>();

const STATS_TTL_MS = 2 * 60_000; // 2 minutes

// ─── Order reconstruction (mirrors PosContext.buildOrdersFromEvents) ──────────

function normalizeStatus(s: string): string {
  if (s === "pending")     return "sent_to_kitchen";
  if (s === "in_progress") return "in_preparation";
  return s;
}

function buildOrdersFromEvents(
  rows: Array<{ type: string; timestamp: number; device_id: string; payload: unknown }>
): { orders: Map<string, CachedOrder>; paidOrderIds: Set<string> } {
  const orders = new Map<string, CachedOrder>();
  const paidOrderIds = new Set<string>(); // immutable payments guard

  for (const row of rows) {
    const payload = (typeof row.payload === "string"
      ? JSON.parse(row.payload)
      : row.payload) as Record<string, unknown>;

    switch (row.type) {
      case "ORDER_CREATED": {
        const orderId = payload["orderId"] as string;
        const rawItems = (payload["items"] as CachedOrderItem[] | undefined) ?? [];
        orders.set(orderId, {
          id: orderId,
          tableNumber: (payload["tableNumber"] as string) || "—",
          items: rawItems.map((i) => ({
            id: i.id,
            name: i.name,
            price: i.price,
            emoji: i.emoji,
            quantity: i.quantity,
          })),
          status: "created",
          total: payload["total"] as number,
          createdAt: row.timestamp,
          deviceId: row.device_id,
        });
        break;
      }

      case "ORDER_STATUS_CHANGED":
      case "ORDER_UPDATED": {
        const id = payload["orderId"] as string;
        const existing = orders.get(id);
        if (existing) {
          orders.set(id, { ...existing, status: normalizeStatus(payload["status"] as string) });
        }
        break;
      }

      case "ORDER_PAID": {
        const id = payload["orderId"] as string;
        const existing = orders.get(id);
        if (existing) orders.set(id, { ...existing, status: "paid" });
        break;
      }

      case "ORDER_CANCELED": {
        const id = payload["orderId"] as string;
        const existing = orders.get(id);
        if (existing) orders.set(id, { ...existing, status: "canceled" });
        break;
      }

      case "PAYMENT_SUCCESS": {
        const id = payload["orderId"] as string;
        if (paidOrderIds.has(id)) break; // immutable — first payment wins
        paidOrderIds.add(id);
        const existing = orders.get(id);
        if (existing) {
          orders.set(id, {
            ...existing,
            payment: {
              paymentId: payload["paymentId"] as string,
              method: payload["method"] as string,
              subtotal: payload["subtotal"] as number,
              tip: payload["tip"] as number,
              total: payload["total"] as number,
              cashTendered: payload["cashTendered"] as number | undefined,
              change: payload["change"] as number | undefined,
              paidAt: row.timestamp,
            },
          });
        }
        break;
      }

      case "REFUND_CREATED": {
        const id = payload["orderId"] as string;
        const existing = orders.get(id);
        if (existing) {
          orders.set(id, {
            ...existing,
            refund: {
              refundId: payload["refundId"] as string,
              amount: payload["amount"] as number,
              reason: payload["reason"] as string,
              refundedAt: row.timestamp,
            },
          });
        }
        break;
      }
    }
  }

  return { orders, paidOrderIds };
}

// ─── Orders cache ─────────────────────────────────────────────────────────────

export async function getOrdersSnapshot(tenantId: string): Promise<Map<string, CachedOrder>> {
  const cached = ordersCache.get(tenantId);
  if (cached) return cached.orders;
  return rebuildOrdersSnapshot(tenantId);
}

// ── BLOQUE 7: Full snapshot — orders + paidOrderIds for full-resync endpoint ──
export async function getOrdersAndPaidIds(tenantId: string): Promise<{
  orders: Map<string, CachedOrder>;
  paidOrderIds: Set<string>;
}> {
  const cached = ordersCache.get(tenantId);
  if (cached) return { orders: cached.orders, paidOrderIds: cached.paidOrderIds };
  await rebuildOrdersSnapshot(tenantId);
  const entry = ordersCache.get(tenantId)!;
  return { orders: entry.orders, paidOrderIds: entry.paidOrderIds };
}

export async function rebuildOrdersSnapshot(tenantId: string): Promise<Map<string, CachedOrder>> {
  const rows = await db
    .select()
    .from(nexusEvents)
    .where(eq(nexusEvents.tenant_id, tenantId))
    .orderBy(nexusEvents.timestamp);

  const { orders, paidOrderIds } = buildOrdersFromEvents(rows);
  ordersCache.set(tenantId, { orders, paidOrderIds, builtAt: Date.now() });
  return orders;
}

// Apply a single new event to the existing cached snapshot (incremental update)
// Called by event-queue.ts after each batch commits to DB
export function applyEventToSnapshot(tenantId: string, event: {
  type: string;
  timestamp: number;
  device_id: string;
  payload: Record<string, unknown>;
}): void {
  const cached = ordersCache.get(tenantId);
  if (!cached) return; // not yet built — will be built on next read

  const { orders, paidOrderIds } = buildOrdersFromEvents([{
    type: event.type,
    timestamp: event.timestamp,
    device_id: event.device_id,
    payload: event.payload,
  }]);

  // Merge delta into existing snapshot
  for (const [id, order] of orders.entries()) {
    cached.orders.set(id, order);
  }
  // Track paid orders
  for (const id of paidOrderIds) {
    cached.paidOrderIds.add(id);
  }
  cached.builtAt = Date.now();
}

// Invalidate entire orders snapshot (forces rebuild on next read)
export function invalidateOrdersCache(tenantId: string): void {
  ordersCache.delete(tenantId);
}

export function getOrdersCacheInfo(tenantId: string): { cached: boolean; builtAt?: number; orderCount?: number } {
  const entry = ordersCache.get(tenantId);
  return entry
    ? { cached: true, builtAt: entry.builtAt, orderCount: entry.orders.size }
    : { cached: false };
}

// ─── Menu cache ───────────────────────────────────────────────────────────────

export async function getMenuPayload(tenantId: string): Promise<Record<string, unknown> | null> {
  const cached = menuCache.get(tenantId);
  if (cached) return cached.payload;
  return fetchAndCacheMenu(tenantId);
}

async function fetchAndCacheMenu(tenantId: string): Promise<Record<string, unknown> | null> {
  const [row] = await db
    .select()
    .from(nexusEvents)
    .where(eq(nexusEvents.tenant_id, tenantId))
    .orderBy(desc(nexusEvents.timestamp))
    .limit(1);

  if (!row) return null;

  // Find latest MENU_UPDATED event
  const menuRows = await db
    .select()
    .from(nexusEvents)
    .where(eq(nexusEvents.tenant_id, tenantId));

  const menuEvents = menuRows
    .filter((r) => r.type === "MENU_UPDATED")
    .sort((a, b) => b.timestamp - a.timestamp);

  if (menuEvents.length === 0) return null;

  const latest = menuEvents[0]!;
  const payload = typeof latest.payload === "string"
    ? JSON.parse(latest.payload)
    : latest.payload as Record<string, unknown>;

  const version = (payload["version"] as number | undefined) ?? latest.timestamp;
  menuCache.set(tenantId, { payload, version, cachedAt: Date.now() });
  return payload;
}

export function setMenuCache(tenantId: string, payload: Record<string, unknown>, version: number): void {
  const existing = menuCache.get(tenantId);
  if (existing && version <= existing.version) return; // don't downgrade
  menuCache.set(tenantId, { payload, version, cachedAt: Date.now() });
}

export function invalidateMenuCache(tenantId: string): void {
  menuCache.delete(tenantId);
}

// ─── Stats cache ──────────────────────────────────────────────────────────────

export function getStatsCache(tenantId: string): Record<string, unknown> | null {
  const entry = statsCache.get(tenantId);
  if (!entry) return null;
  if (Date.now() - entry.cachedAt > STATS_TTL_MS) {
    statsCache.delete(tenantId);
    return null;
  }
  return entry.stats;
}

export function setStatsCache(tenantId: string, stats: Record<string, unknown>): void {
  statsCache.set(tenantId, { stats, cachedAt: Date.now() });
}

export function invalidateStatsCache(tenantId: string): void {
  statsCache.delete(tenantId);
}

// ─── Full cache status (for /health endpoint) ─────────────────────────────────

export function getCacheStatus(): {
  ordersEntries: number;
  menuEntries: number;
  statsEntries: number;
  tenants: string[];
} {
  const tenants = new Set([
    ...ordersCache.keys(),
    ...menuCache.keys(),
    ...statsCache.keys(),
  ]);
  return {
    ordersEntries: ordersCache.size,
    menuEntries: menuCache.size,
    statsEntries: statsCache.size,
    tenants: [...tenants],
  };
}

// ─── Cleanup stale stats every 5 minutes ─────────────────────────────────────
setInterval(() => {
  const now = Date.now();
  for (const [id, entry] of statsCache.entries()) {
    if (now - entry.cachedAt > STATS_TTL_MS * 2) statsCache.delete(id);
  }
}, 5 * 60_000).unref();

// ─── Tenant plan cache (1h TTL) ───────────────────────────────────────────────
// Avoids a DB hit on every sync/push just to get the tenant plan.
// Rule: invalidated when tenant plan is updated via admin (manual call or future webhook).

const PLAN_TTL_MS = 60 * 60_000; // 1 hour

interface CachedPlan {
  plan: string;
  cachedAt: number;
}

const planCache = new Map<string, CachedPlan>();

export function getCachedTenantPlan(tenantId: string): string | null {
  const entry = planCache.get(tenantId);
  if (!entry || Date.now() - entry.cachedAt > PLAN_TTL_MS) return null;
  return entry.plan;
}

export function setCachedTenantPlan(tenantId: string, plan: string): void {
  planCache.set(tenantId, { plan, cachedAt: Date.now() });
}

export function invalidateTenantPlanCache(tenantId: string): void {
  planCache.delete(tenantId);
}

/** Resolve tenant plan: cache first, then DB. Returns 'starter' as safe default. */
export async function resolveTenantPlan(tenantId: string): Promise<string> {
  const cached = getCachedTenantPlan(tenantId);
  if (cached) return cached;

  const [row] = await db
    .select({ plan: nexusTenants.plan })
    .from(nexusTenants)
    .where(eq(nexusTenants.tenant_id, tenantId))
    .limit(1);

  const plan = row?.plan ?? "starter";
  setCachedTenantPlan(tenantId, plan);
  return plan;
}

// Cleanup stale plan cache every hour
setInterval(() => {
  const now = Date.now();
  for (const [id, entry] of planCache.entries()) {
    if (now - entry.cachedAt > PLAN_TTL_MS * 2) planCache.delete(id);
  }
}, 60 * 60_000).unref();
