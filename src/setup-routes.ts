import { Router, type IRouter } from "express";
import { z } from "zod";
import { db } from "@workspace/db";
import { nexusTenants, nexusDevices, nexusEvents } from "@workspace/db/schema";
import { eq, count } from "drizzle-orm";
import crypto from "node:crypto";
import { checkDeviceLimit, getLimits } from "./tenant-limits.js";

const router: IRouter = Router();

const CreateTenantSchema = z.object({
  tenant_id: z.string().min(2).max(64).regex(/^[a-z0-9-]+$/, "Only lowercase alphanumeric and dashes"),
  name: z.string().min(2).max(128),
  address: z.string().optional(),
  currency: z.string().length(3).default("USD"),
  tax_rate: z.number().min(0).max(100).default(0),
});

const RegisterDeviceSetupSchema = z.object({
  device_id: z.string().min(1),
  tenant_id: z.string().min(1),
  name: z.string().min(1),
  type: z.enum(["POS", "KDS", "TABLET"]).default("POS"),
});

const SeedMenuSchema = z.object({
  tenant_id: z.string().min(1),
  device_id: z.string().min(1),
});

const DEFAULT_MENU = [
  { id: "item-01", name: "Burger", price: 12.99, emoji: "🍔", category: "mains" },
  { id: "item-02", name: "Fries", price: 3.99, emoji: "🍟", category: "sides" },
  { id: "item-03", name: "Pizza", price: 14.99, emoji: "🍕", category: "mains" },
  { id: "item-04", name: "Salad", price: 8.99, emoji: "🥗", category: "starters" },
  { id: "item-05", name: "Soda", price: 2.99, emoji: "🥤", category: "drinks" },
  { id: "item-06", name: "Water", price: 1.99, emoji: "💧", category: "drinks" },
  { id: "item-07", name: "Coffee", price: 3.49, emoji: "☕", category: "drinks" },
  { id: "item-08", name: "Brownie", price: 5.49, emoji: "🍫", category: "desserts" },
];

router.get("/nexus/setup/status", async (req, res) => {
  try {
    const [tenantCount] = await db.select({ count: count() }).from(nexusTenants);
    const [deviceCount] = await db.select({ count: count() }).from(nexusDevices);

    const initialized = Number(tenantCount?.count ?? 0) > 0;

    res.json({
      initialized,
      tenants: Number(tenantCount?.count ?? 0),
      devices: Number(deviceCount?.count ?? 0),
    });
  } catch {
    res.status(500).json({ error: "Failed to check setup status" });
  }
});

router.post("/nexus/setup/tenant", async (req, res) => {
  const parsed = CreateTenantSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: "Validation failed",
      details: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
    });
    return;
  }

  const { tenant_id, name, address, currency, tax_rate } = parsed.data;

  const [existing] = await db
    .select()
    .from(nexusTenants)
    .where(eq(nexusTenants.tenant_id, tenant_id))
    .limit(1);

  if (existing) {
    res.status(409).json({ error: "Tenant already exists", tenant_id });
    return;
  }

  const [created] = await db
    .insert(nexusTenants)
    .values({
      tenant_id,
      name,
      address: address ?? null,
      currency,
      tax_rate: tax_rate.toString(),
    })
    .returning();

  res.json({
    tenant_id: created!.tenant_id,
    name: created!.name,
    currency: created!.currency,
    tax_rate: created!.tax_rate,
    created_at: created!.created_at.toISOString(),
  });
});

router.post("/nexus/setup/device", async (req, res) => {
  const parsed = RegisterDeviceSetupSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: "Validation failed",
      details: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
    });
    return;
  }

  const { device_id, tenant_id, name, type } = parsed.data;

  const [tenant] = await db
    .select()
    .from(nexusTenants)
    .where(eq(nexusTenants.tenant_id, tenant_id))
    .limit(1);

  if (!tenant) {
    res.status(404).json({ error: "Tenant not found — create tenant first" });
    return;
  }

  const [existing] = await db
    .select()
    .from(nexusDevices)
    .where(eq(nexusDevices.device_id, device_id))
    .limit(1);

  if (existing) {
    res.json({
      device_id: existing.device_id,
      token: existing.token,
      type: existing.type,
      registered_at: existing.registered_at.toISOString(),
      already_existed: true,
    });
    return;
  }

  // ── Enforce per-tenant device limit based on plan ─────────────────────────
  const [deviceCountRow] = await db
    .select({ count: count() })
    .from(nexusDevices)
    .where(eq(nexusDevices.tenant_id, tenant_id));
  const currentDeviceCount = Number(deviceCountRow?.count ?? 0);
  const deviceCheck = checkDeviceLimit(currentDeviceCount, tenant.plan);
  if (!deviceCheck.allowed) {
    const limits = getLimits(tenant.plan);
    res.status(409).json({
      error: "Device limit reached",
      reason: deviceCheck.reason,
      plan: tenant.plan,
      limit: limits.maxDevices,
      current: currentDeviceCount,
    });
    return;
  }

  const token = crypto.randomBytes(32).toString("hex");
  const [created] = await db
    .insert(nexusDevices)
    .values({ device_id, tenant_id, name, type, token })
    .returning();

  const event_id = crypto.randomUUID();
  await db.insert(nexusEvents).values({
    event_id,
    type: "DEVICE_REGISTERED",
    timestamp: Date.now(),
    device_id,
    tenant_id,
    payload: { device_id, name, type },
  });

  res.json({
    device_id: created!.device_id,
    token: created!.token,
    type: created!.type,
    registered_at: created!.registered_at.toISOString(),
    already_existed: false,
  });
});

router.post("/nexus/setup/seed-menu", async (req, res) => {
  const parsed = SeedMenuSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: "Validation failed",
      details: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
    });
    return;
  }

  const { tenant_id, device_id } = parsed.data;

  const [tenant] = await db
    .select()
    .from(nexusTenants)
    .where(eq(nexusTenants.tenant_id, tenant_id))
    .limit(1);

  if (!tenant) {
    res.status(404).json({ error: "Tenant not found" });
    return;
  }

  const event_id = crypto.randomUUID();
  await db.insert(nexusEvents).values({
    event_id,
    type: "MENU_UPDATED",
    timestamp: Date.now(),
    device_id,
    tenant_id,
    payload: { items: DEFAULT_MENU },
  });

  res.json({
    seeded: DEFAULT_MENU.length,
    items: DEFAULT_MENU,
    event_id,
  });
});

router.get("/nexus/setup/tenants", async (_req, res) => {
  const tenants = await db
    .select({
      tenant_id:  nexusTenants.tenant_id,
      name:       nexusTenants.name,
      currency:   nexusTenants.currency,
      account_id: nexusTenants.account_id,
      status:     nexusTenants.status,
      created_at: nexusTenants.created_at,
    })
    .from(nexusTenants)
    .orderBy(nexusTenants.created_at);

  res.json({ tenants });
});

export default router;
