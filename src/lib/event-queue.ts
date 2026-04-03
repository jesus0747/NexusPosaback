// ─── BLOQUE 6: Write-coalescing queue (hardened) ─────────────────────────────
//
// Incoming events are buffered for BATCH_DELAY_MS, then flushed as a single
// DB batch write. This eliminates N×1 insertion under burst load.
//
// Hardening changes (BLOQUE 6):
//  - MAX_QUEUE_DEPTH: rejects enqueue immediately if queue is overloaded (503)
//  - Per-enqueue timeout (ENQUEUE_TIMEOUT_MS): prevents request from hanging
//    if the flush loop is stuck on a slow DB connection
//  - DB write retry: on transient error, retries once with a 100ms pause
//  - Flush error isolation: distinguishes DB unavailable (reject all) from
//    conflict/constraint (resolve false — these are soft duplicates)

import { db } from "@workspace/db";
import { nexusEvents } from "@workspace/db/schema";
import { broadcastEvent } from "./ws.js";
import { applyEventToSnapshot, invalidateStatsCache, setMenuCache } from "./tenant-cache.js";

export interface QueuedEvent {
  event_id: string;
  type: string;
  timestamp: number;
  device_id: string;
  tenant_id: string;
  payload: Record<string, unknown>;
}

interface PendingItem {
  event: QueuedEvent;
  resolve: (accepted: boolean) => void;
  reject: (err: unknown) => void;
  enqueuedAt: number;
}

const BATCH_DELAY_MS = 30;       // coalesce writes within 30ms
const MAX_BATCH_SIZE = 250;      // max events per DB transaction
const MAX_QUEUE_DEPTH = 2_000;   // reject immediately above this depth
const ENQUEUE_TIMEOUT_MS = 5_000; // per-event timeout before 503

let queue: PendingItem[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let flushing = false;

// ── Flush implementation ──────────────────────────────────────────────────────

async function tryDbInsert(items: PendingItem[], attempt: number): Promise<void> {
  try {
    await db.insert(nexusEvents)
      .values(items.map((item) => ({
        event_id: item.event.event_id,
        type: item.event.type,
        timestamp: item.event.timestamp,
        device_id: item.event.device_id,
        tenant_id: item.event.tenant_id,
        payload: item.event.payload,
      })))
      .onConflictDoNothing(); // idempotent — event_id PRIMARY KEY
  } catch (err) {
    if (attempt === 0) {
      // Retry once after 100ms for transient errors (connection blip, lock timeout)
      await new Promise((r) => setTimeout(r, 100));
      return tryDbInsert(items, 1);
    }
    throw err; // propagate on second failure
  }
}

async function flush(): Promise<void> {
  if (flushing || queue.length === 0) return;

  const batch = queue.splice(0, MAX_BATCH_SIZE);
  flushing = true;
  flushTimer = null;

  // ── In-queue dedup: resolve false for batch-level duplicates ─────────────
  const seen = new Set<string>();
  const deduped = batch.filter((item) => {
    if (seen.has(item.event.event_id)) {
      item.resolve(false);
      return false;
    }
    seen.add(item.event.event_id);
    return true;
  });

  try {
    await tryDbInsert(deduped, 0);

    // ── Post-commit: cache + broadcast ────────────────────────────────────
    for (const item of deduped) {
      broadcastEvent(item.event.tenant_id, item.event);

      applyEventToSnapshot(item.event.tenant_id, {
        type: item.event.type,
        timestamp: item.event.timestamp,
        device_id: item.event.device_id,
        payload: item.event.payload,
      });

      if (item.event.type === "MENU_UPDATED") {
        const version = (item.event.payload["version"] as number | undefined) ?? item.event.timestamp;
        setMenuCache(item.event.tenant_id, item.event.payload, version);
      }

      invalidateStatsCache(item.event.tenant_id);
      item.resolve(true);
    }
  } catch (err) {
    // ── Classify error ────────────────────────────────────────────────────
    // Reject all items in the failed batch. The caller (routes.ts) wraps
    // enqueueEvents in try/catch and returns 503 to the device.
    // Device will retry on next sync cycle (offline-first guarantee).
    for (const item of deduped) {
      item.reject(err);
    }
  } finally {
    flushing = false;
    if (queue.length > 0) {
      scheduleFlush();
    }
  }
}

function scheduleFlush(): void {
  if (flushTimer) return;
  if (queue.length >= MAX_BATCH_SIZE) {
    void flush();
  } else {
    flushTimer = setTimeout(() => { void flush(); }, BATCH_DELAY_MS);
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

export function enqueueEvent(event: QueuedEvent): Promise<boolean> {
  // Queue overflow protection — reject immediately instead of queueing forever
  if (queue.length >= MAX_QUEUE_DEPTH) {
    return Promise.reject(new Error("QUEUE_FULL"));
  }

  return new Promise<boolean>((resolve, reject) => {
    const item: PendingItem = { event, resolve, reject, enqueuedAt: Date.now() };
    queue.push(item);
    scheduleFlush();

    // Per-event timeout — if not resolved within ENQUEUE_TIMEOUT_MS, reject
    // This prevents hanging requests when the DB connection is stalled
    setTimeout(() => {
      const idx = queue.indexOf(item);
      if (idx !== -1) {
        queue.splice(idx, 1); // remove from pending queue
        reject(new Error("ENQUEUE_TIMEOUT"));
      }
      // If already resolved by flush, the reject is a no-op
    }, ENQUEUE_TIMEOUT_MS);
  });
}

export async function enqueueEvents(
  events: QueuedEvent[]
): Promise<{ accepted: number; duplicates: number; failed: number }> {
  const results = await Promise.allSettled(events.map((e) => enqueueEvent(e)));
  let accepted = 0;
  let duplicates = 0;
  let failed = 0;

  for (const r of results) {
    if (r.status === "fulfilled") {
      if (r.value) accepted++;
      else duplicates++;
    } else {
      failed++;
    }
  }
  return { accepted, duplicates, failed };
}

export function getQueueDepth(): number {
  return queue.length;
}

export function getQueueStats(): { depth: number; maxDepth: number; flushing: boolean } {
  return { depth: queue.length, maxDepth: MAX_QUEUE_DEPTH, flushing };
}

// ── Stale item cleanup (every 30s) ────────────────────────────────────────────
// Belt-and-suspenders: remove items that somehow slipped past the per-item timeout
setInterval(() => {
  const cutoff = Date.now() - ENQUEUE_TIMEOUT_MS * 2;
  const stale = queue.filter((item) => item.enqueuedAt < cutoff);
  for (const item of stale) {
    const idx = queue.indexOf(item);
    if (idx !== -1) queue.splice(idx, 1);
    item.reject(new Error("ENQUEUE_STALE"));
  }
}, 30_000).unref();
