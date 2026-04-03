/**
 * Nexus POS — Metrics Engine
 *
 * Collects per-tenant and system-level metrics.
 * Exposes Prometheus-compatible text format at /api/nexus/observability/metrics
 * and JSON at /api/nexus/observability/metrics.json
 *
 * Metric families:
 *   nexus_events_total{tenant,type}             — event counter by type
 *   nexus_orders_total{tenant,status}           — order counter
 *   nexus_revenue_total{tenant,currency}        — cumulative revenue (cents)
 *   nexus_sync_errors_total{tenant}             — sync error counter
 *   nexus_device_heartbeats{tenant}             — active device count
 *   nexus_api_request_duration_ms{route,method,status} — API latency histogram
 *   nexus_cache_hits_total{type}                — cache hit/miss counters
 *   nexus_queue_depth                           — current event queue depth
 *
 * Trace context:
 *   Every event carries a trace_id (X-Trace-Id header or auto-generated).
 *   Spans are stored in a ring buffer for the last 10_000 events per tenant.
 */

import { performance } from "node:perf_hooks";
import { randomBytes } from "node:crypto";

// ── Types ──────────────────────────────────────────────────────────────────────

export interface TraceSpan {
  traceId:    string;
  spanId:     string;
  parentId:   string | null;
  operation:  string;
  tenantId:   string;
  deviceId:   string;
  startMs:    number;
  durationMs: number;
  status:     "ok" | "error";
  tags:       Record<string, string>;
}

export interface TenantMetrics {
  tenantId:         string;
  eventsTotal:      Record<string, number>;  // EventType → count
  ordersTotal:      Record<string, number>;  // status → count
  revenueTotal:     number;                  // cents
  syncErrorsTotal:  number;
  activeDevices:    Set<string>;
  lastEventAt:      number | null;
  spans:            TraceSpan[];             // ring buffer, last 500
}

// ── Store ──────────────────────────────────────────────────────────────────────

const tenantMetrics = new Map<string, TenantMetrics>();
const apiHistogram   = new Map<string, number[]>();  // "METHOD:route:status" → [latencyMs…]
const cacheCounters  = { hits: 0, misses: 0 };

function getTenantMetrics(tenantId: string): TenantMetrics {
  if (!tenantMetrics.has(tenantId)) {
    tenantMetrics.set(tenantId, {
      tenantId,
      eventsTotal:     {},
      ordersTotal:     {},
      revenueTotal:    0,
      syncErrorsTotal: 0,
      activeDevices:   new Set(),
      lastEventAt:     null,
      spans:           [],
    });
  }
  return tenantMetrics.get(tenantId)!;
}

// ── Trace context helpers ──────────────────────────────────────────────────────

export function generateTraceId(): string {
  return randomBytes(16).toString("hex");
}

export function generateSpanId(): string {
  return randomBytes(8).toString("hex");
}

export function recordSpan(span: Omit<TraceSpan, "spanId">): TraceSpan {
  const full: TraceSpan = { spanId: generateSpanId(), ...span };
  const m = getTenantMetrics(span.tenantId);
  m.spans.push(full);
  if (m.spans.length > 500) m.spans.shift();
  return full;
}

// ── Metric recording ──────────────────────────────────────────────────────────

export function recordEvent(tenantId: string, eventType: string, deviceId?: string): void {
  const m = getTenantMetrics(tenantId);
  m.eventsTotal[eventType] = (m.eventsTotal[eventType] ?? 0) + 1;
  m.lastEventAt = Date.now();
  if (deviceId) m.activeDevices.add(deviceId);
}

export function recordOrder(tenantId: string, status: string, amountCents = 0): void {
  const m = getTenantMetrics(tenantId);
  m.ordersTotal[status] = (m.ordersTotal[status] ?? 0) + 1;
  if (status === "paid") m.revenueTotal += amountCents;
}

export function recordSyncError(tenantId: string): void {
  getTenantMetrics(tenantId).syncErrorsTotal++;
}

export function recordCacheHit(hit: boolean): void {
  if (hit) cacheCounters.hits++;
  else     cacheCounters.misses++;
}

export function recordApiLatency(method: string, route: string, status: number, ms: number): void {
  const key = `${method}:${route}:${status}`;
  if (!apiHistogram.has(key)) apiHistogram.set(key, []);
  const samples = apiHistogram.get(key)!;
  samples.push(ms);
  if (samples.length > 2000) samples.shift();
}

// ── Aggregation ────────────────────────────────────────────────────────────────

function pct(samples: number[], p: number): number {
  if (!samples.length) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)] ?? 0;
}

export function getMetricsSummary() {
  const tenants = Array.from(tenantMetrics.values()).map((m) => ({
    tenantId:        m.tenantId,
    eventsTotal:     m.eventsTotal,
    ordersTotal:     m.ordersTotal,
    revenueTotal:    m.revenueTotal,
    syncErrorsTotal: m.syncErrorsTotal,
    activeDevices:   m.activeDevices.size,
    lastEventAt:     m.lastEventAt,
    spansCount:      m.spans.length,
  }));

  const apiStats = Array.from(apiHistogram.entries()).map(([key, samples]) => {
    const [method, route, status] = key.split(":");
    return {
      method, route, status: Number(status),
      count:  samples.length,
      p50:    pct(samples, 50),
      p95:    pct(samples, 95),
      p99:    pct(samples, 99),
      mean:   samples.length ? Math.round(samples.reduce((a, b) => a + b, 0) / samples.length) : 0,
    };
  });

  return {
    tenants,
    api: apiStats,
    cache: {
      hits:      cacheCounters.hits,
      misses:    cacheCounters.misses,
      hitRate:   cacheCounters.hits + cacheCounters.misses > 0
        ? (cacheCounters.hits / (cacheCounters.hits + cacheCounters.misses))
        : 0,
    },
    system: {
      uptimeSeconds: process.uptime(),
      memoryMb:      Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
      cpuUsage:      process.cpuUsage(),
      nodeVersion:   process.version,
      pid:           process.pid,
    },
  };
}

// ── Prometheus text format ────────────────────────────────────────────────────

export function renderPrometheus(): string {
  const lines: string[] = [];
  const ts = Date.now();

  function gauge(name: string, value: number, labels?: Record<string, string>, help?: string): void {
    if (help) lines.push(`# HELP ${name} ${help}`);
    lines.push(`# TYPE ${name} gauge`);
    const labelStr = labels
      ? `{${Object.entries(labels).map(([k, v]) => `${k}="${v}"`).join(",")}}`
      : "";
    lines.push(`${name}${labelStr} ${value} ${ts}`);
  }

  function counter(name: string, value: number, labels?: Record<string, string>, help?: string): void {
    if (help) lines.push(`# HELP ${name}_total ${help}`);
    lines.push(`# TYPE ${name}_total counter`);
    const labelStr = labels
      ? `{${Object.entries(labels).map(([k, v]) => `${k}="${v}"`).join(",")}}`
      : "";
    lines.push(`${name}_total${labelStr} ${value} ${ts}`);
  }

  // System metrics
  gauge("nexus_uptime_seconds", process.uptime(), undefined, "Process uptime in seconds");
  gauge("nexus_memory_heap_mb",
    Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
    undefined, "Heap memory usage in MB");

  // Cache metrics
  counter("nexus_cache_hits",   cacheCounters.hits,   { type: "all" }, "Cache hit counter");
  counter("nexus_cache_misses", cacheCounters.misses, { type: "all" }, "Cache miss counter");

  // Per-tenant metrics
  for (const m of tenantMetrics.values()) {
    const tid = m.tenantId;

    // Events by type
    for (const [type, cnt] of Object.entries(m.eventsTotal)) {
      counter("nexus_events", cnt, { tenant: tid, type }, "Events by type");
    }

    // Orders by status
    for (const [status, cnt] of Object.entries(m.ordersTotal)) {
      counter("nexus_orders", cnt, { tenant: tid, status }, "Orders by status");
    }

    // Revenue
    gauge("nexus_revenue_cents", m.revenueTotal, { tenant: tid }, "Cumulative revenue in cents");

    // Sync errors
    counter("nexus_sync_errors", m.syncErrorsTotal, { tenant: tid }, "Sync error counter");

    // Active devices
    gauge("nexus_active_devices", m.activeDevices.size, { tenant: tid }, "Active device count");
  }

  // API latency histograms
  lines.push("# HELP nexus_api_request_duration_ms API request duration");
  lines.push("# TYPE nexus_api_request_duration_ms summary");
  for (const [key, samples] of apiHistogram.entries()) {
    const [method, route, status] = key.split(":");
    if (!samples.length) continue;
    const labels = `method="${method}",route="${route}",status="${status}"`;
    lines.push(`nexus_api_request_duration_ms{${labels},quantile="0.5"} ${pct(samples, 50)} ${ts}`);
    lines.push(`nexus_api_request_duration_ms{${labels},quantile="0.95"} ${pct(samples, 95)} ${ts}`);
    lines.push(`nexus_api_request_duration_ms{${labels},quantile="0.99"} ${pct(samples, 99)} ${ts}`);
    lines.push(`nexus_api_request_duration_ms_count{${labels}} ${samples.length} ${ts}`);
  }

  return lines.join("\n") + "\n";
}

// ── Span query ────────────────────────────────────────────────────────────────

export function getSpans(tenantId: string, limit = 50): TraceSpan[] {
  const m = tenantMetrics.get(tenantId);
  if (!m) return [];
  return m.spans.slice(-limit).reverse();
}

export function getAllTenantMetrics(): TenantMetrics[] {
  return Array.from(tenantMetrics.values());
}

export { tenantMetrics };
