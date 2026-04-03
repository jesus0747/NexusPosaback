/**
 * Nexus POS — Location & Account Routes (FASE 18)
 *
 * SaaS multi-location hierarchy:
 *   Account (company) → Locations (restaurants) → Devices + Users
 *
 * In the existing system, "tenant" = "location". These routes add the
 * Account layer on top, extend locations with timezone/payment config,
 * and add full RBAC user management.
 *
 * Routes:
 *   GET  /nexus/accounts                              — list all accounts
 *   POST /nexus/accounts                              — create account
 *   GET  /nexus/accounts/:accountId                   — get account
 *   PUT  /nexus/accounts/:accountId                   — update account
 *   DELETE /nexus/accounts/:accountId                 — delete account
 *
 *   GET  /nexus/accounts/:accountId/locations         — locations under account
 *   POST /nexus/accounts/:accountId/locations         — create location
 *   GET  /nexus/locations/:locationId                 — get location
 *   PUT  /nexus/locations/:locationId                 — update location
 *   DELETE /nexus/locations/:locationId               — delete location
 *   GET  /nexus/locations/:locationId/analytics       — per-location analytics
 *   GET  /nexus/locations/:locationId/devices         — devices at location
 *   GET  /nexus/locations/:locationId/staff           — staff at location
 *   POST /nexus/locations/:locationId/staff           — assign staff to location
 *   DELETE /nexus/locations/:locationId/staff/:userId — remove staff from location
 *
 *   GET  /nexus/accounts/:accountId/users             — all users in account
 *   POST /nexus/accounts/:accountId/users             — create user
 *   GET  /nexus/users/:userId                         — get user
 *   PUT  /nexus/users/:userId                         — update user (role, permissions)
 *   DELETE /nexus/users/:userId                       — deactivate user
 *
 *   GET  /nexus/accounts/:accountId/summary           — aggregated account analytics
 *   GET  /nexus/rbac/roles                            — role definitions
 */

import { Router } from "express";
import { db } from "@workspace/db";
import { nexusTenants, nexusDevices, nexusEvents, nexusAccounts, nexusUsers, nexusStations, nexusDiningTables } from "@workspace/db/schema";
import { eq, sql, and, desc, inArray } from "drizzle-orm";
import { randomBytes, createHash } from "node:crypto";
import { optionalSupabaseAuth, requireAccountAccess } from "./supabase-auth.js";

const router = Router();

// Validate Supabase JWT when present (no-op when not configured or no token)
router.use(optionalSupabaseAuth);

function newId(prefix: string): string {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

// ── RBAC Definitions ──────────────────────────────────────────────────────────

const ROLES = {
  OWNER:       { label: "Owner",       description: "Full account control, billing", level: 100 },
  MANAGER:     { label: "Manager",     description: "Location config, staff, reports", level: 80 },
  HOST:        { label: "Host",        description: "Reservations, table management", level: 50 },
  POS_CASHIER: { label: "Cashier",     description: "POS orders and payments only", level: 30 },
  KDS_KITCHEN: { label: "Kitchen",     description: "KDS kitchen display only", level: 20 },
  KDS_BAR:     { label: "Bar",         description: "KDS bar display only", level: 20 },
};

// ── Account Routes ─────────────────────────────────────────────────────────────

router.get("/nexus/accounts", async (req, res) => {
  try {
    let accounts;

    if (req.supabaseUser) {
      // Customer portal: only return accounts the logged-in user belongs to
      const userRows = await db
        .select({ account_id: nexusUsers.account_id })
        .from(nexusUsers)
        .where(eq(nexusUsers.email, req.supabaseUser.email));
      const accountIds = [...new Set(userRows.map((r) => r.account_id).filter(Boolean))];
      if (accountIds.length === 0) {
        return res.json([]);
      }
      accounts = await db
        .select()
        .from(nexusAccounts)
        .where(inArray(nexusAccounts.account_id, accountIds as string[]))
        .orderBy(desc(nexusAccounts.created_at));
    } else {
      // Admin panel / unauthenticated: return all accounts
      accounts = await db.select().from(nexusAccounts).orderBy(desc(nexusAccounts.created_at));
    }

    // Enrich each account with location count
    const enriched = await Promise.all(
      accounts.map(async (acc) => {
        const [locCount] = await db
          .select({ count: sql<number>`count(*)::int` })
          .from(nexusTenants)
          .where(eq(nexusTenants.account_id, acc.account_id));
        const [userCount] = await db
          .select({ count: sql<number>`count(*)::int` })
          .from(nexusUsers)
          .where(eq(nexusUsers.account_id, acc.account_id));
        return {
          ...acc,
          locationCount: locCount?.count ?? 0,
          userCount:     userCount?.count ?? 0,
        };
      })
    );
    res.json(enriched);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Failed to fetch accounts" });
  }
});

router.post("/nexus/accounts", async (req, res) => {
  const { company_name, billing_plan = "basic", billing_email, status = "active" } = req.body as {
    company_name: string;
    billing_plan?: string;
    billing_email?: string;
    status?: string;
  };
  if (!company_name) return res.status(400).json({ error: "company_name required" });

  try {
    const account_id = newId("acc");
    await db.insert(nexusAccounts).values({
      account_id, company_name, billing_plan, billing_email: billing_email ?? null,
      status, metadata: {},
    });
    const [account] = await db.select().from(nexusAccounts).where(eq(nexusAccounts.account_id, account_id));
    res.status(201).json(account);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Failed to create account" });
  }
});

router.get("/nexus/accounts/:accountId", requireAccountAccess(), async (req, res) => {
  try {
    const [account] = await db.select().from(nexusAccounts)
      .where(eq(nexusAccounts.account_id, req.params.accountId));
    if (!account) return res.status(404).json({ error: "Account not found" });
    res.json(account);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Failed" });
  }
});

router.put("/nexus/accounts/:accountId", requireAccountAccess(), async (req, res) => {
  const { company_name, billing_plan, billing_email, status } = req.body as Record<string, string>;
  try {
    await db.update(nexusAccounts)
      .set({ company_name, billing_plan, billing_email: billing_email ?? undefined, status,
             updated_at: new Date() })
      .where(eq(nexusAccounts.account_id, req.params.accountId));
    const [account] = await db.select().from(nexusAccounts)
      .where(eq(nexusAccounts.account_id, req.params.accountId));
    res.json(account);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Failed" });
  }
});

router.delete("/nexus/accounts/:accountId", requireAccountAccess(), async (req, res) => {
  try {
    await db.delete(nexusAccounts).where(eq(nexusAccounts.account_id, req.params.accountId));
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Failed" });
  }
});

// ── Location Routes ────────────────────────────────────────────────────────────

router.get("/nexus/accounts/:accountId/locations", requireAccountAccess(), async (req, res) => {
  try {
    const locations = await db.select().from(nexusTenants)
      .where(eq(nexusTenants.account_id, req.params.accountId))
      .orderBy(nexusTenants.name);

    const enriched = await Promise.all(
      locations.map(async (loc) => {
        const [devCount] = await db
          .select({ count: sql<number>`count(*)::int` })
          .from(nexusDevices)
          .where(eq(nexusDevices.tenant_id, loc.tenant_id));
        const [evtCount] = await db
          .select({ count: sql<number>`count(*)::int` })
          .from(nexusEvents)
          .where(eq(nexusEvents.tenant_id, loc.tenant_id));
        return {
          ...loc,
          location_id: loc.tenant_id,
          deviceCount: devCount?.count ?? 0,
          eventCount:  evtCount?.count ?? 0,
        };
      })
    );
    res.json(enriched);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Failed" });
  }
});

router.post("/nexus/accounts/:accountId/locations", requireAccountAccess(), async (req, res) => {
  const {
    name, address, timezone = "America/New_York",
    currency = "USD", tax_rate = "0", tax_config,
    payment_config_id, plan = "starter",
  } = req.body as Record<string, string>;
  if (!name) return res.status(400).json({ error: "name required" });
  const { accountId } = req.params;

  try {
    const tenant_id = newId("loc");
    await db.insert(nexusTenants).values({
      tenant_id, account_id: accountId, name, address: address ?? null,
      timezone, currency, tax_rate: tax_rate as unknown as number,
      tax_config: tax_config ? JSON.parse(tax_config) : {},
      payment_config_id: payment_config_id ?? null, plan, status: "active",
    });
    const [location] = await db.select().from(nexusTenants)
      .where(eq(nexusTenants.tenant_id, tenant_id));
    res.status(201).json({ ...location, location_id: tenant_id });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Failed to create location" });
  }
});

router.get("/nexus/locations/:locationId", async (req, res) => {
  try {
    const [location] = await db.select().from(nexusTenants)
      .where(eq(nexusTenants.tenant_id, req.params.locationId));
    if (!location) return res.status(404).json({ error: "Location not found" });
    res.json({ ...location, location_id: location.tenant_id });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Failed" });
  }
});

router.put("/nexus/locations/:locationId", async (req, res) => {
  const { name, address, timezone, currency, tax_rate, tax_config, payment_config_id, status } =
    req.body as Record<string, string>;
  try {
    const updates: Record<string, unknown> = { updated_at: new Date() };
    if (name)               updates["name"]               = name;
    if (address !== undefined) updates["address"]          = address;
    if (timezone)           updates["timezone"]           = timezone;
    if (currency)           updates["currency"]           = currency;
    if (tax_rate !== undefined) updates["tax_rate"]       = tax_rate;
    if (tax_config)         updates["tax_config"]         = JSON.parse(tax_config);
    if (payment_config_id !== undefined) updates["payment_config_id"] = payment_config_id;
    if (status)             updates["status"]             = status;

    await db.update(nexusTenants)
      .set(updates as Parameters<typeof db.update>[0])
      .where(eq(nexusTenants.tenant_id, req.params.locationId));
    const [location] = await db.select().from(nexusTenants)
      .where(eq(nexusTenants.tenant_id, req.params.locationId));
    res.json({ ...location, location_id: req.params.locationId });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Failed" });
  }
});

router.delete("/nexus/locations/:locationId", async (req, res) => {
  try {
    await db.delete(nexusTenants).where(eq(nexusTenants.tenant_id, req.params.locationId));
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Failed" });
  }
});

/** GET /nexus/locations/:locationId/analytics */
router.get("/nexus/locations/:locationId/analytics", async (req, res) => {
  const { locationId } = req.params;
  const days = Number(req.query["days"] ?? 30);
  const since = new Date(Date.now() - days * 86_400_000);

  try {
    const [eventStats] = await db
      .select({
        total:  sql<number>`count(*)::int`,
        orders: sql<number>`count(*) filter (where type = 'ORDER_CREATED')::int`,
        paid:   sql<number>`count(*) filter (where type = 'ORDER_PAID')::int`,
      })
      .from(nexusEvents)
      .where(
        and(
          eq(nexusEvents.tenant_id, locationId),
          sql`received_at >= ${since.toISOString()}`
        )
      );

    // Revenue estimate from paid orders
    const revenue = await db.execute(sql`
      SELECT COALESCE(SUM((payload->>'total')::numeric), 0)::float AS revenue
      FROM nexus_events
      WHERE tenant_id = ${locationId}
        AND type = 'ORDER_PAID'
        AND received_at >= ${since.toISOString()}
    `);

    const [devices] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(nexusDevices)
      .where(eq(nexusDevices.tenant_id, locationId));

    res.json({
      locationId,
      period:      { days, since: since.toISOString() },
      events:      { total: eventStats?.total ?? 0 },
      orders:      { created: eventStats?.orders ?? 0, paid: eventStats?.paid ?? 0 },
      revenue:     (revenue.rows[0] as { revenue: number })?.revenue ?? 0,
      devices:     devices?.count ?? 0,
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Analytics failed" });
  }
});

/** GET /nexus/locations/:locationId/devices */
router.get("/nexus/locations/:locationId/devices", async (req, res) => {
  try {
    const devices = await db.select().from(nexusDevices)
      .where(eq(nexusDevices.tenant_id, req.params.locationId));
    res.json(devices);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Failed" });
  }
});

/** GET /nexus/locations/:locationId/staff — users assigned to this location */
router.get("/nexus/locations/:locationId/staff", async (req, res) => {
  try {
    const users = await db.select().from(nexusUsers);
    const staff = users.filter((u) => {
      const perms = u.location_permissions as Record<string, string>;
      return req.params.locationId in perms;
    }).map((u) => ({
      ...u,
      locationRole: (u.location_permissions as Record<string, string>)[req.params.locationId],
    }));
    res.json(staff);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Failed" });
  }
});

/** POST /nexus/locations/:locationId/staff — assign existing user to location */
router.post("/nexus/locations/:locationId/staff", async (req, res) => {
  const { user_id, role } = req.body as { user_id: string; role: string };
  if (!user_id || !role) return res.status(400).json({ error: "user_id and role required" });
  if (!ROLES[role as keyof typeof ROLES]) return res.status(400).json({ error: "Invalid role" });

  try {
    const [user] = await db.select().from(nexusUsers).where(eq(nexusUsers.user_id, user_id));
    if (!user) return res.status(404).json({ error: "User not found" });
    const perms = { ...(user.location_permissions as Record<string, string>), [req.params.locationId]: role };
    await db.update(nexusUsers).set({ location_permissions: perms }).where(eq(nexusUsers.user_id, user_id));
    res.json({ ok: true, user_id, locationId: req.params.locationId, role });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Failed" });
  }
});

/** DELETE /nexus/locations/:locationId/staff/:userId */
router.delete("/nexus/locations/:locationId/staff/:userId", async (req, res) => {
  try {
    const [user] = await db.select().from(nexusUsers).where(eq(nexusUsers.user_id, req.params.userId));
    if (!user) return res.status(404).json({ error: "User not found" });

    // RBAC guard: OWNERs cannot be removed from a location by other owners
    const targetLocationRole = (user.location_permissions as Record<string, string>)[req.params.locationId];
    const targetAccountRole  = user.role ?? "";
    if (targetLocationRole === "OWNER" || targetAccountRole === "OWNER") {
      return res.status(403).json({ error: "Owners cannot be removed from a location. Change their role first." });
    }

    const perms = { ...(user.location_permissions as Record<string, string>) };
    delete perms[req.params.locationId];
    await db.update(nexusUsers).set({ location_permissions: perms }).where(eq(nexusUsers.user_id, req.params.userId));
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Failed" });
  }
});

// ── User / RBAC Routes ────────────────────────────────────────────────────────

router.get("/nexus/accounts/:accountId/users", requireAccountAccess(), async (req, res) => {
  try {
    const users = await db.select().from(nexusUsers)
      .where(eq(nexusUsers.account_id, req.params.accountId))
      .orderBy(nexusUsers.name);
    res.json(users);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Failed" });
  }
});

router.post("/nexus/accounts/:accountId/users", requireAccountAccess(), async (req, res) => {
  const { email, name, role = "POS_CASHIER", location_permissions = {} } =
    req.body as { email: string; name: string; role?: string; location_permissions?: Record<string, string> };
  if (!email || !name) return res.status(400).json({ error: "email and name required" });
  if (!ROLES[role as keyof typeof ROLES]) return res.status(400).json({ error: "Invalid role" });

  try {
    const user_id = newId("usr");
    await db.insert(nexusUsers).values({
      user_id, account_id: req.params.accountId, email, name, role, location_permissions, active: true,
    });
    const [user] = await db.select().from(nexusUsers).where(eq(nexusUsers.user_id, user_id));
    res.status(201).json(user);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Failed to create user" });
  }
});

router.get("/nexus/users/:userId", async (req, res) => {
  try {
    const [user] = await db.select().from(nexusUsers).where(eq(nexusUsers.user_id, req.params.userId));
    if (!user) return res.status(404).json({ error: "User not found" });
    res.json(user);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Failed" });
  }
});

router.put("/nexus/users/:userId", async (req, res) => {
  const { name, email, role, location_permissions, active } =
    req.body as Record<string, unknown>;
  try {
    const updates: Record<string, unknown> = { updated_at: new Date() };
    if (name !== undefined)                updates["name"]                 = name;
    if (email !== undefined)               updates["email"]                = email;
    if (role !== undefined)                updates["role"]                 = role;
    if (location_permissions !== undefined) updates["location_permissions"] = location_permissions;
    if (active !== undefined)              updates["active"]               = active;

    await db.update(nexusUsers)
      .set(updates as Parameters<typeof db.update>[0])
      .where(eq(nexusUsers.user_id, req.params.userId));
    const [user] = await db.select().from(nexusUsers).where(eq(nexusUsers.user_id, req.params.userId));
    res.json(user);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Failed" });
  }
});

router.delete("/nexus/users/:userId", async (req, res) => {
  try {
    await db.update(nexusUsers)
      .set({ active: false, updated_at: new Date() })
      .where(eq(nexusUsers.user_id, req.params.userId));
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Failed" });
  }
});

// ── Account Summary ───────────────────────────────────────────────────────────

router.get("/nexus/accounts/:accountId/summary", requireAccountAccess(), async (req, res) => {
  const { accountId } = req.params;
  try {
    const [account] = await db.select().from(nexusAccounts)
      .where(eq(nexusAccounts.account_id, accountId));
    if (!account) return res.status(404).json({ error: "Account not found" });

    const locations = await db.select().from(nexusTenants)
      .where(eq(nexusTenants.account_id, accountId));

    const users = await db.select().from(nexusUsers)
      .where(eq(nexusUsers.account_id, accountId));

    // Aggregate analytics across all locations
    const locationIds = locations.map((l) => l.tenant_id);
    let totalEvents = 0, totalOrders = 0, totalRevenue = 0;

    for (const locId of locationIds) {
      const [stats] = await db
        .select({
          events: sql<number>`count(*)::int`,
          orders: sql<number>`count(*) filter (where type = 'ORDER_PAID')::int`,
        })
        .from(nexusEvents)
        .where(eq(nexusEvents.tenant_id, locId));
      totalEvents += stats?.events ?? 0;
      totalOrders += stats?.orders ?? 0;

      const rev = await db.execute(sql`
        SELECT COALESCE(SUM((payload->>'total')::numeric), 0)::float AS revenue
        FROM nexus_events WHERE tenant_id = ${locId} AND type = 'ORDER_PAID'
      `);
      totalRevenue += (rev.rows[0] as { revenue: number })?.revenue ?? 0;
    }

    res.json({
      account,
      summary: {
        locations:    locations.length,
        activeLocations: locations.filter((l) => l.status === "active").length,
        users:        users.length,
        activeUsers:  users.filter((u) => u.active).length,
        totalEvents,
        totalOrders,
        totalRevenue,
        billingPlan:  account.billing_plan,
      },
      locations: locations.map((l) => ({ ...l, location_id: l.tenant_id })),
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Failed" });
  }
});

/** GET /nexus/rbac/roles */
router.get("/nexus/rbac/roles", (_req, res) => {
  res.json(Object.entries(ROLES).map(([key, val]) => ({ role: key, ...val })));
});

// ── PIN + Business Config Routes ──────────────────────────────────────────────

function hashPin(userId: string, pin: string): string {
  return createHash("sha256").update(`nexus:${userId}:${pin}`).digest("hex");
}
function generatePin(): string {
  return String(Math.floor(1000 + Math.random() * 9000));
}

/** PATCH /nexus/users/:userId/active — toggle active/inactive */
router.patch("/nexus/users/:userId/active", async (req, res) => {
  try {
    const [user] = await db.select().from(nexusUsers).where(eq(nexusUsers.user_id, req.params.userId));
    if (!user) return res.status(404).json({ error: "User not found" });
    const newActive = !user.active;
    await db.update(nexusUsers)
      .set({ active: newActive, updated_at: new Date() })
      .where(eq(nexusUsers.user_id, req.params.userId));
    res.json({ ok: true, user_id: req.params.userId, active: newActive });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Failed" });
  }
});

/** POST /nexus/users/:userId/reset-pin — generate 4-digit PIN, return it once */
router.post("/nexus/users/:userId/reset-pin", async (req, res) => {
  try {
    const [user] = await db.select().from(nexusUsers).where(eq(nexusUsers.user_id, req.params.userId));
    if (!user) return res.status(404).json({ error: "User not found" });
    const pin = generatePin();
    const pin_hash = hashPin(req.params.userId, pin);
    await db.update(nexusUsers)
      .set({ pin_hash, pin_reset_required: true, updated_at: new Date() } as Record<string, unknown>)
      .where(eq(nexusUsers.user_id, req.params.userId));
    res.json({ ok: true, pin });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Failed" });
  }
});

/** POST /nexus/auth/employee-pin — verify 4-digit PIN for Android login */
router.post("/nexus/auth/employee-pin", async (req, res) => {
  const { tenant_id, user_id, pin } = req.body as { tenant_id: string; user_id: string; pin: string };
  if (!tenant_id || !user_id || !pin) {
    return res.status(400).json({ error: "tenant_id, user_id, and pin are required" });
  }
  try {
    const [user] = await db.select().from(nexusUsers).where(eq(nexusUsers.user_id, user_id));
    if (!user) return res.status(401).json({ error: "Invalid credentials" });
    if (!user.active) return res.status(403).json({ error: "Account is inactive" });

    const perms = (user.location_permissions as Record<string, string>) ?? {};
    const hasAccess = !!perms[tenant_id] || user.role === "OWNER" || user.role === "MANAGER";
    if (!hasAccess) return res.status(403).json({ error: "No access to this location" });
    if (!user.pin_hash) return res.status(401).json({ error: "No PIN set — contact your manager" });

    const expected = hashPin(user_id, pin);
    if (expected !== user.pin_hash) return res.status(401).json({ error: "Wrong PIN" });

    await db.update(nexusUsers)
      .set({ last_seen_at: new Date() })
      .where(eq(nexusUsers.user_id, user_id));

    const { pin_hash: _ph, ...safe } = user;
    res.json({
      ok: true,
      employee: {
        ...safe,
        location_role: perms[tenant_id] ?? user.role,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Failed" });
  }
});

/** GET /nexus/locations/:locationId/config — location info + active staff (for Android) */
router.get("/nexus/locations/:locationId/config", async (req, res) => {
  try {
    const [location] = await db.select().from(nexusTenants)
      .where(eq(nexusTenants.tenant_id, req.params.locationId));
    if (!location) return res.status(404).json({ error: "Location not found" });

    const allUsers = await db.select().from(nexusUsers)
      .where(and(eq(nexusUsers.account_id, location.account_id!), eq(nexusUsers.active, true)));

    const staff = allUsers
      .filter((u) => {
        const perms = (u.location_permissions as Record<string, string>) ?? {};
        return !!perms[req.params.locationId] || u.role === "OWNER" || u.role === "MANAGER";
      })
      .map(({ pin_hash: _ph, ...safe }) => safe);

    const { logo_url, phone, tax_id, receipt_header, receipt_footer, receipt_config, tip_config, tax_rate, ...locationInfo } = location;
    res.json({
      location: {
        ...locationInfo,
        business: { logo_url, phone, tax_id, receipt_header, receipt_footer, receipt_config, tip_config, tax_rate },
      },
      staff,
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Failed" });
  }
});

/** PUT /nexus/locations/:locationId/config — update business profile */
router.put("/nexus/locations/:locationId/config", async (req, res) => {
  const { logo_url, phone, tax_id, receipt_header, receipt_footer, receipt_config, tax_rate, tip_config } = req.body;
  try {
    const updates: Record<string, unknown> = { updated_at: new Date() };
    if (logo_url !== undefined)       updates["logo_url"]       = logo_url;
    if (phone !== undefined)          updates["phone"]          = phone;
    if (tax_id !== undefined)         updates["tax_id"]         = tax_id;
    if (receipt_header !== undefined) updates["receipt_header"] = receipt_header;
    if (receipt_footer !== undefined) updates["receipt_footer"] = receipt_footer;
    if (receipt_config !== undefined) updates["receipt_config"] = receipt_config;
    if (tax_rate !== undefined)       updates["tax_rate"]       = tax_rate;
    if (tip_config !== undefined)     updates["tip_config"]     = tip_config;

    await db.update(nexusTenants)
      .set(updates as Parameters<typeof db.update>[0])
      .where(eq(nexusTenants.tenant_id, req.params.locationId));
    const [updated] = await db.select().from(nexusTenants)
      .where(eq(nexusTenants.tenant_id, req.params.locationId));
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Failed" });
  }
});

/** GET /nexus/accounts/:accountId/revenue-trend?days=30
 *  Returns per-day revenue for the last N days across all locations in the account.
 */
router.get("/nexus/accounts/:accountId/revenue-trend", requireAccountAccess(), async (req, res) => {
  const { accountId } = req.params;
  const days = Math.min(Number(req.query["days"] ?? 30), 90);

  try {
    const locations = await db.select({ tenant_id: nexusTenants.tenant_id })
      .from(nexusTenants)
      .where(eq(nexusTenants.account_id, accountId));

    if (!locations.length) return res.json({ trend: [] });

    const locationIds = locations.map((l) => l.tenant_id);
    const since = new Date(Date.now() - days * 86_400_000);

    const rows = await db.execute(sql`
      SELECT
        DATE(received_at)::text  AS day,
        COUNT(*)::int            AS orders,
        COALESCE(SUM((payload->>'total')::numeric), 0)::float AS revenue
      FROM nexus_events
      WHERE tenant_id = ANY(${locationIds})
        AND type = 'ORDER_PAID'
        AND received_at >= ${since.toISOString()}
      GROUP BY DATE(received_at)
      ORDER BY DATE(received_at)
    `);

    // Build a complete date range (fill missing days with 0)
    const map = new Map<string, { orders: number; revenue: number }>();
    for (const r of rows.rows as { day: string; orders: number; revenue: number }[]) {
      map.set(r.day, { orders: r.orders, revenue: r.revenue });
    }

    const trend: { day: string; orders: number; revenue: number }[] = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(Date.now() - i * 86_400_000);
      const key = d.toISOString().slice(0, 10);
      trend.push({ day: key, ...(map.get(key) ?? { orders: 0, revenue: 0 }) });
    }

    res.json({ trend });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Failed" });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// STATIONS — KDS/POS stations per location
// ══════════════════════════════════════════════════════════════════════════════

/** GET /nexus/locations/:locationId/stations — list all stations */
router.get("/nexus/locations/:locationId/stations", async (req, res) => {
  try {
    const rows = await db.select().from(nexusStations)
      .where(eq(nexusStations.tenant_id, req.params.locationId))
      .orderBy(nexusStations.display_order);
    res.json({ stations: rows });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Failed" });
  }
});

/** POST /nexus/locations/:locationId/stations — create station */
router.post("/nexus/locations/:locationId/stations", async (req, res) => {
  const { name, type, display_order, color } = req.body;
  if (!name) return res.status(400).json({ error: "name required" });
  try {
    const stationId = `stn_${randomBytes(8).toString("hex")}`;
    const [station] = await db.insert(nexusStations).values({
      station_id:    stationId,
      tenant_id:     req.params.locationId,
      name,
      type:          type ?? "kitchen",
      display_order: display_order ?? 0,
      color:         color ?? "#3b82f6",
    }).returning();
    res.status(201).json(station);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Failed" });
  }
});

/** PUT /nexus/locations/:locationId/stations/:stationId — update station */
router.put("/nexus/locations/:locationId/stations/:stationId", async (req, res) => {
  const { name, type, display_order, color, active } = req.body;
  try {
    const updates: Record<string, unknown> = { updated_at: new Date() };
    if (name          !== undefined) updates["name"]          = name;
    if (type          !== undefined) updates["type"]          = type;
    if (display_order !== undefined) updates["display_order"] = display_order;
    if (color         !== undefined) updates["color"]         = color;
    if (active        !== undefined) updates["active"]        = active;
    const [updated] = await db.update(nexusStations).set(updates as Parameters<ReturnType<typeof db.update>["set"]>[0])
      .where(and(eq(nexusStations.station_id, req.params.stationId), eq(nexusStations.tenant_id, req.params.locationId)))
      .returning();
    if (!updated) return res.status(404).json({ error: "Station not found" });
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Failed" });
  }
});

/** DELETE /nexus/locations/:locationId/stations/:stationId */
router.delete("/nexus/locations/:locationId/stations/:stationId", async (req, res) => {
  try {
    await db.delete(nexusStations)
      .where(and(eq(nexusStations.station_id, req.params.stationId), eq(nexusStations.tenant_id, req.params.locationId)));
    res.status(204).send();
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Failed" });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// DINING TABLES — physical tables in a location
// ══════════════════════════════════════════════════════════════════════════════

/** GET /nexus/locations/:locationId/tables — list all tables */
router.get("/nexus/locations/:locationId/tables", async (req, res) => {
  try {
    const rows = await db.select().from(nexusDiningTables)
      .where(eq(nexusDiningTables.tenant_id, req.params.locationId))
      .orderBy(nexusDiningTables.number);
    // Enrich with station names
    const stationIds = [...new Set(rows.map((r) => r.station_id).filter(Boolean))] as string[];
    const stations = stationIds.length
      ? await db.select({ station_id: nexusStations.station_id, name: nexusStations.name })
          .from(nexusStations).where(inArray(nexusStations.station_id, stationIds))
      : [];
    const stationMap = Object.fromEntries(stations.map((s) => [s.station_id, s.name]));
    const enriched = rows.map((t) => ({ ...t, station_name: t.station_id ? stationMap[t.station_id] : null }));
    res.json({ tables: enriched });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Failed" });
  }
});

/** POST /nexus/locations/:locationId/tables — create table */
router.post("/nexus/locations/:locationId/tables", async (req, res) => {
  const { number, name, section, capacity, station_id } = req.body;
  if (!number) return res.status(400).json({ error: "number required" });
  try {
    const tableId = `tbl_${randomBytes(8).toString("hex")}`;
    const [table] = await db.insert(nexusDiningTables).values({
      table_id:   tableId,
      tenant_id:  req.params.locationId,
      number:     Number(number),
      name:       name ?? null,
      section:    section ?? "floor",
      capacity:   capacity ?? 4,
      station_id: station_id ?? null,
    }).returning();
    res.status(201).json(table);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Failed" });
  }
});

/** PUT /nexus/locations/:locationId/tables/:tableId — update table */
router.put("/nexus/locations/:locationId/tables/:tableId", async (req, res) => {
  const { number, name, section, capacity, station_id, status, active } = req.body;
  try {
    const updates: Record<string, unknown> = { updated_at: new Date() };
    if (number     !== undefined) updates["number"]     = Number(number);
    if (name       !== undefined) updates["name"]       = name;
    if (section    !== undefined) updates["section"]    = section;
    if (capacity   !== undefined) updates["capacity"]   = Number(capacity);
    if (station_id !== undefined) updates["station_id"] = station_id;
    if (status     !== undefined) updates["status"]     = status;
    if (active     !== undefined) updates["active"]     = active;
    const [updated] = await db.update(nexusDiningTables).set(updates as Parameters<ReturnType<typeof db.update>["set"]>[0])
      .where(and(eq(nexusDiningTables.table_id, req.params.tableId), eq(nexusDiningTables.tenant_id, req.params.locationId)))
      .returning();
    if (!updated) return res.status(404).json({ error: "Table not found" });
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Failed" });
  }
});

/** DELETE /nexus/locations/:locationId/tables/:tableId */
router.delete("/nexus/locations/:locationId/tables/:tableId", async (req, res) => {
  try {
    await db.delete(nexusDiningTables)
      .where(and(eq(nexusDiningTables.table_id, req.params.tableId), eq(nexusDiningTables.tenant_id, req.params.locationId)));
    res.status(204).send();
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Failed" });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// USER ROLE + STATION — update from admin panel
// ══════════════════════════════════════════════════════════════════════════════

/** PATCH /nexus/users/:userId/role — change role and/or station assignment */
router.patch("/nexus/users/:userId/role", async (req, res) => {
  const { role, station_id } = req.body;
  try {
    const updates: Record<string, unknown> = { updated_at: new Date() };
    if (role       !== undefined) updates["role"]       = role;
    if (station_id !== undefined) updates["station_id"] = station_id === "" ? null : station_id;
    const [updated] = await db.update(nexusUsers).set(updates as Parameters<ReturnType<typeof db.update>["set"]>[0])
      .where(eq(nexusUsers.user_id, req.params.userId))
      .returning();
    if (!updated) return res.status(404).json({ error: "User not found" });
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Failed" });
  }
});

export const locationRouter = router;
