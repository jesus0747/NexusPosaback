// ─── Provisioning Routes — Device QR Provisioning ────────────────────────────
//
// Enables zero-touch device provisioning via QR code or permanent device token.
//
// Flow A — QR (recommended):
//   1. Admin calls POST /api/nexus/provision/generate
//      → Backend creates short-lived provisioning token + returns QR payload
//   2. Tablet scans QR code
//   3. Tablet calls POST /api/nexus/provision/activate with the token key
//      → Backend registers device + returns device token + location info
//   4. Tablet is fully provisioned — no manual input required
//
// Flow B — Manual token:
//   1. Admin creates device via DevicesTab (POST /nexus/locations/:id/devices)
//      → Gets a one-time permanent device token
//   2. Admin gives token + backend URL to user
//   3. Tablet calls POST /api/nexus/provision/pair-by-token
//      → Backend returns device info + location name — device is paired
//
// Routes (all under /api prefix via routes index):
//   POST /nexus/provision/generate       — admin: generate QR provisioning token
//   POST /nexus/provision/activate       — device: activate QR token → device token + location info
//   POST /nexus/provision/pair-by-token  — device: pair using permanent device token
//   GET  /nexus/provision/tokens         — admin: list active tokens
//   DELETE /nexus/provision/tokens/:id   — admin: revoke token
//
// Token storage: in-memory Map (TTL: 30 minutes).
// Production note: replace with DB table for multi-instance deployments.

import { Router } from "express";
import crypto from "node:crypto";
import { db } from "@workspace/db";
import { nexusDevices, nexusTenants } from "@workspace/db/schema";
import { eq } from "drizzle-orm";

export const provisioningRouter = Router();

// ─── Token Store (in-memory, TTL 30 min) ─────────────────────────────────────

export type DeviceRole = "POS" | "KDS" | "BAR" | "HOST" | "ADMIN_DISPLAY" | "TABLET";

export interface ProvisionToken {
  id: string;
  tenantId: string;      // location_id / tenant_id
  locationId?: string;   // explicit location_id if provided
  role: DeviceRole;
  label: string;
  createdAt: number;
  expiresAt: number;
  activatedAt?: number;
  activatedDeviceId?: string;
}

const TOKEN_TTL_MS = 30 * 60 * 1_000; // 30 minutes
const tokenStore = new Map<string, ProvisionToken>();

// Cleanup expired tokens every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [id, token] of tokenStore) {
    if (token.expiresAt < now) tokenStore.delete(id);
  }
}, 5 * 60 * 1_000);

// ─── Helper: fetch location name/address ─────────────────────────────────────

async function getLocationInfo(tenantId: string): Promise<{ name: string; address: string | null }> {
  const rows = await db
    .select({ name: nexusTenants.name, address: nexusTenants.address })
    .from(nexusTenants)
    .where(eq(nexusTenants.tenant_id, tenantId))
    .limit(1);
  return rows[0] ?? { name: tenantId, address: null };
}

// ─── POST /nexus/provision/generate ──────────────────────────────────────────
// Admin endpoint — generates a short-lived QR provisioning token

provisioningRouter.post("/nexus/provision/generate", async (req, res) => {
  const { tenant_id, location_id, role = "POS", label = "", backend_url } = req.body as {
    tenant_id?: string;
    location_id?: string;
    role?: DeviceRole;
    label?: string;
    backend_url?: string;
  };

  const effectiveTenantId = location_id ?? tenant_id;

  if (!effectiveTenantId) {
    res.status(400).json({ error: "tenant_id or location_id is required" });
    return;
  }

  const validRoles: DeviceRole[] = ["POS", "KDS", "BAR", "HOST", "ADMIN_DISPLAY", "TABLET"];
  if (!validRoles.includes(role)) {
    res.status(400).json({ error: `role must be one of: ${validRoles.join(", ")}` });
    return;
  }

  const tokenId = crypto.randomBytes(16).toString("hex");
  const now = Date.now();

  const token: ProvisionToken = {
    id: tokenId,
    tenantId: effectiveTenantId,
    locationId: location_id ?? tenant_id,
    role,
    label: label || `${role} Terminal`,
    createdAt: now,
    expiresAt: now + TOKEN_TTL_MS,
  };

  tokenStore.set(tokenId, token);

  // QR payload — compact keys to keep QR code density low
  const qrPayload = {
    v: 1,                          // version
    t: effectiveTenantId,          // tenantId / locationId
    b: backend_url ?? "",          // backendUrl (filled in by admin panel)
    r: role,                       // role
    k: tokenId,                    // provisioning key
    n: token.label,                // device name/label
  };

  res.json({
    token_id: tokenId,
    expires_at: new Date(token.expiresAt).toISOString(),
    expires_in_seconds: Math.floor(TOKEN_TTL_MS / 1000),
    qr_payload: qrPayload,
    qr_string: JSON.stringify(qrPayload),
  });
});

// ─── POST /nexus/provision/activate ──────────────────────────────────────────
// Device endpoint — called after scanning QR code; returns location info

provisioningRouter.post("/nexus/provision/activate", async (req, res) => {
  const { token_key, device_id, device_name } = req.body as {
    token_key?: string;
    device_id?: string;
    device_name?: string;
  };

  if (!token_key || !device_id) {
    res.status(400).json({ error: "token_key and device_id are required" });
    return;
  }

  const token = tokenStore.get(token_key);

  if (!token) {
    res.status(404).json({ error: "Provisioning token not found or already used" });
    return;
  }

  if (token.expiresAt < Date.now()) {
    tokenStore.delete(token_key);
    res.status(410).json({ error: "Provisioning token expired. Generate a new QR code." });
    return;
  }

  if (token.activatedAt) {
    res.status(409).json({ error: "Provisioning token already used" });
    return;
  }

  const deviceToken = crypto.randomBytes(32).toString("hex");
  const finalName = device_name || token.label;
  const locationId = token.locationId ?? token.tenantId;

  try {
    // Upsert device
    const existing = await db
      .select({ device_id: nexusDevices.device_id })
      .from(nexusDevices)
      .where(eq(nexusDevices.device_id, device_id))
      .limit(1);

    if (existing.length > 0) {
      await db
        .update(nexusDevices)
        .set({ token: deviceToken, name: finalName, tenant_id: token.tenantId, location_id: locationId, type: token.role })
        .where(eq(nexusDevices.device_id, device_id));
    } else {
      await db.insert(nexusDevices).values({
        device_id,
        tenant_id: token.tenantId,
        location_id: locationId,
        name: finalName,
        token: deviceToken,
        type: token.role,
      });
    }

    // Mark token as used
    token.activatedAt = Date.now();
    token.activatedDeviceId = device_id;

    // Fetch location info
    const loc = await getLocationInfo(locationId);

    res.json({
      ok: true,
      device_token: deviceToken,
      tenant_id: token.tenantId,
      location_id: locationId,
      location_name: loc.name,
      location_address: loc.address,
      device_id,
      device_name: finalName,
      role: token.role,
      provisioned_at: new Date().toISOString(),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Database error";
    res.status(500).json({ error: message });
  }
});

// ─── POST /nexus/provision/pair-by-token ─────────────────────────────────────
// Device endpoint — pair using the permanent device token from DevicesTab.
// The admin creates a device in the customer panel, copies the one-time token,
// and gives it to the user who enters it manually on the Android device.

provisioningRouter.post("/nexus/provision/pair-by-token", async (req, res) => {
  const { device_token } = req.body as { device_token?: string };

  if (!device_token) {
    res.status(400).json({ error: "device_token is required" });
    return;
  }

  const rows = await db
    .select()
    .from(nexusDevices)
    .where(eq(nexusDevices.token, device_token))
    .limit(1);

  if (!rows.length || !rows[0].active) {
    res.status(404).json({ error: "Device token not found or device is inactive" });
    return;
  }

  const device = rows[0];
  const locationId = device.location_id ?? device.tenant_id;

  // Fetch location name/address
  const loc = await getLocationInfo(locationId);

  // Update last_seen_at
  await db
    .update(nexusDevices)
    .set({ last_seen_at: new Date() })
    .where(eq(nexusDevices.device_id, device.device_id));

  res.json({
    ok: true,
    device_token: device.token,
    tenant_id: device.tenant_id,
    location_id: locationId,
    location_name: loc.name,
    location_address: loc.address,
    device_id: device.device_id,
    device_name: device.name,
    role: device.type,
  });
});

// ─── GET /nexus/provision/tokens ─────────────────────────────────────────────
// Admin: list all active (non-expired) provisioning tokens

provisioningRouter.get("/nexus/provision/tokens", async (req, res) => {
  const { tenant_id } = req.query as { tenant_id?: string };
  const now = Date.now();

  const tokens = [...tokenStore.values()]
    .filter((t) => t.expiresAt > now && (!tenant_id || t.tenantId === tenant_id))
    .map((t) => ({
      id: t.id,
      tenant_id: t.tenantId,
      location_id: t.locationId,
      role: t.role,
      label: t.label,
      created_at: new Date(t.createdAt).toISOString(),
      expires_at: new Date(t.expiresAt).toISOString(),
      activated: !!t.activatedAt,
      activated_device_id: t.activatedDeviceId,
    }));

  res.json({ tokens });
});

// ─── DELETE /nexus/provision/tokens/:id ──────────────────────────────────────
// Admin: revoke a provisioning token

provisioningRouter.delete("/nexus/provision/tokens/:id", async (req, res) => {
  const { id } = req.params;
  const existed = tokenStore.delete(id);
  res.json({ ok: existed, message: existed ? "Token revoked" : "Token not found" });
});

// ─── GET /nexus/provision/devices ────────────────────────────────────────────
// Admin: list all provisioned devices, optionally filtered by account_id or tenant_id.
// Joins nexus_tenants so the location name is included.

provisioningRouter.get("/nexus/provision/devices", async (req, res) => {
  try {
    const { account_id, tenant_id } = req.query as { account_id?: string; tenant_id?: string };

    let rows = await db
      .select({
        device_id:     nexusDevices.device_id,
        name:          nexusDevices.name,
        type:          nexusDevices.type,
        tenant_id:     nexusDevices.tenant_id,
        location_id:   nexusDevices.location_id,
        account_id:    nexusDevices.account_id,
        active:        nexusDevices.active,
        registered_at: nexusDevices.registered_at,
        last_seen_at:  nexusDevices.last_seen_at,
        location_name: nexusTenants.name,
      })
      .from(nexusDevices)
      .leftJoin(nexusTenants, eq(nexusTenants.tenant_id, nexusDevices.tenant_id));

    if (account_id) {
      rows = rows.filter((r) => r.account_id === account_id);
    }
    if (tenant_id) {
      rows = rows.filter((r) => r.tenant_id === tenant_id || r.location_id === tenant_id);
    }

    res.json({ devices: rows });
  } catch (e: unknown) {
    res.status(500).json({ error: "Failed to list devices", detail: String(e) });
  }
});

// ─── DELETE /nexus/provision/devices/:deviceId ────────────────────────────────
// Admin: permanently decommission a provisioned device.

provisioningRouter.delete("/nexus/provision/devices/:deviceId", async (req, res) => {
  try {
    const { deviceId } = req.params;
    await db.delete(nexusDevices).where(eq(nexusDevices.device_id, deviceId));
    res.json({ ok: true });
  } catch (e: unknown) {
    res.status(500).json({ error: "Failed to delete device", detail: String(e) });
  }
});

// ─── GET /nexus/device/heartbeat ─────────────────────────────────────────────
// Device startup check — verifies stored credentials are still valid.
// Called by SetupContext on every app launch when the device thinks it's
// configured. Returns 200 if the token matches an active device in the DB,
// 401 if not found (device was deleted / DB was wiped).
//
// Auth: Bearer token in Authorization header (the stored device_token).

provisioningRouter.get("/nexus/device/heartbeat", async (req, res) => {
  try {
    const auth = req.headers.authorization ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";

    if (!token) {
      res.status(401).json({ ok: false, error: "Missing device token" });
      return;
    }

    const [device] = await db
      .select({ device_id: nexusDevices.device_id, name: nexusDevices.name, active: nexusDevices.active })
      .from(nexusDevices)
      .where(eq(nexusDevices.token, token))
      .limit(1);

    if (!device) {
      res.status(401).json({ ok: false, error: "Device not registered" });
      return;
    }

    if (!device.active) {
      res.status(403).json({ ok: false, error: "Device is deactivated" });
      return;
    }

    res.json({ ok: true, device_id: device.device_id, name: device.name });
  } catch (e: unknown) {
    res.status(500).json({ error: "Heartbeat check failed", detail: String(e) });
  }
});
