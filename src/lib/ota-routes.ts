/**
 * Nexus POS — OTA Update Routes
 *
 * Endpoints:
 *   GET  /api/nexus/ota/manifest           — latest published version manifest
 *   POST /api/nexus/ota/check              — device checks current versions, gets update plan
 *   POST /api/nexus/ota/report             — device reports update outcome
 *   GET  /api/nexus/ota/history/:deviceId  — update history for a device
 *   POST /api/nexus/ota/releases           — admin: publish a new release
 *   GET  /api/nexus/ota/releases           — admin: list all releases
 *   POST /api/nexus/ota/rollback/:deviceId — admin: force-rollback a device
 */

import { Router } from "express";
import crypto from "node:crypto";

const router = Router();

// ── Types ────────────────────────────────────────────────────────────────────

export interface PluginVersion {
  id: string;
  version: string;
  minCompatible: string;
}

export interface VersionManifest {
  id: string;
  app: {
    version: string;
    buildNumber: number;
    minCompatible: string;
    releaseNotes: string;
    critical: boolean;
    downloadUrl?: string;
  };
  syncEngine: {
    version: string;
    minCompatible: string;
  };
  plugins: PluginVersion[];
  releasedAt: string;
  releasedBy: string;
  checksums: Record<string, string>;
}

export interface DeviceUpdateState {
  deviceId: string;
  currentAppVersion: string;
  currentBuildNumber: number;
  currentSyncVersion: string;
  currentPlugins: Record<string, string>;
  lastCheckedAt: string;
  lastUpdatedAt?: string;
  pendingManifestId?: string;
  status: "up_to_date" | "update_available" | "updating" | "failed" | "rolled_back";
  failureCount: number;
  rollbackManifestId?: string;
}

export interface UpdateReport {
  deviceId: string;
  manifestId: string;
  success: boolean;
  error?: string;
  appVersion?: string;
  buildNumber?: number;
  checksumValid?: boolean;
}

// ── In-Memory Store (TTL-backed by periodic GC in production, use DB for real) ─

const manifests = new Map<string, VersionManifest>();
const deviceStates = new Map<string, DeviceUpdateState>();
const updateHistory = new Map<string, UpdateReport[]>();

// ── Seed a v1.0.0 baseline release ───────────────────────────────────────────

function makeManifestId() {
  return `manifest_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
}

function computeChecksum(data: object): string {
  return crypto.createHash("sha256").update(JSON.stringify(data)).digest("hex");
}

const BASELINE: Omit<VersionManifest, "id" | "checksums"> = {
  app: {
    version: "1.0.0",
    buildNumber: 1,
    minCompatible: "1.0.0",
    releaseNotes: "Initial release",
    critical: false,
  },
  syncEngine: { version: "1.0.0", minCompatible: "1.0.0" },
  plugins: [
    { id: "printer.ip",       version: "1.0.0", minCompatible: "1.0.0" },
    { id: "printer.sdk",      version: "1.0.0", minCompatible: "1.0.0" },
    { id: "payment.terminal", version: "1.0.0", minCompatible: "1.0.0" },
    { id: "scanner.barcode",  version: "1.0.0", minCompatible: "1.0.0" },
  ],
  releasedAt: new Date().toISOString(),
  releasedBy: "system",
};

const BASELINE_ID = makeManifestId();
const BASELINE_MANIFEST: VersionManifest = {
  id: BASELINE_ID,
  ...BASELINE,
  checksums: { manifest: computeChecksum({ id: BASELINE_ID, ...BASELINE }) },
};
manifests.set(BASELINE_ID, BASELINE_MANIFEST);

let latestManifestId = BASELINE_ID;

// ── Helpers ───────────────────────────────────────────────────────────────────

function semverGt(a: string, b: string): boolean {
  const parse = (v: string) => v.split(".").map(Number);
  const [am, an, ap] = parse(a);
  const [bm, bn, bp] = parse(b);
  if (am !== bm) return am > bm;
  if (an !== bn) return an > bn;
  return ap > bp;
}

function getLatestManifest(): VersionManifest | undefined {
  return manifests.get(latestManifestId);
}

function getOrCreateDeviceState(deviceId: string): DeviceUpdateState {
  if (!deviceStates.has(deviceId)) {
    deviceStates.set(deviceId, {
      deviceId,
      currentAppVersion: "0.0.0",
      currentBuildNumber: 0,
      currentSyncVersion: "0.0.0",
      currentPlugins: {},
      lastCheckedAt: new Date().toISOString(),
      status: "up_to_date",
      failureCount: 0,
    });
  }
  return deviceStates.get(deviceId)!;
}

// ── Routes ────────────────────────────────────────────────────────────────────

/** GET /api/nexus/ota/manifest — latest published version manifest */
router.get("/nexus/ota/manifest", (_req, res) => {
  const manifest = getLatestManifest();
  if (!manifest) return res.status(503).json({ error: "No manifest available" });
  res.json(manifest);
});

/**
 * POST /api/nexus/ota/check
 * Body: { deviceId, tenantId, app, buildNumber, syncEngine, plugins }
 * Response: { upToDate, updateAvailable, manifest?, critical }
 */
router.post("/nexus/ota/check", (req, res) => {
  const { deviceId, app, buildNumber, syncEngine, plugins = {} } = req.body as {
    deviceId: string;
    tenantId?: string;
    app: string;
    buildNumber: number;
    syncEngine: string;
    plugins: Record<string, string>;
  };

  if (!deviceId || !app) {
    return res.status(400).json({ error: "deviceId and app version required" });
  }

  const state = getOrCreateDeviceState(deviceId);
  state.currentAppVersion  = app;
  state.currentBuildNumber = buildNumber ?? 0;
  state.currentSyncVersion = syncEngine ?? "0.0.0";
  state.currentPlugins     = plugins;
  state.lastCheckedAt      = new Date().toISOString();

  const latest = getLatestManifest();
  if (!latest) {
    deviceStates.set(deviceId, state);
    return res.json({ upToDate: true, updateAvailable: false });
  }

  const appNeedsUpdate    = semverGt(latest.app.version, app);
  const engineNeedsUpdate = semverGt(latest.syncEngine.version, syncEngine ?? "0.0.0");
  const pluginUpdates     = latest.plugins.filter(
    (p) => !plugins[p.id] || semverGt(p.version, plugins[p.id])
  );

  const updateAvailable = appNeedsUpdate || engineNeedsUpdate || pluginUpdates.length > 0;

  if (updateAvailable) {
    state.status          = "update_available";
    state.pendingManifestId = latest.id;
  }

  deviceStates.set(deviceId, state);

  res.json({
    upToDate:      !updateAvailable,
    updateAvailable,
    critical:      updateAvailable && latest.app.critical,
    manifest:      updateAvailable ? latest : undefined,
    delta: {
      app:     appNeedsUpdate    ? { from: app,       to: latest.app.version }      : null,
      engine:  engineNeedsUpdate ? { from: syncEngine, to: latest.syncEngine.version } : null,
      plugins: pluginUpdates.map((p) => ({
        id: p.id, from: plugins[p.id] ?? "none", to: p.version,
      })),
    },
  });
});

/**
 * POST /api/nexus/ota/report
 * Device reports update outcome after attempting to apply
 */
router.post("/nexus/ota/report", (req, res) => {
  const report = req.body as UpdateReport;
  if (!report.deviceId || !report.manifestId) {
    return res.status(400).json({ error: "deviceId and manifestId required" });
  }

  const state = getOrCreateDeviceState(report.deviceId);
  const history = updateHistory.get(report.deviceId) ?? [];

  history.unshift({ ...report, });
  // Keep last 20 entries
  updateHistory.set(report.deviceId, history.slice(0, 20));

  if (report.success) {
    state.status            = "up_to_date";
    state.failureCount      = 0;
    state.lastUpdatedAt     = new Date().toISOString();
    state.pendingManifestId = undefined;
    if (report.appVersion)   state.currentAppVersion  = report.appVersion;
    if (report.buildNumber)  state.currentBuildNumber = report.buildNumber;
  } else {
    state.failureCount += 1;
    state.status = state.failureCount >= 3 ? "rolled_back" : "failed";
    // Record rollback point
    state.rollbackManifestId = state.pendingManifestId;
    state.pendingManifestId  = undefined;
  }

  deviceStates.set(report.deviceId, state);
  res.json({ ok: true, deviceStatus: state.status });
});

/** GET /api/nexus/ota/history/:deviceId */
router.get("/nexus/ota/history/:deviceId", (req, res) => {
  const { deviceId } = req.params;
  const history  = updateHistory.get(deviceId) ?? [];
  const state    = deviceStates.get(deviceId);
  res.json({ deviceId, state: state ?? null, history });
});

/** GET /api/nexus/ota/devices — all device update states */
router.get("/nexus/ota/devices", (_req, res) => {
  const latest = getLatestManifest();
  const devices = Array.from(deviceStates.values()).map((d) => ({
    ...d,
    upToDate: latest ? !semverGt(latest.app.version, d.currentAppVersion) : true,
  }));
  res.json({ devices, latestManifestId, latest });
});

/**
 * POST /api/nexus/ota/releases — publish a new release
 * Body: { app, syncEngine, plugins, releaseNotes, critical, releasedBy, downloadUrl }
 */
router.post("/nexus/ota/releases", (req, res) => {
  const { app, syncEngine, plugins, releaseNotes, critical, releasedBy, downloadUrl } = req.body as {
    app: { version: string; buildNumber: number; minCompatible?: string; downloadUrl?: string };
    syncEngine: { version: string; minCompatible?: string };
    plugins?: PluginVersion[];
    releaseNotes?: string;
    critical?: boolean;
    releasedBy?: string;
    downloadUrl?: string;
  };

  if (!app?.version || !syncEngine?.version) {
    return res.status(400).json({ error: "app.version and syncEngine.version required" });
  }

  const id = makeManifestId();
  const body: Omit<VersionManifest, "id" | "checksums"> = {
    app: {
      version:       app.version,
      buildNumber:   app.buildNumber ?? 1,
      minCompatible: app.minCompatible ?? app.version,
      releaseNotes:  releaseNotes ?? "",
      critical:      critical ?? false,
      downloadUrl:   downloadUrl ?? app.downloadUrl,
    },
    syncEngine: {
      version:       syncEngine.version,
      minCompatible: syncEngine.minCompatible ?? syncEngine.version,
    },
    plugins: plugins ?? BASELINE.plugins,
    releasedAt: new Date().toISOString(),
    releasedBy: releasedBy ?? "admin",
  };

  const manifest: VersionManifest = {
    id,
    ...body,
    checksums: { manifest: computeChecksum({ id, ...body }) },
  };

  manifests.set(id, manifest);
  latestManifestId = id;

  res.status(201).json(manifest);
});

/** GET /api/nexus/ota/releases — list all releases (newest first) */
router.get("/nexus/ota/releases", (_req, res) => {
  const all = Array.from(manifests.values()).sort(
    (a, b) => new Date(b.releasedAt).getTime() - new Date(a.releasedAt).getTime()
  );
  res.json({ releases: all, latestManifestId });
});

/**
 * POST /api/nexus/ota/rollback/:deviceId — admin: force device to prior manifest
 */
router.post("/nexus/ota/rollback/:deviceId", (req, res) => {
  const { deviceId } = req.params;
  const state = deviceStates.get(deviceId);
  if (!state) return res.status(404).json({ error: "Device not found" });

  const targetId = req.body?.manifestId ?? state.rollbackManifestId;
  const target   = targetId ? manifests.get(targetId) : undefined;

  state.status            = "rolled_back";
  state.pendingManifestId = targetId;
  deviceStates.set(deviceId, state);

  res.json({ ok: true, deviceId, rollbackManifestId: targetId, manifest: target ?? null });
});

export const otaRouter = router;
