// ─── BLOQUE 6: Request-level timeout middleware ───────────────────────────────
//
// Kills requests that run longer than TIMEOUT_MS and responds with 503.
//
// Why this matters under stress:
//  - A slow DB query (table scan, lock wait) can hold connections open indefinitely
//  - Without timeouts, a thundering herd fills the Node.js event loop with stalled
//    handlers, causing new requests to queue rather than fail fast
//  - 503 with Retry-After lets Android devices back off and retry on the next
//    sync cycle instead of waiting forever
//
// Two timeout levels:
//  - SYNC_TIMEOUT_MS (8s)  — push/pull routes where fast response is critical
//  - DEFAULT_TIMEOUT_MS (15s) — admin/setup routes that may do heavier queries

import type { Request, Response, NextFunction } from "express";

const SYNC_TIMEOUT_MS = 8_000;
const DEFAULT_TIMEOUT_MS = 15_000;

function makeTimeoutMiddleware(timeoutMs: number) {
  return function timeoutMiddleware(req: Request, res: Response, next: NextFunction): void {
    let fired = false;

    const timer = setTimeout(() => {
      if (fired || res.headersSent) return;
      fired = true;

      res.status(503).json({
        error: "Request timeout",
        message: `Handler exceeded ${timeoutMs}ms — try again`,
        retry_after_ms: Math.min(timeoutMs, 5_000),
      });

      // Destroy socket to abort any in-flight DB query keeping the connection alive
      if (!res.socket?.destroyed) {
        res.socket?.destroy();
      }
    }, timeoutMs);

    // Allow GC once request finishes normally
    res.on("finish", () => {
      if (!fired) {
        fired = true;
        clearTimeout(timer);
      }
    });

    res.on("close", () => {
      if (!fired) {
        fired = true;
        clearTimeout(timer);
      }
    });

    next();
  };
}

/** 8s timeout — for sync push/pull routes */
export const syncTimeout = makeTimeoutMiddleware(SYNC_TIMEOUT_MS);

/** 15s timeout — for admin/setup routes */
export const adminTimeout = makeTimeoutMiddleware(DEFAULT_TIMEOUT_MS);
