import { Router, type IRouter } from "express";
import { z } from "zod";
import { db } from "@workspace/db";
import { nexusEvents, nexusDevices } from "@workspace/db/schema";
import { eq, gt, and, desc, sql, asc } from "drizzle-orm";
import { filterDuplicates, releaseInflight } from "./dedup.js";
import { checkRateLimit, checkTenantRateLimit } from "./rate-limiter.js";
import { enqueueEvents, getQueueDepth, getQueueStats } from "./event-queue.js";
import { getCacheStatus, resolveTenantPlan, getOrdersAndPaidIds, getMenuPayload } from "./tenant-cache.js";
import { checkTenantEventLimit, recordTenantEvents } from "./tenant-limits.js";
import { isActive as isTenantActive } from "./billing-engine.js";
import { validateEventBatch } from "./event-validator.js";
import { syncTimeout, adminTimeout } from "./timeout-middleware.js";
import {
  recordEvents,
  recordLatency,
  recordDeviceActivity,
  incrementError,
} from "./metrics.js";
import crypto from "node:crypto";

const router: IRouter = Router();

// ─── All known event types — FASE 0-9 ────────────────────────────────────────

const NexusEventTypeSchema = z.enum([
  "ORDER_CREATED",
  "ORDER_UPDATED",
  "ORDER_PAID",
  "ORDER_CANCELED",
  "CONFIG_UPDATED",
  "MENU_UPDATED",
  "DEVICE_REGISTERED",
  "SYNC_REQUESTED",
  // FASE 8
  "ORDER_STATUS_CHANGED",
  "ITEM_SOLD",
  "STOCK_UPDATED",
  // FASE 9
  "PAYMENT_INITIATED",
  "PAYMENT_SUCCESS",
  "PAYMENT_FAILED",
  "REFUND_CREATED",
  // BLOQUE 7
  "FULL_RESYNC",
  // FASE 12 — subscription lifecycle events
  "SUBSCRIPTION_CREATED",
  "SUBSCRIPTION_RENEWED",
  "SUBSCRIPTION_FAILED",
  "SUBSCRIPTION_SUSPENDED",
]);

const NexusEventSchema = z.object({
  event_id: z.string().min(1),
  type: NexusEventTypeSchema,
  timestamp: z.number().int().positive(),
  device_id: z.string().min(1),
  tenant_id: z.string().min(1),
  payload: z.record(z.unknown()).default({}),
});

const SyncEventsBodySchema = z.object({
  events: z.array(NexusEventSchema).min(1).max(500),
});

const RegisterDeviceBodySchema = z.object({
  device_id: z.string().min(1),
  tenant_id: z.string().min(1),
  name: z.string().min(1),
});

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

// ─── PUSH: device → server (with rate limiting + event queue) ─────────────────

router.post("/nexus/sync/events", syncTimeout, async (req, res) => {
  const syncStart = Date.now();
  const auth = await resolveDevice(req.headers["authorization"]);
  if (!auth) {
    res.status(401).json({ error: "Device not registered or invalid token" });
    return;
  }

  const parsed = SyncEventsBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: "Validation failed",
      details: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
    });
    return;
  }

  const { events } = parsed.data;

  // ── Strict per-event validation (BLOQUE 6) ────────────────────────────────
  // Runs BEFORE rate limiting — malformed events rejected cheaply.
  // Partial acceptance: valid events proceed even if some in the batch fail.
  const validation = validateEventBatch(events, auth.device_id);
  if (validation.valid.length === 0) {
    // Entire batch failed validation — short-circuit immediately
    incrementError(auth.tenant_id, "VALIDATION_FAILED");
    res.status(422).json({
      error: "All events in batch failed validation",
      accepted: 0,
      rejected: validation.rejected.length,
      rejected_events: validation.rejected,
    });
    return;
  }
  // Continue with only the valid subset
  const validEvents = validation.valid;

  // ── Rate limiting: per-device sliding window ─────────────────────────────
  const rateCheck = checkRateLimit(auth.device_id, validEvents.length);
  if (!rateCheck.allowed) {
    incrementError(auth.tenant_id, "RATE_LIMIT_HIT");
    recordDeviceActivity(auth.device_id, auth.tenant_id, 0, true);
    res.status(429).json({
      error: "Rate limit exceeded — device",
      remaining: rateCheck.remaining,
      retry_after_ms: rateCheck.retryAfterMs,
    });
    return;
  }

  // ── Rate limiting: per-tenant aggregate window ────────────────────────────
  const tenantRateCheck = checkTenantRateLimit(auth.tenant_id, validEvents.length);
  if (!tenantRateCheck.allowed) {
    incrementError(auth.tenant_id, "TENANT_RATE_LIMIT_HIT");
    recordDeviceActivity(auth.device_id, auth.tenant_id, 0, true);
    res.status(429).json({
      error: "Rate limit exceeded — tenant aggregate",
      remaining: tenantRateCheck.remaining,
      retry_after_ms: tenantRateCheck.retryAfterMs,
    });
    return;
  }

  // ── Tenant billing status gate (FASE 12) ─────────────────────────────────
  // suspended / canceled tenants cannot push events — return 402 immediately.
  const active = await isTenantActive(auth.tenant_id);
  if (!active) {
    incrementError(auth.tenant_id, "TENANT_INACTIVE");
    res.status(402).json({
      error: "Tenant subscription is not active",
      code: "SUBSCRIPTION_REQUIRED",
      hint: "Reactivate your subscription in the admin panel to resume syncing.",
    });
    return;
  }

  // ── Tenant daily event quota (plan-based) ─────────────────────────────────
  const tenantPlan = await resolveTenantPlan(auth.tenant_id);
  const quotaCheck = checkTenantEventLimit(auth.tenant_id, tenantPlan, validEvents.length);
  if (!quotaCheck.allowed) {
    incrementError(auth.tenant_id, "QUOTA_EXCEEDED");
    res.status(429).json({
      error: "Daily event quota exceeded",
      reason: quotaCheck.reason,
      plan: tenantPlan,
      quota_limit: quotaCheck.limit,
      quota_used: quotaCheck.used,
      quota_remaining: quotaCheck.remaining,
    });
    return;
  }

  // ── In-batch deduplication (BLOQUE 6: inflight-aware) ────────────────────
  // filterDuplicates now atomically claims new event_ids as inflight to prevent
  // TOCTOU races between concurrent pushes of the same batch.
  let claimedIds: string[] = [];
  let accepted = 0;
  let queuedDuplicates = 0;
  let queueFailed = 0;

  try {
    const seenInBatch = new Set<string>();
    const dedupedIncoming = validEvents.filter((e) => {
      if (seenInBatch.has(e.event_id)) return false;
      seenInBatch.add(e.event_id);
      return true;
    });

    // DB dedup + inflight claim (atomic)
    const incomingIds = dedupedIncoming.map((e) => e.event_id);
    const existingIds = await filterDuplicates(incomingIds);
    const newEvents = dedupedIncoming.filter((e) => !existingIds.has(e.event_id));
    claimedIds = newEvents.map((e) => e.event_id); // must be released in finally

    const batchDupCount = (validEvents.length - dedupedIncoming.length) + existingIds.size;

    if (newEvents.length > 0) {
      // ── Enqueue to write-coalescing batch queue ──────────────────────────
      const result = await enqueueEvents(
        newEvents.map((e) => ({
          event_id: e.event_id,
          type: e.type,
          timestamp: e.timestamp,
          device_id: e.device_id,
          // ── SECURITY: stamp with server-verified tenant_id ─────────────────
          // Never trust client-supplied tenant_id. auth.tenant_id is resolved
          // from the Bearer token in the DB and is the authoritative value.
          tenant_id: auth.tenant_id,
          payload: e.payload as Record<string, unknown>,
        }))
      );

      accepted = result.accepted;
      queuedDuplicates = result.duplicates + batchDupCount;
      queueFailed = result.failed;

      // Update last_seen_at (non-blocking)
      db.update(nexusDevices)
        .set({ last_seen_at: new Date() })
        .where(eq(nexusDevices.device_id, auth.device_id))
        .catch(() => { /* non-critical */ });
    } else {
      queuedDuplicates = batchDupCount;
    }
  } catch (err) {
    const isDedup = err instanceof Error && err.message === "DEDUP_DB_ERROR";
    incrementError(auth.tenant_id, isDedup ? "DEDUP_ERROR" : "QUEUE_ERROR");
    res.status(503).json({
      error: isDedup ? "Deduplication unavailable — retry" : "Event queue unavailable — retry",
      retry_after_ms: 3_000,
    });
    return;
  } finally {
    // ── Release inflight slots regardless of outcome ──────────────────────
    // Ensures concurrent pushes can re-claim these ids if this request failed
    if (claimedIds.length > 0) releaseInflight(claimedIds);
  }

  // ── Record tenant-level usage ─────────────────────────────────────────────
  if (accepted > 0) recordTenantEvents(auth.tenant_id, tenantPlan, accepted);

  const durationMs = Date.now() - syncStart;
  recordEvents(auth.tenant_id, validEvents.length);
  recordLatency(auth.tenant_id, durationMs);
  recordDeviceActivity(auth.device_id, auth.tenant_id, accepted);

  res.json({
    accepted,
    rejected: validation.rejected.length,
    rejected_events: validation.rejected.length > 0 ? validation.rejected : undefined,
    duplicates: queuedDuplicates,
    failed: queueFailed > 0 ? queueFailed : undefined,
    rate_limit_remaining: rateCheck.remaining,
    tenant_quota_remaining: quotaCheck.remaining,
    queue_depth: getQueueDepth(),
  });
});

// ─── PULL: server → device (incremental since cursor) ─────────────────────────

router.get("/nexus/sync/pull", syncTimeout, async (req, res) => {
  const auth = await resolveDevice(req.headers["authorization"]);
  if (!auth) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const since = req.query["since"];
  const limitParam = req.query["limit"];
  const limitNum = Math.min(
    typeof limitParam === "string" ? parseInt(limitParam, 10) || 200 : 200,
    1000
  );

  const conditions = [eq(nexusEvents.tenant_id, auth.tenant_id)];

  if (typeof since === "string" && since) {
    const sinceMs = parseFloat(since);
    if (!isNaN(sinceMs) && sinceMs > 0) {
      conditions.push(gt(nexusEvents.timestamp, sinceMs));
    }
  }

  const rows = await db
    .select()
    .from(nexusEvents)
    .where(and(...conditions))
    .orderBy(asc(nexusEvents.timestamp))
    .limit(limitNum);

  db.update(nexusDevices)
    .set({ last_seen_at: new Date() })
    .where(eq(nexusDevices.device_id, auth.device_id))
    .catch(() => { /* non-critical */ });

  res.json({
    events: rows,
    count: rows.length,
    cursor: rows.length > 0 ? rows[rows.length - 1]!.timestamp : (parseFloat(since as string) || 0),
  });
});

// ─── REPLAY: full state recovery ──────────────────────────────────────────────

router.get("/nexus/sync/replay", async (req, res) => {
  const auth = await resolveDevice(req.headers["authorization"]);
  if (!auth) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const rows = await db
    .select()
    .from(nexusEvents)
    .where(eq(nexusEvents.tenant_id, auth.tenant_id))
    .orderBy(asc(nexusEvents.timestamp));

  res.json({
    events: rows,
    total: rows.length,
    tenant_id: auth.tenant_id,
    replayed_at: Date.now(),
  });
});

// ─── BLOQUE 7: Full snapshot for full-resync recovery ─────────────────────────
//
// Returns a pre-built snapshot of all active orders + current menu + cursor.
// The Android app uses this to recover from corruption or persistent sync failure
// without replaying thousands of raw events. After fetching, the device advances
// its cursor to `snapshot_cursor` and resumes incremental pull from there.

router.get("/nexus/sync/full-snapshot", adminTimeout, async (req, res) => {
  const auth = await resolveDevice(req.headers["authorization"]);
  if (!auth) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  try {
    // 1. Latest event timestamp for this tenant — this becomes the sync cursor
    const latestRow = await db
      .select({ ts: nexusEvents.timestamp })
      .from(nexusEvents)
      .where(eq(nexusEvents.tenant_id, auth.tenant_id))
      .orderBy(desc(nexusEvents.timestamp))
      .limit(1);
    const cursor = latestRow[0]?.ts ?? 0;

    // 2. Orders snapshot (cached or rebuilt) + paidOrderIds
    const { orders, paidOrderIds } = await getOrdersAndPaidIds(auth.tenant_id);

    // 3. Current menu (cached or fetched from latest MENU_UPDATED event)
    const menu = await getMenuPayload(auth.tenant_id);

    // Serialise Map → array for JSON transport
    const ordersArray = Array.from(orders.values());

    res.json({
      snapshot_at: Date.now(),
      snapshot_cursor: cursor,
      orders: ordersArray,
      paid_order_ids: Array.from(paidOrderIds),
      menu: menu ?? {},
      tenant_id: auth.tenant_id,
    });
  } catch {
    res.status(503).json({ error: "Snapshot unavailable — retry" });
  }
});

// ─── System health (queue + rate limit info) ──────────────────────────────────

router.get("/nexus/system/health", async (_req, res) => {
  const qStats = getQueueStats();
  res.json({
    status: "ok",
    queue: {
      depth: qStats.depth,
      max_depth: qStats.maxDepth,
      flushing: qStats.flushing,
      utilization_pct: Math.round((qStats.depth / qStats.maxDepth) * 100),
    },
    cache: getCacheStatus(),
    timestamp: Date.now(),
  });
});

// ─── Raw events query (no auth — admin/debug) ──────────────────────────────────

router.get("/nexus/events", async (req, res) => {
  const tenantId = req.query["tenant_id"];
  const type = req.query["type"];
  const since = req.query["since"];
  const limit = req.query["limit"];

  if (typeof tenantId !== "string" || !tenantId) {
    res.status(400).json({ error: "tenant_id is required" });
    return;
  }

  const limitNum = Math.min(
    typeof limit === "string" ? parseInt(limit, 10) || 100 : 100,
    1000
  );

  const conditions = [eq(nexusEvents.tenant_id, tenantId)];

  if (typeof type === "string" && type) {
    conditions.push(eq(nexusEvents.type, type));
  }

  if (typeof since === "string" && since) {
    const sinceMs = parseFloat(since);
    if (!isNaN(sinceMs)) {
      conditions.push(gt(nexusEvents.timestamp, sinceMs));
    }
  }

  const [rows, countResult] = await Promise.all([
    db
      .select()
      .from(nexusEvents)
      .where(and(...conditions))
      .orderBy(desc(nexusEvents.timestamp))
      .limit(limitNum),
    db
      .select({ count: sql<number>`count(*)` })
      .from(nexusEvents)
      .where(and(...conditions)),
  ]);

  res.json({
    events: rows,
    total: Number(countResult[0]?.count ?? 0),
  });
});

// ─── Device registration ──────────────────────────────────────────────────────

router.post("/nexus/auth/device", async (req, res) => {
  const parsed = RegisterDeviceBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: "Validation failed",
      details: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
    });
    return;
  }

  const { device_id, tenant_id, name } = parsed.data;

  const [existing] = await db
    .select()
    .from(nexusDevices)
    .where(eq(nexusDevices.device_id, device_id))
    .limit(1);

  if (existing) {
    res.json({
      device_id: existing.device_id,
      token: existing.token,
      registered_at: existing.registered_at.toISOString(),
      already_existed: true,
    });
    return;
  }

  const token = crypto.randomBytes(32).toString("hex");
  const [created] = await db
    .insert(nexusDevices)
    .values({ device_id, tenant_id, name, token })
    .returning();

  res.json({
    device_id: created!.device_id,
    token: created!.token,
    registered_at: created!.registered_at.toISOString(),
    already_existed: false,
  });
});

export default router;
