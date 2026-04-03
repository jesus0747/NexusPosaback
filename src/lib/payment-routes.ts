// ─── FASE 20: Payment Processor Routes ───────────────────────────────────────
//
// Platform Admin endpoints (X-Admin-Key required):
//   GET  /nexus/admin/processors                 — list all platform processors
//   PUT  /nexus/admin/processors/:id             — enable/disable a processor
//   POST /nexus/admin/processors/seed            — seed default processors
//   GET  /nexus/admin/payment-health             — all locations payment status
//
// Account/Location endpoints:
//   GET  /nexus/locations/:locationId/payment-config        — get config (no secret)
//   PUT  /nexus/locations/:locationId/payment-config        — save + auto test connection
//   POST /nexus/locations/:locationId/payment-config/test   — re-test connection
//   DELETE /nexus/locations/:locationId/payment-config      — remove config
//

import { Router, type IRouter } from "express";
import { z } from "zod";
import { db } from "@workspace/db";
import {
  nexusPaymentConfigs,
  nexusPlatformProcessors,
  nexusTenants,
} from "@workspace/db/schema";
import { eq, inArray } from "drizzle-orm";
import crypto from "node:crypto";

const router: IRouter = Router();

// ─── Vault encryption (AES-256-GCM) ──────────────────────────────────────────

const VAULT_KEY_HEX = process.env.PAYMENT_VAULT_KEY ?? "0".repeat(64); // 32 bytes
const VAULT_KEY = Buffer.from(VAULT_KEY_HEX, "hex");

function encryptSecret(plaintext: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", VAULT_KEY, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("hex")}:${tag.toString("hex")}:${encrypted.toString("hex")}`;
}

function decryptSecret(stored: string): string {
  const [ivHex, tagHex, dataHex] = stored.split(":");
  const iv = Buffer.from(ivHex, "hex");
  const tag = Buffer.from(tagHex, "hex");
  const data = Buffer.from(dataHex, "hex");
  const decipher = crypto.createDecipheriv("aes-256-gcm", VAULT_KEY, iv);
  decipher.setAuthTag(tag);
  return decipher.update(data).toString("utf8") + decipher.final("utf8");
}

// ─── Connection test adapters ─────────────────────────────────────────────────

type TestResult = { status: "connected" | "invalid_credentials" | "unreachable"; message: string };

async function testStripe(secretKey: string): Promise<TestResult> {
  try {
    const res = await fetch("https://api.stripe.com/v1/balance", {
      headers: { Authorization: `Bearer ${secretKey}` },
      signal: AbortSignal.timeout(8000),
    });
    if (res.status === 200) return { status: "connected", message: "Balance endpoint OK" };
    if (res.status === 401) return { status: "invalid_credentials", message: "Invalid API key" };
    return { status: "unreachable", message: `Unexpected status: ${res.status}` };
  } catch (e: unknown) {
    return { status: "unreachable", message: e instanceof Error ? e.message : "Network error" };
  }
}

async function testSquare(secretKey: string): Promise<TestResult> {
  try {
    const res = await fetch("https://connect.squareup.com/v2/merchants/me", {
      headers: { Authorization: `Bearer ${secretKey}`, "Square-Version": "2024-01-18" },
      signal: AbortSignal.timeout(8000),
    });
    if (res.status === 200) return { status: "connected", message: "Merchant endpoint OK" };
    if (res.status === 401) return { status: "invalid_credentials", message: "Invalid access token" };
    return { status: "unreachable", message: `Unexpected status: ${res.status}` };
  } catch (e: unknown) {
    return { status: "unreachable", message: e instanceof Error ? e.message : "Network error" };
  }
}

async function testAdyen(secretKey: string): Promise<TestResult> {
  try {
    const res = await fetch("https://management-test.adyen.com/v3/companies", {
      headers: {
        "X-API-Key": secretKey,
        "Content-Type": "application/json",
      },
      signal: AbortSignal.timeout(8000),
    });
    if (res.status === 200) return { status: "connected", message: "Management API OK" };
    if (res.status === 401 || res.status === 403) return { status: "invalid_credentials", message: "Invalid API key" };
    return { status: "unreachable", message: `Unexpected status: ${res.status}` };
  } catch (e: unknown) {
    return { status: "unreachable", message: e instanceof Error ? e.message : "Network error" };
  }
}

async function testClover(secretKey: string): Promise<TestResult> {
  try {
    const res = await fetch(`https://sandbox.dev.clover.com/v3/merchants/me`, {
      headers: { Authorization: `Bearer ${secretKey}` },
      signal: AbortSignal.timeout(8000),
    });
    if (res.status === 200) return { status: "connected", message: "Merchant endpoint OK" };
    if (res.status === 401) return { status: "invalid_credentials", message: "Invalid access token" };
    return { status: "unreachable", message: `Unexpected status: ${res.status}` };
  } catch (e: unknown) {
    return { status: "unreachable", message: e instanceof Error ? e.message : "Network error" };
  }
}

async function testConnection(processor: string, secretKey: string): Promise<TestResult> {
  if (!secretKey) return { status: "invalid_credentials", message: "No secret key provided" };
  switch (processor) {
    case "stripe":  return testStripe(secretKey);
    case "square":  return testSquare(secretKey);
    case "adyen":   return testAdyen(secretKey);
    case "clover":  return testClover(secretKey);
    case "custom":  return { status: "connected", message: "Custom processor — credentials accepted" };
    default:        return { status: "unreachable", message: "Unknown processor" };
  }
}

// ─── Admin-only gate (X-Admin-Key header) ─────────────────────────────────────

const ADMIN_KEY = process.env.ADMIN_SECRET_KEY ?? "nexus-admin-dev-key";

function requireAdminKey(req: Parameters<Parameters<typeof router.use>[0]>[0], res: Parameters<Parameters<typeof router.use>[0]>[1]): boolean {
  const key = req.headers["x-admin-key"] as string | undefined;
  if (key !== ADMIN_KEY) {
    res.status(401).json({ error: "Admin key required" });
    return false;
  }
  return true;
}

// ─── Default processor catalog ────────────────────────────────────────────────

const DEFAULT_PROCESSORS = [
  { processor_id: "stripe",  label: "Stripe",  description: "Industry-leading payment gateway with card-present and online support",  enabled: true },
  { processor_id: "adyen",   label: "Adyen",   description: "Global payments platform with advanced in-person terminal support",       enabled: true },
  { processor_id: "square",  label: "Square",  description: "All-in-one point of sale with integrated hardware and software",          enabled: true },
  { processor_id: "clover",  label: "Clover",  description: "Feature-rich POS platform with extensive app marketplace",                enabled: true },
  { processor_id: "custom",  label: "Custom",  description: "Bring your own payment processor via SDK or REST API integration",         enabled: true },
];

// ─── Platform Admin: seed processors ─────────────────────────────────────────

router.post("/nexus/admin/processors/seed", async (req, res) => {
  if (!requireAdminKey(req, res)) return;
  try {
    for (const p of DEFAULT_PROCESSORS) {
      await db.insert(nexusPlatformProcessors).values(p).onConflictDoNothing();
    }
    const rows = await db.select().from(nexusPlatformProcessors);
    res.json({ seeded: rows.length, processors: rows });
  } catch (e: unknown) {
    res.status(500).json({ error: "Seed failed", detail: String(e) });
  }
});

// ─── Platform Admin: list processors ─────────────────────────────────────────

router.get("/nexus/admin/processors", async (req, res) => {
  if (!requireAdminKey(req, res)) return;
  try {
    const rows = await db.select().from(nexusPlatformProcessors).orderBy(nexusPlatformProcessors.label);
    res.json({ processors: rows });
  } catch (e: unknown) {
    res.status(500).json({ error: "Failed to fetch processors", detail: String(e) });
  }
});

// ─── Platform Admin: create processor ────────────────────────────────────────

router.post("/nexus/admin/processors", async (req, res) => {
  if (!requireAdminKey(req, res)) return;
  const body = z.object({
    label:        z.string().min(1),
    api_endpoint: z.string().optional(),
  }).parse(req.body);
  try {
    const id = "custom-" + body.label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")
      + "-" + Date.now().toString(36);
    await db.insert(nexusPlatformProcessors).values({
      processor_id: id,
      label:        body.label,
      api_endpoint: body.api_endpoint ?? null,
      enabled:      true,
      is_custom:    true,
      description:  null,
    });
    const [row] = await db.select().from(nexusPlatformProcessors).where(eq(nexusPlatformProcessors.processor_id, id));
    res.status(201).json({ processor: row });
  } catch (e: unknown) {
    res.status(500).json({ error: "Create failed", detail: String(e) });
  }
});

// ─── Platform Admin: enable/disable or update processor ───────────────────────

router.put("/nexus/admin/processors/:id", async (req, res) => {
  if (!requireAdminKey(req, res)) return;
  const { id } = req.params;
  const body = z.object({
    enabled:      z.boolean().optional(),
    label:        z.string().optional(),
    description:  z.string().optional(),
    api_endpoint: z.string().optional().nullable(),
  }).parse(req.body);
  try {
    const updates: Record<string, unknown> = { updated_at: new Date() };
    if (body.enabled !== undefined) updates.enabled = body.enabled;
    if (body.label)                 updates.label = body.label;
    if (body.description)           updates.description = body.description;
    if (body.api_endpoint !== undefined) updates.api_endpoint = body.api_endpoint;
    await db.update(nexusPlatformProcessors).set(updates).where(eq(nexusPlatformProcessors.processor_id, id));
    const [row] = await db.select().from(nexusPlatformProcessors).where(eq(nexusPlatformProcessors.processor_id, id));
    if (!row) return res.status(404).json({ error: "Processor not found" });
    res.json({ processor: row });
  } catch (e: unknown) {
    res.status(500).json({ error: "Update failed", detail: String(e) });
  }
});

// ─── Platform Admin: delete custom processor ──────────────────────────────────

router.delete("/nexus/admin/processors/:id", async (req, res) => {
  if (!requireAdminKey(req, res)) return;
  const { id } = req.params;
  try {
    const [row] = await db.select().from(nexusPlatformProcessors).where(eq(nexusPlatformProcessors.processor_id, id));
    if (!row) return res.status(404).json({ error: "Not found" });
    if (!row.is_custom) return res.status(400).json({ error: "Cannot delete built-in processors" });
    await db.delete(nexusPlatformProcessors).where(eq(nexusPlatformProcessors.processor_id, id));
    res.json({ deleted: id });
  } catch (e: unknown) {
    res.status(500).json({ error: "Delete failed", detail: String(e) });
  }
});

// ─── Public: list enabled processors (for tenant payment config UI) ───────────

router.get("/nexus/payment-processors", async (req, res) => {
  try {
    const rows = await db.select({
      processor_id: nexusPlatformProcessors.processor_id,
      label:        nexusPlatformProcessors.label,
      api_endpoint: nexusPlatformProcessors.api_endpoint,
    }).from(nexusPlatformProcessors)
      .where(eq(nexusPlatformProcessors.enabled, true))
      .orderBy(nexusPlatformProcessors.label);
    res.json({ processors: rows });
  } catch (e: unknown) {
    res.status(500).json({ error: "Failed", detail: String(e) });
  }
});

// ─── Platform Admin: payment health dashboard ─────────────────────────────────

router.get("/nexus/admin/payment-health", async (req, res) => {
  if (!requireAdminKey(req, res)) return;
  try {
    const configs = await db.select({
      config_id:       nexusPaymentConfigs.config_id,
      location_id:     nexusPaymentConfigs.location_id,
      account_id:      nexusPaymentConfigs.account_id,
      processor:       nexusPaymentConfigs.processor,
      public_key:      nexusPaymentConfigs.public_key,
      status:          nexusPaymentConfigs.status,
      last_verified_at: nexusPaymentConfigs.last_verified_at,
      fallback_processor: nexusPaymentConfigs.fallback_processor,
      created_at:      nexusPaymentConfigs.created_at,
      updated_at:      nexusPaymentConfigs.updated_at,
    }).from(nexusPaymentConfigs);

    const locationIds = [...new Set(configs.map((c) => c.location_id))];
    const locations = locationIds.length > 0
      ? await db.select({ tenant_id: nexusTenants.tenant_id, name: nexusTenants.name }).from(nexusTenants).where(inArray(nexusTenants.tenant_id, locationIds))
      : [];
    const locMap = new Map(locations.map((l) => [l.tenant_id, l.name]));

    const allLocations = await db.select({ tenant_id: nexusTenants.tenant_id, name: nexusTenants.name, account_id: nexusTenants.account_id }).from(nexusTenants);
    const configuredIds = new Set(configs.map((c) => c.location_id));

    const healthRows = [
      ...configs.map((c) => ({
        ...c,
        location_name: locMap.get(c.location_id) ?? c.location_id,
      })),
      ...allLocations
        .filter((l) => !configuredIds.has(l.tenant_id))
        .map((l) => ({
          config_id: null,
          location_id: l.tenant_id,
          account_id: l.account_id,
          processor: null,
          public_key: null,
          status: "not_configured",
          last_verified_at: null,
          fallback_processor: null,
          created_at: null,
          updated_at: null,
          location_name: l.name,
        })),
    ];

    const summary = {
      total: healthRows.length,
      connected: healthRows.filter((r) => r.status === "connected").length,
      invalid_credentials: healthRows.filter((r) => r.status === "invalid_credentials").length,
      unreachable: healthRows.filter((r) => r.status === "unreachable").length,
      not_configured: healthRows.filter((r) => r.status === "not_configured").length,
    };

    res.json({ health: healthRows, summary });
  } catch (e: unknown) {
    res.status(500).json({ error: "Health check failed", detail: String(e) });
  }
});

// ─── Location: get payment config (no secret) ─────────────────────────────────

router.get("/nexus/locations/:locationId/payment-config", async (req, res) => {
  const { locationId } = req.params;
  try {
    const [config] = await db.select({
      config_id:       nexusPaymentConfigs.config_id,
      location_id:     nexusPaymentConfigs.location_id,
      account_id:      nexusPaymentConfigs.account_id,
      processor:       nexusPaymentConfigs.processor,
      public_key:      nexusPaymentConfigs.public_key,
      has_secret_key:  nexusPaymentConfigs.secret_key_enc,
      extra_config:    nexusPaymentConfigs.extra_config,
      status:          nexusPaymentConfigs.status,
      last_verified_at: nexusPaymentConfigs.last_verified_at,
      fallback_processor: nexusPaymentConfigs.fallback_processor,
      created_at:      nexusPaymentConfigs.created_at,
      updated_at:      nexusPaymentConfigs.updated_at,
    }).from(nexusPaymentConfigs).where(eq(nexusPaymentConfigs.location_id, locationId));

    if (!config) {
      return res.json({ config: null, status: "not_configured" });
    }

    return res.json({
      config: {
        ...config,
        has_secret_key: !!config.has_secret_key,
      },
      status: config.status,
    });
  } catch (e: unknown) {
    res.status(500).json({ error: "Failed to fetch config", detail: String(e) });
  }
});

// ─── Location: save config + test connection ──────────────────────────────────

const SaveConfigSchema = z.object({
  processor:          z.string().min(1),
  secret_key:         z.string().optional(),
  public_key:         z.string().optional(),
  extra_config:       z.record(z.unknown()).optional(),
  fallback_processor: z.string().optional().nullable(),
  account_id:         z.string().min(1),
});

router.put("/nexus/locations/:locationId/payment-config", async (req, res) => {
  const { locationId } = req.params;
  const body = SaveConfigSchema.parse(req.body);

  try {
    const [existing] = await db.select().from(nexusPaymentConfigs).where(eq(nexusPaymentConfigs.location_id, locationId));

    let encryptedSecret: string | undefined = existing?.secret_key_enc ?? undefined;
    let secretForTest: string | undefined;

    if (body.secret_key) {
      encryptedSecret = encryptSecret(body.secret_key);
      secretForTest = body.secret_key;
    } else if (existing?.secret_key_enc) {
      try { secretForTest = decryptSecret(existing.secret_key_enc); } catch { secretForTest = undefined; }
    }

    const testResult = secretForTest
      ? await testConnection(body.processor, secretForTest)
      : { status: "not_configured" as const, message: "No secret key — cannot verify" };

    const configId = existing?.config_id ?? `pconf_${crypto.randomBytes(8).toString("hex")}`;
    const now = new Date();

    const configData = {
      config_id:      configId,
      location_id:    locationId,
      account_id:     body.account_id,
      processor:      body.processor,
      public_key:     body.public_key ?? null,
      secret_key_enc: encryptedSecret ?? null,
      extra_config:   (body.extra_config ?? {}) as Record<string, unknown>,
      status:         testResult.status,
      last_verified_at: testResult.status !== "not_configured" ? now : null,
      fallback_processor: body.fallback_processor ?? null,
      updated_at:     now,
    };

    if (existing) {
      await db.update(nexusPaymentConfigs).set(configData).where(eq(nexusPaymentConfigs.location_id, locationId));
    } else {
      await db.insert(nexusPaymentConfigs).values({ ...configData, created_at: now });
    }

    return res.json({
      config: { ...configData, has_secret_key: !!encryptedSecret, secret_key_enc: undefined },
      status: testResult.status,
      test_message: testResult.message,
    });
  } catch (e: unknown) {
    if (e instanceof z.ZodError) return res.status(400).json({ error: "Validation error", detail: e.errors });
    res.status(500).json({ error: "Save failed", detail: String(e) });
  }
});

// ─── Location: re-test connection ─────────────────────────────────────────────

router.post("/nexus/locations/:locationId/payment-config/test", async (req, res) => {
  const { locationId } = req.params;
  try {
    const [config] = await db.select().from(nexusPaymentConfigs).where(eq(nexusPaymentConfigs.location_id, locationId));
    if (!config) return res.status(404).json({ error: "No payment config found for this location" });
    if (!config.secret_key_enc) return res.json({ status: "not_configured", message: "No secret key stored" });

    let secretKey: string;
    try { secretKey = decryptSecret(config.secret_key_enc); } catch {
      return res.status(500).json({ error: "Failed to decrypt stored credentials" });
    }

    const result = await testConnection(config.processor, secretKey);
    await db.update(nexusPaymentConfigs).set({
      status: result.status,
      last_verified_at: new Date(),
      updated_at: new Date(),
    }).where(eq(nexusPaymentConfigs.location_id, locationId));

    res.json({ status: result.status, message: result.message });
  } catch (e: unknown) {
    res.status(500).json({ error: "Test failed", detail: String(e) });
  }
});

// ─── Location: delete config ──────────────────────────────────────────────────

router.delete("/nexus/locations/:locationId/payment-config", async (req, res) => {
  const { locationId } = req.params;
  try {
    await db.delete(nexusPaymentConfigs).where(eq(nexusPaymentConfigs.location_id, locationId));
    res.json({ deleted: true });
  } catch (e: unknown) {
    res.status(500).json({ error: "Delete failed", detail: String(e) });
  }
});

// ─── Sync engine event types for payment processor events ─────────────────────
// PAYMENT_PROCESSOR_CONNECTED | PAYMENT_PROCESSOR_FAILED | PAYMENT_PROCESSOR_UPDATED
// These are emitted as standard nexus events via the sync engine when status changes.

export const paymentRouter = router;
