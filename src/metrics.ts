// ─── BLOQUE 3: In-Memory Metrics ──────────────────────────────────────────────
//
// Rule: pure in-memory, no persistence. Resets on server restart.
// All structures are tenant-aware and auto-pruned to bound memory usage.

const SERVER_START = Date.now();

// ─── Events-per-minute sliding window (60 × 1s buckets) ──────────────────────

interface EvtBucket {
  ts: number;    // second-aligned unix timestamp (ms)
  count: number;
  errors: number;
}

// Global map: tenant_id → ring buffer of 60 buckets
const evtBuckets = new Map<string, EvtBucket[]>();

function currentBucket(): number {
  return Math.floor(Date.now() / 1000) * 1000;
}

export function recordEvents(
  tenantId: string,
  count: number,
  isError = false
): void {
  const now = currentBucket();
  if (!evtBuckets.has(tenantId)) evtBuckets.set(tenantId, []);
  const ring = evtBuckets.get(tenantId)!;

  let bucket = ring.find((b) => b.ts === now);
  if (!bucket) {
    bucket = { ts: now, count: 0, errors: 0 };
    ring.push(bucket);
  }
  bucket.count += count;
  if (isError) bucket.errors += count;

  // Keep only last 120 buckets (2 min)
  const cutoff = now - 120_000;
  while (ring.length > 0 && ring[0]!.ts < cutoff) ring.shift();
}

export function getEventsPerMinute(
  tenantId: string
): Array<{ ts: number; count: number; errors: number }> {
  const ring = evtBuckets.get(tenantId) ?? [];
  const now = currentBucket();
  const cutoff = now - 60_000;
  const result: EvtBucket[] = [];
  // Fill all 60 buckets (pad gaps with zeros)
  for (let t = cutoff; t <= now; t += 1000) {
    const found = ring.find((b) => b.ts === t);
    result.push(found ?? { ts: t, count: 0, errors: 0 });
  }
  return result;
}

// ─── Latency histogram (reservoir sampling, last 2000 samples) ───────────────

const RESERVOIR_SIZE = 2000;
const latencySamples = new Map<string, number[]>();

export function recordLatency(tenantId: string, durationMs: number): void {
  if (!latencySamples.has(tenantId)) latencySamples.set(tenantId, []);
  const samples = latencySamples.get(tenantId)!;
  samples.push(durationMs);
  if (samples.length > RESERVOIR_SIZE) samples.shift();
}

export function getLatencyStats(
  tenantId: string
): { p50: number; p95: number; p99: number; avg: number; count: number } {
  const samples = latencySamples.get(tenantId) ?? [];
  if (samples.length === 0) return { p50: 0, p95: 0, p99: 0, avg: 0, count: 0 };

  const sorted = [...samples].sort((a, b) => a - b);
  const p = (pct: number) => sorted[Math.floor(sorted.length * pct)] ?? 0;
  const avg = Math.round(sorted.reduce((a, b) => a + b, 0) / sorted.length);
  return {
    p50: p(0.5),
    p95: p(0.95),
    p99: p(0.99),
    avg,
    count: sorted.length,
  };
}

// ─── Error counters ───────────────────────────────────────────────────────────

// tenant → { errorType → count }
const errorCounts = new Map<string, Map<string, number>>();

export function incrementError(tenantId: string, errorType: string): void {
  if (!errorCounts.has(tenantId)) errorCounts.set(tenantId, new Map());
  const m = errorCounts.get(tenantId)!;
  m.set(errorType, (m.get(errorType) ?? 0) + 1);
}

export function getErrorCounts(
  tenantId: string
): Array<{ type: string; count: number }> {
  const m = errorCounts.get(tenantId) ?? new Map<string, number>();
  return [...m.entries()]
    .map(([type, count]) => ({ type, count }))
    .sort((a, b) => b.count - a.count);
}

// ─── Device activity tracker ──────────────────────────────────────────────────

interface DeviceActivity {
  tenantId: string;
  deviceId: string;
  lastSyncAt: number;       // unix ms
  eventsToday: number;
  consecutiveErrors: number;
}

const deviceActivity = new Map<string, DeviceActivity>(); // key = deviceId

export function recordDeviceActivity(
  deviceId: string,
  tenantId: string,
  count: number,
  isError = false
): void {
  const existing = deviceActivity.get(deviceId);
  const dayStart = new Date().setHours(0, 0, 0, 0);
  const prev = existing ?? { tenantId, deviceId, lastSyncAt: 0, eventsToday: 0, consecutiveErrors: 0 };

  // Reset daily counter if it's a new day
  const eventsToday =
    prev.lastSyncAt >= dayStart ? prev.eventsToday + count : count;

  deviceActivity.set(deviceId, {
    tenantId,
    deviceId,
    lastSyncAt: Date.now(),
    eventsToday,
    consecutiveErrors: isError ? prev.consecutiveErrors + 1 : 0,
  });
}

type DeviceStatus = "online" | "degraded" | "offline";

function deviceStatus(lastSyncAt: number, consecutiveErrors: number): DeviceStatus {
  const age = Date.now() - lastSyncAt;
  if (consecutiveErrors >= 3) return "degraded";
  if (age < 30_000) return "online";
  if (age < 120_000) return "degraded";
  return "offline";
}

export function getDeviceActivity(
  tenantId: string
): Array<DeviceActivity & { status: DeviceStatus }> {
  return [...deviceActivity.values()]
    .filter((d) => d.tenantId === tenantId)
    .map((d) => ({ ...d, status: deviceStatus(d.lastSyncAt, d.consecutiveErrors) }));
}

// ─── Alert generator ──────────────────────────────────────────────────────────

export interface MetricAlert {
  id: string;
  type: "device_offline" | "device_degraded" | "high_error_rate" | "backend_degraded";
  severity: "warning" | "critical";
  message: string;
  since: number;
}

export function getAlerts(tenantId: string): MetricAlert[] {
  const alerts: MetricAlert[] = [];

  for (const d of [...deviceActivity.values()].filter((d) => d.tenantId === tenantId)) {
    const s = deviceStatus(d.lastSyncAt, d.consecutiveErrors);
    if (s === "offline") {
      const minutes = Math.floor((Date.now() - d.lastSyncAt) / 60_000);
      alerts.push({
        id: `offline:${d.deviceId}`,
        type: "device_offline",
        severity: "critical",
        message: `Device ${d.deviceId} has been offline for ${minutes} min`,
        since: d.lastSyncAt,
      });
    } else if (s === "degraded" || d.consecutiveErrors >= 3) {
      alerts.push({
        id: `degraded:${d.deviceId}`,
        type: "device_degraded",
        severity: "warning",
        message: `Device ${d.deviceId} has ${d.consecutiveErrors} consecutive sync errors`,
        since: d.lastSyncAt,
      });
    }
  }

  // High error rate: > 10 errors in last minute
  const recentBuckets = getEventsPerMinute(tenantId);
  const recentErrors = recentBuckets.reduce((s, b) => s + b.errors, 0);
  const recentTotal = recentBuckets.reduce((s, b) => s + b.count, 0);
  if (recentTotal > 50 && recentErrors / recentTotal > 0.1) {
    alerts.push({
      id: "high_error_rate",
      type: "high_error_rate",
      severity: "warning",
      message: `High error rate: ${Math.round((recentErrors / recentTotal) * 100)}% of events failed`,
      since: Date.now(),
    });
  }

  return alerts;
}

// ─── System uptime ────────────────────────────────────────────────────────────

export function getUptimeSeconds(): number {
  return Math.floor((Date.now() - SERVER_START) / 1000);
}

// ─── Full metrics snapshot ────────────────────────────────────────────────────

export function getMetrics(tenantId: string) {
  return {
    events_per_minute: getEventsPerMinute(tenantId),
    latency: getLatencyStats(tenantId),
    errors: getErrorCounts(tenantId),
    devices: getDeviceActivity(tenantId),
    alerts: getAlerts(tenantId),
    system: {
      uptime_seconds: getUptimeSeconds(),
    },
  };
}
