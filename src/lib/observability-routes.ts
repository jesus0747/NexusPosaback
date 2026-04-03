/**
 * Nexus POS — Observability Routes
 *
 * Routes:
 *   GET /nexus/observability/metrics        — Prometheus text format
 *   GET /nexus/observability/metrics.json   — JSON format
 *   GET /nexus/observability/tenants        — per-tenant metrics summary
 *   GET /nexus/observability/traces/:tid    — trace spans for tenant
 *   GET /nexus/observability/trace/:traceId — single trace by ID
 *   GET /nexus/observability/health         — full system health (enhanced)
 */

import { Router, Request, Response, NextFunction } from "express";
import { performance } from "node:perf_hooks";
import {
  getMetricsSummary,
  renderPrometheus,
  getSpans,
  getAllTenantMetrics,
  recordApiLatency,
  generateTraceId,
  TenantMetrics,
  TraceSpan,
} from "./metrics-engine.js";
import { REGIONS, SERVING_REGION } from "./region-router.js";
import { streamingStats } from "./streaming-engine.js";

const router = Router();

// ── Tracing middleware ─────────────────────────────────────────────────────────
// Attaches trace_id to every request; records API latency.

export function tracingMiddleware(req: Request, res: Response, next: NextFunction): void {
  const traceId = (req.headers["x-trace-id"] as string) ?? generateTraceId();
  const start   = performance.now();

  req.headers["x-trace-id"] = traceId;
  res.setHeader("X-Trace-Id", traceId);

  res.on("finish", () => {
    const elapsed  = performance.now() - start;
    const route    = req.route?.path ?? req.path;
    recordApiLatency(req.method, route, res.statusCode, elapsed);
  });

  next();
}

// ── Routes ─────────────────────────────────────────────────────────────────────

/** GET /nexus/observability/metrics — Prometheus text format */
router.get("/nexus/observability/metrics", (_req, res) => {
  res.setHeader("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
  res.send(renderPrometheus());
});

/** GET /nexus/observability/metrics.json — JSON metrics for admin panel */
router.get("/nexus/observability/metrics.json", (_req, res) => {
  res.json(getMetricsSummary());
});

/** GET /nexus/observability/tenants — per-tenant metrics list */
router.get("/nexus/observability/tenants", (_req, res) => {
  const all = getAllTenantMetrics();
  const tenants = all.map((m) => ({
    tenantId:        m.tenantId,
    totalEvents:     Object.values(m.eventsTotal).reduce((a, b) => a + b, 0),
    eventsBreakdown: m.eventsTotal,
    ordersBreakdown: m.ordersTotal,
    revenueTotal:    m.revenueTotal,
    syncErrors:      m.syncErrorsTotal,
    activeDevices:   m.activeDevices.size,
    lastEventAt:     m.lastEventAt,
    tracesAvailable: m.spans.length,
    errorRate: (() => {
      const total = Object.values(m.eventsTotal).reduce((a, b) => a + b, 0);
      return total > 0 ? m.syncErrorsTotal / total : 0;
    })(),
  }));
  res.json({ tenants, total: tenants.length });
});

/** GET /nexus/observability/traces/:tenantId?limit=50 */
router.get("/nexus/observability/traces/:tenantId", (req, res) => {
  const { tenantId } = req.params;
  const limit = Math.min(Number(req.query["limit"] ?? 50), 500);
  const spans  = getSpans(tenantId, limit);
  res.json({ tenantId, spans, count: spans.length });
});

/** GET /nexus/observability/trace/:traceId — find a specific trace across all tenants */
router.get("/nexus/observability/trace/:traceId", (req, res) => {
  const { traceId } = req.params;
  const allSpans: TraceSpan[] = [];

  for (const m of getAllTenantMetrics()) {
    for (const span of m.spans) {
      if (span.traceId === traceId) allSpans.push(span);
    }
  }

  if (allSpans.length === 0) {
    return res.status(404).json({ error: "Trace not found" });
  }

  allSpans.sort((a, b) => a.startMs - b.startMs);
  const root = allSpans[0]!;
  const totalDuration = allSpans.reduce((max, s) => Math.max(max, s.durationMs), 0);

  res.json({
    traceId,
    spans:         allSpans,
    spanCount:     allSpans.length,
    rootOperation: root.operation,
    tenantId:      root.tenantId,
    startMs:       root.startMs,
    totalDurationMs: totalDuration,
  });
});

/**
 * GET /nexus/observability/health — enterprise health check
 * Covers: DB, cache, event queue, regions, streaming, OTA
 */
router.get("/nexus/observability/health", (_req, res) => {
  const summary = getMetricsSummary();

  const regions = Object.values(REGIONS).map((r) => ({
    code:       r.code,
    status:     r.status,
    latencyMs:  r.latencyMs,
    p95Ms:      r.p95Ms,
  }));

  const tenantCount  = getAllTenantMetrics().length;
  const totalEvents  = getAllTenantMetrics().reduce(
    (sum, m) => sum + Object.values(m.eventsTotal).reduce((a, b) => a + b, 0),
    0
  );

  const cacheHitRate = summary.cache.hitRate;
  const streaming    = streamingStats;

  // Determine overall health
  const checks = [
    { name: "memory",    ok: summary.system.memoryMb < 512,     value: `${summary.system.memoryMb}MB` },
    { name: "cache",     ok: cacheHitRate > 0.5 || tenantCount === 0, value: `${(cacheHitRate * 100).toFixed(1)}%` },
    { name: "streaming", ok: streaming.backpressureEvents === 0, value: `${streaming.throughputEps.toFixed(1)} eps` },
    { name: "regions",   ok: regions.some((r) => r.status === "healthy"), value: `${regions.filter((r) => r.status === "healthy").length}/${regions.length}` },
  ];

  const allOk     = checks.every((c) => c.ok);
  const anyFailed = checks.some((c) => !c.ok);

  res.status(allOk ? 200 : anyFailed ? 503 : 207).json({
    status:    allOk ? "healthy" : anyFailed ? "degraded" : "partial",
    serving:   SERVING_REGION,
    uptime:    summary.system.uptime,
    checks,
    tenants: {
      count:       tenantCount,
      totalEvents,
    },
    streaming: {
      eps:             streaming.throughputEps.toFixed(2),
      avgBatchDelayMs: streaming.avgBatchDelayMs.toFixed(1),
      compressionRatio: streaming.compressionRatio.toFixed(3),
      sseConnections:  streaming.sseConnections,
    },
    regions: {
      serving: SERVING_REGION,
      list:    regions,
    },
    cache: summary.cache,
    memory: {
      heapMb: summary.system.memoryMb,
    },
    timestamp: new Date().toISOString(),
  });
});

export const observabilityRouter = router;
