import { Router, type IRouter } from "express";
import { z } from "zod";
import { db } from "@workspace/db";
import { nexusEvents, nexusDevices, nexusTenants } from "@workspace/db/schema";
import { eq, and, desc, lte, gte, sql, lt, asc } from "drizzle-orm";
import crypto from "node:crypto";
import { getStatsCache, setStatsCache, getMenuPayload, setMenuCache, getCacheStatus } from "./tenant-cache.js";
import { getMetrics } from "./metrics.js";
import { getLimits, getTenantLimitSummary, getAllTenantUsage, PLAN_LIMITS } from "./tenant-limits.js";

const router: IRouter = Router();

function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function startOfWeek(date: Date): Date {
  const d = new Date(date);
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  d.setDate(diff);
  return startOfDay(d);
}

function startOfMonth(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

function daysAgo(n: number): Date {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return startOfDay(d);
}

function isoDate(date: Date): string {
  return date.toISOString().split("T")[0]!;
}

type OrderPayload = {
  orderId?: string;
  tableNumber?: string;
  items?: Array<{ id?: string; name: string; price: number; emoji?: string; quantity: number }>;
  total?: number;
  status?: string;
};

type ReconstructedOrder = {
  order_id: string;
  status: "open" | "paid" | "canceled";
  items: Array<{ name: string; quantity: number; price: number; emoji?: string }>;
  total: number;
  tip: number;
  revenue_total: number;
  payment_method: string | null;
  table: string | null;
  device_id: string;
  created_at: number;
  paid_at: number | null;
  canceled_at: number | null;
  refunded: boolean;
  refund_amount: number | null;
};

function reconstructOrders(
  rows: Array<{ event_id: string; type: string; timestamp: number; device_id: string; tenant_id: string; payload: unknown }>
): Map<string, ReconstructedOrder> {
  const orders = new Map<string, ReconstructedOrder>();
  const paidOrders = new Set<string>(); // FASE 10: payment immutability guard

  const sorted = [...rows].sort((a, b) => a.timestamp - b.timestamp);

  for (const row of sorted) {
    const payload = (typeof row.payload === "object" ? row.payload : {}) as OrderPayload;
    switch (row.type) {
      case "ORDER_CREATED": {
        const orderId = payload.orderId;
        if (!orderId) break;
        orders.set(orderId, {
          order_id: orderId,
          status: "open",
          items: (payload.items ?? []).map((i) => ({
            name: i.name,
            quantity: i.quantity,
            price: i.price,
            emoji: i.emoji,
          })),
          total: payload.total ?? 0,
          tip: 0,
          revenue_total: payload.total ?? 0,
          payment_method: null,
          table: payload.tableNumber ?? null,
          device_id: row.device_id,
          created_at: row.timestamp,
          paid_at: null,
          canceled_at: null,
          refunded: false,
          refund_amount: null,
        });
        break;
      }
      case "PAYMENT_SUCCESS": {
        const id = (payload as Record<string, unknown>).orderId as string | undefined;
        if (!id) break;
        // FASE 10 CONFLICT RULE: Payments are IMMUTABLE — once confirmed, cannot be overwritten
        if (paidOrders.has(id)) break;
        paidOrders.add(id);
        const existing = orders.get(id);
        if (!existing) break;
        const pTip = ((payload as Record<string, unknown>).tip as number) ?? 0;
        const pTotal = ((payload as Record<string, unknown>).total as number) ?? existing.total;
        const pMethod = ((payload as Record<string, unknown>).method as string) ?? null;
        orders.set(id, {
          ...existing,
          tip: pTip,
          revenue_total: pTotal,
          payment_method: pMethod,
          paid_at: row.timestamp,
        });
        break;
      }
      case "REFUND_CREATED": {
        const id = (payload as Record<string, unknown>).orderId as string | undefined;
        if (!id) break;
        const existing = orders.get(id);
        if (!existing) break;
        const refundAmt = ((payload as Record<string, unknown>).amount as number) ?? existing.revenue_total;
        orders.set(id, { ...existing, refunded: true, refund_amount: refundAmt });
        break;
      }
      case "ORDER_STATUS_CHANGED": {
        const id = payload.orderId;
        if (!id) break;
        const existing = orders.get(id);
        if (!existing) break;
        const newStatus = payload.status as string;
        if (newStatus === "paid") {
          orders.set(id, { ...existing, status: "paid", paid_at: row.timestamp });
        } else if (newStatus === "canceled") {
          orders.set(id, { ...existing, status: "canceled", canceled_at: row.timestamp });
        } else {
          orders.set(id, { ...existing, status: "open" });
        }
        break;
      }
      case "ORDER_UPDATED": {
        const id = payload.orderId;
        if (!id) break;
        const existing = orders.get(id);
        if (existing && payload.status) {
          const s = payload.status as string;
          if (s === "paid") orders.set(id, { ...existing, status: "paid", paid_at: row.timestamp });
          else if (s === "canceled") orders.set(id, { ...existing, status: "canceled", canceled_at: row.timestamp });
          else orders.set(id, { ...existing, status: "open" });
        }
        break;
      }
      case "ORDER_PAID": {
        const id = payload.orderId;
        if (!id) break;
        const existing = orders.get(id);
        if (existing) orders.set(id, { ...existing, status: "paid", paid_at: row.timestamp });
        break;
      }
      case "ORDER_CANCELED": {
        const id = payload.orderId;
        if (!id) break;
        const existing = orders.get(id);
        if (existing) orders.set(id, { ...existing, status: "canceled", canceled_at: row.timestamp });
        break;
      }
    }
  }

  return orders;
}

router.get("/nexus/admin/stats", async (req, res) => {
  const tenantId = req.query["tenant_id"];
  if (typeof tenantId !== "string" || !tenantId) {
    res.status(400).json({ error: "tenant_id is required" });
    return;
  }

  // ── Serve from cache if available (TTL = 2 min) ────────────────────────────
  const cached = getStatsCache(tenantId);
  if (cached) {
    res.setHeader("X-Cache", "HIT");
    res.json(cached);
    return;
  }

  const now = new Date();
  const todayStart = startOfDay(now).getTime();
  const weekStart = startOfWeek(now).getTime();
  const monthStart = startOfMonth(now).getTime();
  const thirtyDaysAgo = daysAgo(30).getTime();

  const [allEvents, deviceRows] = await Promise.all([
    db
      .select()
      .from(nexusEvents)
      .where(and(eq(nexusEvents.tenant_id, tenantId), gte(nexusEvents.timestamp, thirtyDaysAgo)))
      .orderBy(nexusEvents.timestamp),
    db.select({ count: sql<number>`count(*)` }).from(nexusDevices).where(eq(nexusDevices.tenant_id, tenantId)),
  ]);

  const orders = reconstructOrders(allEvents);
  const orderList = Array.from(orders.values());

  function calcPeriod(start: number) {
    const paid = orderList.filter((o) => o.status === "paid" && o.paid_at !== null && o.paid_at >= start);
    const revenue = paid.reduce((sum, o) => sum + o.revenue_total, 0);
    const tips = paid.reduce((sum, o) => sum + o.tip, 0);
    return { revenue, tips: Math.round(tips * 100) / 100, order_count: paid.length };
  }

  const today = calcPeriod(todayStart);
  const this_week = calcPeriod(weekStart);
  const this_month = calcPeriod(monthStart);

  const revenueByDay = new Map<string, { revenue: number; order_count: number }>();
  for (let i = 0; i <= 30; i++) {
    const d = daysAgo(30 - i);
    revenueByDay.set(isoDate(d), { revenue: 0, order_count: 0 });
  }
  for (const order of orderList) {
    if (order.status === "paid" && order.paid_at !== null) {
      const key = isoDate(new Date(order.paid_at));
      const entry = revenueByDay.get(key);
      if (entry) {
        entry.revenue += order.revenue_total;
        entry.order_count += 1;
      }
    }
  }
  const revenue_series = Array.from(revenueByDay.entries()).map(([date, v]) => ({
    date,
    revenue: Math.round(v.revenue * 100) / 100,
    order_count: v.order_count,
  }));

  const itemCounts = new Map<string, { count: number; revenue: number }>();
  for (const order of orderList) {
    if (order.status === "paid") {
      for (const item of order.items) {
        const existing = itemCounts.get(item.name) ?? { count: 0, revenue: 0 };
        existing.count += item.quantity;
        existing.revenue += item.price * item.quantity;
        itemCounts.set(item.name, existing);
      }
    }
  }
  const top_items = Array.from(itemCounts.entries())
    .map(([name, v]) => ({ name, count: v.count, revenue: Math.round(v.revenue * 100) / 100 }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);

  const active_orders = orderList.filter((o) => o.status === "open").length;
  const total_devices = Number(deviceRows[0]?.count ?? 0);

  const statsPayload = { today, this_week, this_month, revenue_series, top_items, total_devices, active_orders };

  // ── Write to stats cache (TTL = 2 min) ────────────────────────────────────
  setStatsCache(tenantId, statsPayload as Record<string, unknown>);
  res.setHeader("X-Cache", "MISS");
  res.json(statsPayload);
});

// ─── Metrics (BLOQUE 3) ───────────────────────────────────────────────────────

router.get("/nexus/admin/metrics", async (req, res) => {
  const tenantId = req.query["tenant_id"];
  if (typeof tenantId !== "string" || !tenantId) {
    res.status(400).json({ error: "tenant_id is required" });
    return;
  }

  const metrics = getMetrics(tenantId);

  // Enrich device entries with names from DB
  const deviceIds = metrics.devices.map((d) => d.deviceId);
  const dbDevices = deviceIds.length > 0
    ? await db
        .select({ device_id: nexusDevices.device_id, name: nexusDevices.name, last_seen_at: nexusDevices.last_seen_at })
        .from(nexusDevices)
        .where(
          and(
            eq(nexusDevices.tenant_id, tenantId),
          )
        )
    : [];

  const nameMap = new Map(dbDevices.map((d) => [d.device_id, d.name]));

  // Merge DB devices not yet seen in metrics (online in DB means registered but not pushed yet)
  const seenIds = new Set(metrics.devices.map((d) => d.deviceId));
  const dbOnlyDevices = dbDevices
    .filter((d) => !seenIds.has(d.device_id))
    .map((d) => {
      const lastMs = d.last_seen_at ? d.last_seen_at.getTime() : 0;
      const age = Date.now() - lastMs;
      return {
        deviceId: d.device_id,
        tenantId,
        lastSyncAt: lastMs,
        eventsToday: 0,
        consecutiveErrors: 0,
        status: (age < 30_000 ? "online" : age < 120_000 ? "degraded" : "offline") as "online" | "degraded" | "offline",
        name: d.name,
      };
    });

  const enrichedDevices = [
    ...metrics.devices.map((d) => ({ ...d, name: nameMap.get(d.deviceId) ?? d.deviceId })),
    ...dbOnlyDevices,
  ];

  res.json({
    ...metrics,
    devices: enrichedDevices,
    system: {
      ...metrics.system,
      queue_depth: 0,
    },
  });
});

router.get("/nexus/admin/devices", async (req, res) => {
  const tenantId = req.query["tenant_id"];
  if (typeof tenantId !== "string" || !tenantId) {
    res.status(400).json({ error: "tenant_id is required" });
    return;
  }

  const rows = await db
    .select()
    .from(nexusDevices)
    .where(eq(nexusDevices.tenant_id, tenantId))
    .orderBy(desc(nexusDevices.registered_at));

  const devices = rows.map((d) => ({
    device_id: d.device_id,
    name: d.name,
    tenant_id: d.tenant_id,
    registered_at: d.registered_at.toISOString(),
    last_seen_at: d.last_seen_at?.toISOString() ?? null,
    active: d.active,
  }));

  res.json({ devices, total: devices.length });
});

router.get("/nexus/admin/orders", async (req, res) => {
  const tenantId = req.query["tenant_id"];
  if (typeof tenantId !== "string" || !tenantId) {
    res.status(400).json({ error: "tenant_id is required" });
    return;
  }

  const statusFilter = req.query["status"];
  const limitParam = req.query["limit"];
  const offsetParam = req.query["offset"];

  const limitNum = Math.min(typeof limitParam === "string" ? parseInt(limitParam, 10) || 50 : 50, 200);
  const offsetNum = typeof offsetParam === "string" ? parseInt(offsetParam, 10) || 0 : 0;

  const rows = await db
    .select()
    .from(nexusEvents)
    .where(and(eq(nexusEvents.tenant_id, tenantId)))
    .orderBy(nexusEvents.timestamp);

  const orders = reconstructOrders(rows);
  let orderList = Array.from(orders.values()).sort((a, b) => b.created_at - a.created_at);

  if (typeof statusFilter === "string" && ["open", "paid", "canceled"].includes(statusFilter)) {
    orderList = orderList.filter((o) => o.status === statusFilter);
  }

  const total = orderList.length;
  const paginated = orderList.slice(offsetNum, offsetNum + limitNum);

  res.json({ orders: paginated, total });
});

router.get("/nexus/admin/menu", async (req, res) => {
  const tenantId = req.query["tenant_id"];
  if (typeof tenantId !== "string" || !tenantId) {
    res.status(400).json({ error: "tenant_id is required" });
    return;
  }

  const [latest] = await db
    .select()
    .from(nexusEvents)
    .where(and(eq(nexusEvents.tenant_id, tenantId), eq(nexusEvents.type, "MENU_UPDATED")))
    .orderBy(desc(nexusEvents.timestamp))
    .limit(1);

  if (!latest) {
    res.json({ items: [], last_updated: null });
    return;
  }

  const payload = (typeof latest.payload === "object" ? latest.payload : {}) as { items?: unknown[] };
  res.json({ items: payload.items ?? [], last_updated: latest.timestamp });
});

router.post("/nexus/admin/menu", async (req, res) => {
  const UpdateMenuSchema = z.object({
    tenant_id: z.string().min(1),
    device_id: z.string().min(1),
    items: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        price: z.number(),
        category: z.string(),
        emoji: z.string().optional(),
        available: z.boolean().optional(),
      })
    ),
  });

  const parsed = UpdateMenuSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: "Validation failed",
      details: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
    });
    return;
  }

  const { tenant_id, device_id, items } = parsed.data;
  const event_id = crypto.randomBytes(16).toString("hex");
  const timestamp = Date.now();

  await db.insert(nexusEvents).values({
    event_id,
    type: "MENU_UPDATED",
    timestamp,
    device_id,
    tenant_id,
    payload: { items },
  });

  res.json({ event_id, updated_at: timestamp });
});

router.get("/nexus/admin/activity", async (req, res) => {
  const tenantId = req.query["tenant_id"];
  if (typeof tenantId !== "string" || !tenantId) {
    res.status(400).json({ error: "tenant_id is required" });
    return;
  }

  const limitParam = req.query["limit"];
  const limitNum = Math.min(typeof limitParam === "string" ? parseInt(limitParam, 10) || 20 : 20, 100);

  const rows = await db
    .select()
    .from(nexusEvents)
    .where(eq(nexusEvents.tenant_id, tenantId))
    .orderBy(desc(nexusEvents.timestamp))
    .limit(limitNum);

  const events = rows.map((r) => ({
    event_id: r.event_id,
    type: r.type,
    timestamp: r.timestamp,
    device_id: r.device_id,
    payload: r.payload,
  }));

  res.json({ events });
});

// ─── FASE 10: Full Audit Log ──────────────────────────────────────────────────
// Returns complete event log with device names for traceability

router.get("/nexus/admin/audit", async (req, res) => {
  const tenantId = req.query["tenant_id"];
  if (typeof tenantId !== "string" || !tenantId) {
    res.status(400).json({ error: "tenant_id is required" });
    return;
  }

  const limitParam = req.query["limit"];
  const offsetParam = req.query["offset"];
  const typeFilter = req.query["type"];
  const deviceFilter = req.query["device_id"];
  const sinceParam = req.query["since"];
  const untilParam = req.query["until"];

  const limitNum = Math.min(typeof limitParam === "string" ? parseInt(limitParam, 10) || 100 : 100, 500);
  const offsetNum = typeof offsetParam === "string" ? parseInt(offsetParam, 10) || 0 : 0;

  const conditions = [eq(nexusEvents.tenant_id, tenantId)];

  if (typeof typeFilter === "string" && typeFilter) {
    conditions.push(eq(nexusEvents.type, typeFilter));
  }
  if (typeof deviceFilter === "string" && deviceFilter) {
    conditions.push(eq(nexusEvents.device_id, deviceFilter));
  }
  if (typeof sinceParam === "string" && sinceParam) {
    const ms = parseFloat(sinceParam);
    if (!isNaN(ms)) conditions.push(gte(nexusEvents.timestamp, ms));
  }
  if (typeof untilParam === "string" && untilParam) {
    const ms = parseFloat(untilParam);
    if (!isNaN(ms)) conditions.push(lte(nexusEvents.timestamp, ms));
  }

  // Fetch events + device names in parallel
  const [events, devices] = await Promise.all([
    db
      .select()
      .from(nexusEvents)
      .where(and(...conditions))
      .orderBy(desc(nexusEvents.timestamp))
      .limit(limitNum)
      .offset(offsetNum),
    db
      .select({ device_id: nexusDevices.device_id, name: nexusDevices.name })
      .from(nexusDevices)
      .where(eq(nexusDevices.tenant_id, tenantId)),
  ]);

  // Count for pagination
  const [countRow] = await db
    .select({ count: sql<number>`count(*)` })
    .from(nexusEvents)
    .where(and(...conditions));

  const deviceNames = new Map(devices.map((d) => [d.device_id, d.name]));

  const audit = events.map((e) => {
    const p = (typeof e.payload === "object" && e.payload !== null ? e.payload : {}) as Record<string, unknown>;
    return {
      event_id: e.event_id,
      type: e.type,
      timestamp: e.timestamp,
      device_id: e.device_id,
      device_name: deviceNames.get(e.device_id) ?? e.device_id,
      // Extracted summary fields for quick display
      order_id: (p.orderId as string | undefined) ?? null,
      table: (p.tableNumber as string | undefined) ?? null,
      amount: (p.total as number | undefined) ?? (p.amount as number | undefined) ?? null,
      status: (p.status as string | undefined) ?? null,
      method: (p.method as string | undefined) ?? null,
      item_name: (p.item_name as string | undefined) ?? null,
      payload: p,
    };
  });

  res.json({
    events: audit,
    total: Number(countRow?.count ?? 0),
    limit: limitNum,
    offset: offsetNum,
  });
});

// ─── GET /nexus/admin/tenant-plan — plan, limits, and real-time usage ─────────
//
// Returns the current plan tier, its limits, and today's in-memory usage for
// the specified tenant.  Designed for the admin observability panel.

router.get("/nexus/admin/tenant-plan", async (req, res) => {
  const tenantId = req.query["tenant_id"];
  if (!tenantId || typeof tenantId !== "string") {
    res.status(400).json({ error: "tenant_id is required" });
    return;
  }

  const [tenant] = await db
    .select({ tenant_id: nexusTenants.tenant_id, name: nexusTenants.name, plan: nexusTenants.plan, created_at: nexusTenants.created_at })
    .from(nexusTenants)
    .where(eq(nexusTenants.tenant_id, tenantId))
    .limit(1);

  if (!tenant) {
    res.status(404).json({ error: "Tenant not found" });
    return;
  }

  const [deviceCountRow] = await db
    .select({ count: sql<number>`count(*)` })
    .from(nexusDevices)
    .where(eq(nexusDevices.tenant_id, tenantId));
  const deviceCount = Number(deviceCountRow?.count ?? 0);

  const summary = getTenantLimitSummary(tenantId, tenant.plan);
  const limits = getLimits(tenant.plan);

  res.json({
    tenant_id: tenant.tenant_id,
    name: tenant.name,
    plan: tenant.plan,
    limits: {
      max_devices: limits.maxDevices,
      max_events_per_day: limits.maxEventsPerDay,
      max_events_per_month: limits.maxEventsPerMonth,
    },
    usage: {
      devices: deviceCount,
      events_today: summary.usage.eventsToday,
    },
    remaining: {
      devices: Math.max(0, limits.maxDevices - deviceCount),
      events_today: summary.remaining.eventsPerDay,
    },
    all_plans: Object.fromEntries(
      Object.entries(PLAN_LIMITS).map(([plan, l]) => [
        plan,
        { max_devices: l.maxDevices, max_events_per_day: l.maxEventsPerDay },
      ])
    ),
  });
});

// ─── GET /nexus/admin/all-tenants-usage — cross-tenant usage snapshot ─────────
//
// Returns the in-memory daily event usage for all active tenants.
// Useful for SaaS-level billing dashboards and quota enforcement monitoring.

router.get("/nexus/admin/all-tenants-usage", async (_req, res) => {
  const usage = getAllTenantUsage();
  const tenants = await db
    .select({ tenant_id: nexusTenants.tenant_id, name: nexusTenants.name, plan: nexusTenants.plan })
    .from(nexusTenants);

  const tenantMap = new Map(tenants.map((t) => [t.tenant_id, t]));

  const result = usage.map((u) => {
    const t = tenantMap.get(u.tenantId);
    const limits = getLimits(u.plan);
    return {
      tenant_id: u.tenantId,
      name: t?.name ?? u.tenantId,
      plan: u.plan,
      events_today: u.eventsToday,
      daily_limit: limits.maxEventsPerDay,
      utilization_pct: limits.maxEventsPerDay > 0
        ? Math.round((u.eventsToday / limits.maxEventsPerDay) * 100)
        : 0,
    };
  });

  res.json({ tenants: result, snapshot_at: new Date().toISOString() });
});

export default router;
