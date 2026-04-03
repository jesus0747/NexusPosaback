// ─── BLOQUE 6: Idempotent deduplication with in-flight tracking ───────────────
//
// Two-layer dedup strategy:
//
//  Layer 1 — In-flight map (in-memory):
//    When filterDuplicates is called, each event_id is claimed atomically.
//    If a concurrent push tries to claim the same event_id before it commits,
//    it's immediately treated as a duplicate. This closes the TOCTOU race where
//    two simultaneous pushes of the same batch both pass the DB check before
//    either write.
//
//  Layer 2 — DB check (Postgres):
//    For newly claimed ids, query nexus_events for any already committed.
//    These are released from the inflight map immediately since the DB is the
//    source of truth for committed events.
//
//  Callers MUST call releaseInflight(ids) after the batch commits or fails.
//  Auto-cleanup runs every 60s to remove stale claims (prevent memory leak).

import { db } from "@workspace/db";
import { nexusEvents } from "@workspace/db/schema";
import { inArray } from "drizzle-orm";

// ── In-flight tracking ────────────────────────────────────────────────────────
// event_id → expiresAt (ms). Auto-expires after INFLIGHT_TTL_MS.

const INFLIGHT_TTL_MS = 30_000; // 30s — well beyond any reasonable flush cycle
const inflightMap = new Map<string, number>();

function isInflight(eventId: string): boolean {
  const expiresAt = inflightMap.get(eventId);
  if (expiresAt === undefined) return false;
  if (Date.now() > expiresAt) {
    inflightMap.delete(eventId);
    return false;
  }
  return true;
}

/** Release claimed inflight slots. MUST be called after batch commit or failure. */
export function releaseInflight(eventIds: string[]): void {
  for (const id of eventIds) inflightMap.delete(id);
}

// ── Core dedup ────────────────────────────────────────────────────────────────

/**
 * Returns the Set of event_ids that are duplicates (inflight or already in DB).
 * Atomically claims all non-duplicate ids as inflight before the DB check.
 * Caller MUST call releaseInflight(non-duplicate ids) after the batch finishes.
 */
export async function filterDuplicates(eventIds: string[]): Promise<Set<string>> {
  if (eventIds.length === 0) return new Set();

  const duplicates = new Set<string>();
  const toDbCheck: string[] = [];

  // Layer 1: in-flight check (synchronous — safe in single-threaded JS)
  for (const id of eventIds) {
    if (isInflight(id)) {
      duplicates.add(id); // concurrent push already claimed this id
    } else {
      inflightMap.set(id, Date.now() + INFLIGHT_TTL_MS); // claim slot
      toDbCheck.push(id);
    }
  }

  // Layer 2: DB check for newly claimed ids
  if (toDbCheck.length > 0) {
    try {
      const existing = await db
        .select({ event_id: nexusEvents.event_id })
        .from(nexusEvents)
        .where(inArray(nexusEvents.event_id, toDbCheck));

      for (const row of existing) {
        duplicates.add(row.event_id);
        // Release inflight — DB is already the source of truth here
        inflightMap.delete(row.event_id);
      }
    } catch {
      // On DB error: release all newly claimed slots so caller can retry
      for (const id of toDbCheck) inflightMap.delete(id);
      throw new Error("DEDUP_DB_ERROR");
    }
  }

  return duplicates;
}

// ── Diagnostics ───────────────────────────────────────────────────────────────
export function getInflightCount(): number {
  return inflightMap.size;
}

// ── Stale claim cleanup (every 60s) ──────────────────────────────────────────
setInterval(() => {
  const now = Date.now();
  for (const [id, expiresAt] of inflightMap.entries()) {
    if (now > expiresAt) inflightMap.delete(id);
  }
}, 60_000).unref();
