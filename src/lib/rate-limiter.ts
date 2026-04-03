// ─── Rate limiter: per-device + per-tenant sliding window ────────────────────
//
// Two independent limiters guard every push:
//
//  1. Per-device   — 500 events / 60s   (burst protection, one bad device can't spam)
//  2. Per-tenant   — 2000 events / 60s  (aggregate across ALL devices of a tenant)
//
// Both use a token-bucket with sliding window.  A push is only allowed when
// BOTH buckets have capacity.  Tenant limit is always ≥ per-device limit so a
// single legitimate device is never capped by the tenant limiter.

interface Bucket {
  tokens: number;
  windowStart: number;
}

// ── Per-device ────────────────────────────────────────────────────────────────
const DEVICE_MAX = 500;
const DEVICE_WINDOW_MS = 60_000;
const deviceBuckets = new Map<string, Bucket>();

export function checkRateLimit(
  deviceId: string,
  eventCount: number
): { allowed: boolean; remaining: number; retryAfterMs?: number } {
  const now = Date.now();
  let bucket = deviceBuckets.get(deviceId);

  if (!bucket || now - bucket.windowStart >= DEVICE_WINDOW_MS) {
    bucket = { tokens: DEVICE_MAX, windowStart: now };
    deviceBuckets.set(deviceId, bucket);
  }

  if (bucket.tokens < eventCount) {
    return {
      allowed: false,
      remaining: bucket.tokens,
      retryAfterMs: DEVICE_WINDOW_MS - (now - bucket.windowStart),
    };
  }

  bucket.tokens -= eventCount;
  return { allowed: true, remaining: bucket.tokens };
}

export function getRateLimitStatus(deviceId: string): { tokens: number; windowStart: number } | null {
  return deviceBuckets.get(deviceId) ?? null;
}

// ── Per-tenant aggregate ───────────────────────────────────────────────────────
// Higher ceiling than per-device — a tenant with multiple devices all pushing
// concurrently gets proportionally more capacity.
const TENANT_MAX = 2_000;
const TENANT_WINDOW_MS = 60_000;
const tenantBuckets = new Map<string, Bucket>();

export function checkTenantRateLimit(
  tenantId: string,
  eventCount: number
): { allowed: boolean; remaining: number; retryAfterMs?: number } {
  const now = Date.now();
  let bucket = tenantBuckets.get(tenantId);

  if (!bucket || now - bucket.windowStart >= TENANT_WINDOW_MS) {
    bucket = { tokens: TENANT_MAX, windowStart: now };
    tenantBuckets.set(tenantId, bucket);
  }

  if (bucket.tokens < eventCount) {
    return {
      allowed: false,
      remaining: bucket.tokens,
      retryAfterMs: TENANT_WINDOW_MS - (now - bucket.windowStart),
    };
  }

  bucket.tokens -= eventCount;
  return { allowed: true, remaining: bucket.tokens };
}

export function getTenantRateLimitStatus(
  tenantId: string
): { tokens: number; windowStart: number } | null {
  return tenantBuckets.get(tenantId) ?? null;
}

// ── Cleanup stale buckets every 2 minutes ────────────────────────────────────
setInterval(() => {
  const now = Date.now();
  for (const [id, b] of deviceBuckets.entries()) {
    if (now - b.windowStart > DEVICE_WINDOW_MS * 2) deviceBuckets.delete(id);
  }
  for (const [id, b] of tenantBuckets.entries()) {
    if (now - b.windowStart > TENANT_WINDOW_MS * 2) tenantBuckets.delete(id);
  }
}, 2 * 60_000).unref();
