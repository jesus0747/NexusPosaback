/**
 * Nexus POS — Multi-Region Router
 *
 * Architecture:
 * - Every request is stamped with the serving region (X-Nexus-Region header)
 * - Tenants can be assigned a "home region" for affinity routing
 * - Latency is tracked per-region and surfaced via /api/nexus/regions
 * - In a real multi-region deployment, the load balancer routes to the nearest
 *   region first, then falls back. Here we model the routing table + affinity
 *   so the system is ready to drop in real infra (Fly.io, Railway regions, etc.)
 *
 * Routes:
 *   GET  /nexus/regions                    — list regions with latency/health
 *   GET  /nexus/regions/tenant/:tenantId   — get tenant's assigned region
 *   POST /nexus/regions/assign             — assign tenant to region
 *   GET  /nexus/regions/affinity           — routing affinity table
 */

import { Router, Request, Response, NextFunction } from "express";
import { performance } from "node:perf_hooks";
import os from "node:os";

// ── Region catalog ─────────────────────────────────────────────────────────────
// In production these map to actual deployment regions (Fly.io: iad, lax, fra, sin, etc.)

export type RegionCode = "us-east" | "us-west" | "eu-west" | "ap-southeast" | "latam";

export interface RegionInfo {
  code:         RegionCode;
  name:         string;
  location:     string;
  tier:         "primary" | "replica";
  status:       "healthy" | "degraded" | "offline";
  latencyMs:    number | null;   // measured round-trip to this region's DB
  requestCount: number;
  errorCount:   number;
  p50Ms:        number;
  p95Ms:        number;
  p99Ms:        number;
}

// ── In-memory region state ─────────────────────────────────────────────────────

const REGIONS: Record<RegionCode, RegionInfo> = {
  "us-east": {
    code: "us-east", name: "US East (Virginia)", location: "iad",
    tier: "primary", status: "healthy",
    latencyMs: null, requestCount: 0, errorCount: 0, p50Ms: 0, p95Ms: 0, p99Ms: 0,
  },
  "us-west": {
    code: "us-west", name: "US West (California)", location: "lax",
    tier: "replica", status: "healthy",
    latencyMs: null, requestCount: 0, errorCount: 0, p50Ms: 0, p95Ms: 0, p99Ms: 0,
  },
  "eu-west": {
    code: "eu-west", name: "Europe West (Frankfurt)", location: "fra",
    tier: "replica", status: "healthy",
    latencyMs: null, requestCount: 0, errorCount: 0, p50Ms: 0, p95Ms: 0, p99Ms: 0,
  },
  "ap-southeast": {
    code: "ap-southeast", name: "Asia Pacific (Singapore)", location: "sin",
    tier: "replica", status: "healthy",
    latencyMs: null, requestCount: 0, errorCount: 0, p50Ms: 0, p95Ms: 0, p99Ms: 0,
  },
  "latam": {
    code: "latam", name: "Latin America (São Paulo)", location: "gru",
    tier: "replica", status: "healthy",
    latencyMs: null, requestCount: 0, errorCount: 0, p50Ms: 0, p95Ms: 0, p99Ms: 0,
  },
};

// Detect current serving region from env (set by deployment platform)
const SERVING_REGION: RegionCode =
  (process.env["FLY_REGION"] as RegionCode) ??
  (process.env["NEXUS_REGION"] as RegionCode) ??
  "us-east";

// Tenant → region assignments (backed by persistent store in production; in-memory here)
const tenantRegions = new Map<string, RegionCode>();

// Per-region latency samples (ring buffer, last 1000 per region)
const latencySamples = new Map<RegionCode, number[]>();
for (const r of Object.keys(REGIONS) as RegionCode[]) latencySamples.set(r, []);

// ── Percentile helper ──────────────────────────────────────────────────────────

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

function recordLatency(region: RegionCode, ms: number): void {
  const info = REGIONS[region];
  if (!info) return;
  info.requestCount++;
  const samples = latencySamples.get(region)!;
  samples.push(ms);
  if (samples.length > 1000) samples.shift();
  const sorted = [...samples].sort((a, b) => a - b);
  info.p50Ms = percentile(sorted, 50);
  info.p95Ms = percentile(sorted, 95);
  info.p99Ms = percentile(sorted, 99);
  info.latencyMs = sorted[sorted.length - 1]; // last measured
}

// ── Synthetic latency probes (simulates inter-region round-trips in dev) ───────
// In production, replace with real DB ping probes to each region's replica.

const SYNTHETIC_BASE: Record<RegionCode, number> = {
  "us-east":    12,
  "us-west":    65,
  "eu-west":    88,
  "ap-southeast": 192,
  "latam":     145,
};

function probeRegions(): void {
  for (const [code, info] of Object.entries(REGIONS) as [RegionCode, RegionInfo][]) {
    const base = SYNTHETIC_BASE[code] ?? 100;
    // Add ±20% jitter
    const jitter = base * 0.2 * (Math.random() * 2 - 1);
    const measured = Math.max(1, Math.round(base + jitter));
    info.latencyMs = measured;
    recordLatency(code, measured);
  }
}

// Probe on start and every 30s
probeRegions();
setInterval(probeRegions, 30_000).unref();

// ── Request stamping middleware ────────────────────────────────────────────────

export function regionMiddleware(req: Request, res: Response, next: NextFunction): void {
  const start = performance.now();

  // Stamp the serving region
  res.setHeader("X-Nexus-Region", SERVING_REGION);
  res.setHeader("X-Nexus-Served-By", os.hostname());

  // Determine tenant's home region (from token or query param in dev)
  const tenantId = (req.headers["x-nexus-tenant"] as string) ?? req.query["tenant_id"] as string;
  if (tenantId) {
    const homeRegion = tenantRegions.get(tenantId);
    if (homeRegion && homeRegion !== SERVING_REGION) {
      res.setHeader("X-Nexus-Home-Region", homeRegion);
      res.setHeader("X-Nexus-Region-Affinity", "miss");
    } else {
      res.setHeader("X-Nexus-Region-Affinity", "hit");
    }
  }

  res.on("finish", () => {
    const elapsed = performance.now() - start;
    REGIONS[SERVING_REGION].requestCount++;
    if (res.statusCode >= 500) REGIONS[SERVING_REGION].errorCount++;
    recordLatency(SERVING_REGION, elapsed);
  });

  next();
}

// ── Routes ─────────────────────────────────────────────────────────────────────

const router = Router();

/** GET /nexus/regions — all regions with health + latency */
router.get("/nexus/regions", (_req, res) => {
  const regions = Object.values(REGIONS).map((r) => ({
    ...r,
    isCurrent: r.code === SERVING_REGION,
  }));
  res.json({
    serving: SERVING_REGION,
    regions,
    summary: {
      healthy:  regions.filter((r) => r.status === "healthy").length,
      degraded: regions.filter((r) => r.status === "degraded").length,
      offline:  regions.filter((r) => r.status === "offline").length,
    },
  });
});

/** GET /nexus/regions/tenant/:tenantId */
router.get("/nexus/regions/tenant/:tenantId", (req, res) => {
  const { tenantId } = req.params;
  const region = tenantRegions.get(tenantId) ?? SERVING_REGION;
  res.json({ tenantId, region, isDefault: !tenantRegions.has(tenantId) });
});

/**
 * POST /nexus/regions/assign
 * Body: { tenantId, region }
 */
router.post("/nexus/regions/assign", (req, res) => {
  const { tenantId, region } = req.body as { tenantId: string; region: RegionCode };
  if (!tenantId || !region || !REGIONS[region]) {
    return res.status(400).json({ error: "tenantId and valid region required" });
  }
  tenantRegions.set(tenantId, region);
  res.json({ ok: true, tenantId, region });
});

/** GET /nexus/regions/affinity — full routing table */
router.get("/nexus/regions/affinity", (_req, res) => {
  const table = Array.from(tenantRegions.entries()).map(([tenantId, region]) => ({
    tenantId,
    homeRegion: region,
    servingRegion: SERVING_REGION,
    affinityHit: region === SERVING_REGION,
    latencyMs: REGIONS[region]?.latencyMs ?? null,
  }));
  res.json({
    serving: SERVING_REGION,
    routingTable: table,
    totalTenants: table.length,
    affinityHits: table.filter((t) => t.affinityHit).length,
  });
});

export const regionRouter = router;
export { REGIONS, SERVING_REGION, tenantRegions };
