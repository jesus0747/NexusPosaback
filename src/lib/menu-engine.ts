/**
 * Menu Engine — FASE 7
 * Materializes MENU_UPDATED events → nexus_categories, nexus_menu_items, nexus_modifiers
 * Processes ITEM_SOLD → decrements nexus_inventory
 * Processes STOCK_UPDATED → updates nexus_inventory
 */
import { Router, type IRouter } from "express";
import { z } from "zod";
import { db } from "@workspace/db";
import {
  nexusEvents,
  nexusCategories,
  nexusMenuItems,
  nexusModifiers,
  nexusInventory,
} from "@workspace/db/schema";
import { eq, and, sql } from "drizzle-orm";
import crypto from "node:crypto";
import type {
  MenuUpdatedPayload,
  MenuCategory,
  StructuredMenuItem,
  MenuModifier,
  ItemSoldPayload,
  StockUpdatedPayload,
} from "@nexus-pos/event-schema";

const router: IRouter = Router();

// ─── Schemas ────────────────────────────────────────────────────────────────

const CategorySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  emoji: z.string().optional(),
  sort_order: z.number().int().default(0),
  active: z.boolean().default(true),
});

const ModifierOptionSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  price: z.number().min(0),
});

const ModifierSchema = z.object({
  id: z.string().min(1),
  item_id: z.string().nullable().optional(),
  name: z.string().min(1),
  type: z.enum(["SINGLE", "MULTI"]).default("MULTI"),
  required: z.boolean().default(false),
  options: z.array(ModifierOptionSchema),
  sort_order: z.number().int().default(0),
});

const MenuItemSchema = z.object({
  id: z.string().min(1),
  category_id: z.string().min(1),
  name: z.string().min(1),
  price: z.number().min(0),
  emoji: z.string().optional(),
  description: z.string().optional(),
  station: z.enum(["kitchen", "bar", "counter"]).default("kitchen"),
  available: z.boolean().default(true),
  sort_order: z.number().int().default(0),
  modifier_ids: z.array(z.string()).optional(),
});

const UpdateMenuSchema = z.object({
  tenant_id: z.string().min(1),
  device_id: z.string().min(1).default("admin-panel"),
  categories: z.array(CategorySchema),
  items: z.array(MenuItemSchema),
  modifiers: z.array(ModifierSchema).default([]),
});

// ─── Materialization Helper ──────────────────────────────────────────────────

export async function materializeMenu(tenantId: string, payload: MenuUpdatedPayload) {
  const { categories = [], items = [], modifiers = [] } = payload;
  const now = new Date();

  await db.transaction(async (tx) => {
    // Upsert categories
    for (const cat of categories) {
      await tx
        .insert(nexusCategories)
        .values({
          category_id: cat.id,
          tenant_id: tenantId,
          name: cat.name,
          emoji: cat.emoji ?? null,
          sort_order: cat.sort_order ?? 0,
          active: cat.active !== false,
          updated_at: now,
        })
        .onConflictDoUpdate({
          target: nexusCategories.category_id,
          set: {
            name: cat.name,
            emoji: cat.emoji ?? null,
            sort_order: cat.sort_order ?? 0,
            active: cat.active !== false,
            updated_at: now,
          },
        });
    }

    // Upsert items
    for (const item of items) {
      await tx
        .insert(nexusMenuItems)
        .values({
          item_id: item.id,
          tenant_id: tenantId,
          category_id: item.category_id,
          name: item.name,
          price: item.price.toFixed(2),
          emoji: item.emoji ?? null,
          description: item.description ?? null,
          station: (item as { station?: string }).station ?? "kitchen",
          available: item.available !== false,
          sort_order: item.sort_order ?? 0,
          updated_at: now,
        })
        .onConflictDoUpdate({
          target: nexusMenuItems.item_id,
          set: {
            name: item.name,
            category_id: item.category_id,
            price: item.price.toFixed(2),
            emoji: item.emoji ?? null,
            description: item.description ?? null,
            station: (item as { station?: string }).station ?? "kitchen",
            available: item.available !== false,
            sort_order: item.sort_order ?? 0,
            updated_at: now,
          },
        });
    }

    // Upsert modifiers
    for (const mod of modifiers) {
      await tx
        .insert(nexusModifiers)
        .values({
          modifier_id: mod.id,
          tenant_id: tenantId,
          item_id: mod.item_id ?? null,
          name: mod.name,
          type: mod.type,
          required: mod.required,
          options: mod.options as unknown as Record<string, unknown>[],
          sort_order: mod.sort_order ?? 0,
          updated_at: now,
        })
        .onConflictDoUpdate({
          target: nexusModifiers.modifier_id,
          set: {
            name: mod.name,
            item_id: mod.item_id ?? null,
            type: mod.type,
            required: mod.required,
            options: mod.options as unknown as Record<string, unknown>[],
            sort_order: mod.sort_order ?? 0,
            updated_at: now,
          },
        });
    }
  });
}

// ─── Inventory Helpers ───────────────────────────────────────────────────────

export async function applyItemSold(tenantId: string, payload: ItemSoldPayload) {
  for (const soldItem of payload.items) {
    const [existing] = await db
      .select()
      .from(nexusInventory)
      .where(and(
        eq(nexusInventory.item_id, soldItem.item_id),
        eq(nexusInventory.tenant_id, tenantId),
      ))
      .limit(1);

    if (existing?.track_inventory) {
      const newQty = Math.max(0, existing.qty - soldItem.qty);
      await db
        .update(nexusInventory)
        .set({ qty: newQty, updated_at: new Date() })
        .where(and(
          eq(nexusInventory.item_id, soldItem.item_id),
          eq(nexusInventory.tenant_id, tenantId),
        ));
    }
  }
}

export async function applyStockUpdate(tenantId: string, payload: StockUpdatedPayload) {
  await db
    .insert(nexusInventory)
    .values({
      item_id: payload.item_id,
      tenant_id: tenantId,
      qty: Math.max(0, payload.new_qty),
      updated_at: new Date(),
    })
    .onConflictDoUpdate({
      target: nexusInventory.item_id,
      set: { qty: Math.max(0, payload.new_qty), updated_at: new Date() },
    });
}

// ─── Public: GET /nexus/menu ─────────────────────────────────────────────────

router.get("/nexus/menu", async (req, res) => {
  const tenantId = req.query["tenant_id"];
  if (typeof tenantId !== "string" || !tenantId) {
    res.status(400).json({ error: "tenant_id is required" });
    return;
  }

  const [rawCategories, rawItems, rawModifiers] = await Promise.all([
    db.select().from(nexusCategories)
      .where(and(eq(nexusCategories.tenant_id, tenantId), eq(nexusCategories.active, true)))
      .orderBy(nexusCategories.sort_order),
    db.select().from(nexusMenuItems)
      .where(eq(nexusMenuItems.tenant_id, tenantId))
      .orderBy(nexusMenuItems.sort_order),
    db.select().from(nexusModifiers)
      .where(eq(nexusModifiers.tenant_id, tenantId))
      .orderBy(nexusModifiers.sort_order),
  ]);

  res.json({
    categories: rawCategories.map(({ category_id, ...rest }) => ({ id: category_id, ...rest })),
    items: rawItems.map(({ item_id, ...rest }) => ({ id: item_id, ...rest })),
    modifiers: rawModifiers.map(({ modifier_id, ...rest }) => ({ id: modifier_id, ...rest })),
  });
});

// ─── Admin: GET + POST /nexus/admin/menu (enhanced) ──────────────────────────

router.get("/nexus/admin/menu-v2", async (req, res) => {
  const tenantId = req.query["tenant_id"];
  if (typeof tenantId !== "string" || !tenantId) {
    res.status(400).json({ error: "tenant_id is required" });
    return;
  }

  const [rawCategories, rawItems, rawModifiers] = await Promise.all([
    db.select().from(nexusCategories)
      .where(eq(nexusCategories.tenant_id, tenantId))
      .orderBy(nexusCategories.sort_order),
    db.select().from(nexusMenuItems)
      .where(eq(nexusMenuItems.tenant_id, tenantId))
      .orderBy(nexusMenuItems.sort_order),
    db.select().from(nexusModifiers)
      .where(eq(nexusModifiers.tenant_id, tenantId))
      .orderBy(nexusModifiers.sort_order),
  ]);

  res.json({
    categories: rawCategories.map(({ category_id, ...rest }) => ({ id: category_id, ...rest })),
    items: rawItems.map(({ item_id, ...rest }) => ({ id: item_id, ...rest })),
    modifiers: rawModifiers.map(({ modifier_id, ...rest }) => ({ id: modifier_id, ...rest })),
  });
});

router.post("/nexus/admin/menu-v2", async (req, res) => {
  const parsed = UpdateMenuSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: "Validation failed",
      details: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
    });
    return;
  }

  const { tenant_id, device_id, categories, items, modifiers } = parsed.data;

  const payload: MenuUpdatedPayload = { categories, items, modifiers };

  const event_id = crypto.randomUUID();
  const timestamp = Date.now();

  await db.insert(nexusEvents).values({
    event_id,
    type: "MENU_UPDATED",
    timestamp,
    device_id,
    tenant_id,
    payload: payload as unknown as Record<string, unknown>,
  });

  await materializeMenu(tenant_id, payload);

  res.json({ event_id, updated_at: timestamp, categories: categories.length, items: items.length, modifiers: modifiers.length });
});

// ─── Admin: Inventory ────────────────────────────────────────────────────────

router.get("/nexus/admin/inventory", async (req, res) => {
  const tenantId = req.query["tenant_id"];
  if (typeof tenantId !== "string" || !tenantId) {
    res.status(400).json({ error: "tenant_id is required" });
    return;
  }

  const items = await db.select({
    item_id: nexusMenuItems.item_id,
    name: nexusMenuItems.name,
    emoji: nexusMenuItems.emoji,
    category_id: nexusMenuItems.category_id,
    price: nexusMenuItems.price,
    station: nexusMenuItems.station,
    available: nexusMenuItems.available,
    qty: nexusInventory.qty,
    low_threshold: nexusInventory.low_threshold,
    track_inventory: nexusInventory.track_inventory,
  })
    .from(nexusMenuItems)
    .leftJoin(nexusInventory, eq(nexusMenuItems.item_id, nexusInventory.item_id))
    .where(eq(nexusMenuItems.tenant_id, tenantId))
    .orderBy(nexusMenuItems.sort_order);

  const result = items.map((i) => ({
    ...i,
    qty: i.qty ?? 0,
    low_threshold: i.low_threshold ?? 5,
    track_inventory: i.track_inventory ?? false,
    is_low_stock: (i.track_inventory ?? false) && (i.qty ?? 0) <= (i.low_threshold ?? 5),
  }));

  const low_stock_count = result.filter((i) => i.is_low_stock).length;

  res.json({ items: result, low_stock_count });
});

router.post("/nexus/admin/inventory/adjust", async (req, res) => {
  const AdjustSchema = z.object({
    tenant_id: z.string().min(1),
    device_id: z.string().min(1).default("admin-panel"),
    item_id: z.string().min(1),
    qty: z.number().int().min(0),
    low_threshold: z.number().int().min(0).optional(),
    track_inventory: z.boolean().optional(),
    reason: z.enum(["MANUAL_ADJUSTMENT", "RESTOCK", "SPOILAGE", "CORRECTION"]).default("MANUAL_ADJUSTMENT"),
    note: z.string().optional(),
  });

  const parsed = AdjustSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: "Validation failed",
      details: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
    });
    return;
  }

  const { tenant_id, device_id, item_id, qty, low_threshold, track_inventory, reason, note } = parsed.data;

  const [existing] = await db
    .select()
    .from(nexusInventory)
    .where(and(eq(nexusInventory.item_id, item_id), eq(nexusInventory.tenant_id, tenant_id)))
    .limit(1);

  const oldQty = existing?.qty ?? 0;
  const qtyDelta = qty - oldQty;

  await db
    .insert(nexusInventory)
    .values({
      item_id,
      tenant_id,
      qty,
      low_threshold: low_threshold ?? existing?.low_threshold ?? 5,
      track_inventory: track_inventory ?? existing?.track_inventory ?? true,
      updated_at: new Date(),
    })
    .onConflictDoUpdate({
      target: nexusInventory.item_id,
      set: {
        qty,
        ...(low_threshold !== undefined ? { low_threshold } : {}),
        ...(track_inventory !== undefined ? { track_inventory } : {}),
        updated_at: new Date(),
      },
    });

  const event_id = crypto.randomUUID();
  const payload: StockUpdatedPayload = {
    item_id,
    qty_delta: qtyDelta,
    new_qty: qty,
    reason,
    note,
  };

  await db.insert(nexusEvents).values({
    event_id,
    type: "STOCK_UPDATED",
    timestamp: Date.now(),
    device_id,
    tenant_id,
    payload: payload as unknown as Record<string, unknown>,
  });

  res.json({ item_id, qty, event_id });
});

// ─── CRUD: Individual Category / Item / Delete ────────────────────────────────

const ItemCrudSchema = z.object({
  tenant_id:   z.string().min(1),
  category_id: z.string().min(1),
  name:        z.string().min(1),
  price:       z.number().min(0),
  emoji:       z.string().optional(),
  description: z.string().optional(),
  station:     z.enum(["kitchen", "bar", "counter"]).default("kitchen"),
  available:   z.boolean().default(true),
  sort_order:  z.number().int().default(0),
});

const CategoryCrudSchema = z.object({
  tenant_id:  z.string().min(1),
  name:       z.string().min(1),
  emoji:      z.string().optional(),
  sort_order: z.number().int().default(0),
  active:     z.boolean().default(true),
});

/** POST /nexus/admin/categories — create a category */
router.post("/nexus/admin/categories", async (req, res) => {
  const parsed = CategoryCrudSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message });
  const { tenant_id, name, emoji, sort_order, active } = parsed.data;
  const category_id = `cat_${crypto.randomUUID().slice(0, 8)}`;
  const now = new Date();
  await db.insert(nexusCategories).values({ category_id, tenant_id, name, emoji: emoji ?? null, sort_order, active, created_at: now, updated_at: now });
  res.json({ category_id, name, emoji, sort_order, active });
});

/** PUT /nexus/admin/categories/:id — update a category */
router.put("/nexus/admin/categories/:id", async (req, res) => {
  const { name, emoji, sort_order, active } = req.body as Record<string, unknown>;
  const updates: Record<string, unknown> = { updated_at: new Date() };
  if (name !== undefined)       updates["name"]       = name;
  if (emoji !== undefined)      updates["emoji"]      = emoji;
  if (sort_order !== undefined) updates["sort_order"] = sort_order;
  if (active !== undefined)     updates["active"]     = active;
  await db.update(nexusCategories).set(updates as Parameters<typeof db.update>[0]).where(eq(nexusCategories.category_id, req.params.id));
  res.json({ ok: true });
});

/** DELETE /nexus/admin/categories/:id — delete category + its items */
router.delete("/nexus/admin/categories/:id", async (req, res) => {
  await db.delete(nexusMenuItems).where(eq(nexusMenuItems.category_id, req.params.id));
  await db.delete(nexusCategories).where(eq(nexusCategories.category_id, req.params.id));
  res.json({ ok: true });
});

/** POST /nexus/admin/items — create a menu item */
router.post("/nexus/admin/items", async (req, res) => {
  const parsed = ItemCrudSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message });
  const { tenant_id, category_id, name, price, emoji, description, station, available, sort_order } = parsed.data;
  const item_id = `item_${crypto.randomUUID().slice(0, 8)}`;
  const now = new Date();
  await db.insert(nexusMenuItems).values({
    item_id, tenant_id, category_id, name,
    price: price.toFixed(2), emoji: emoji ?? null,
    description: description ?? null, station,
    available, sort_order, created_at: now, updated_at: now,
  });
  res.json({ item_id, name, price, station, available });
});

/** PUT /nexus/admin/items/:id — update a menu item */
router.put("/nexus/admin/items/:id", async (req, res) => {
  const { name, price, emoji, description, station, available, category_id, sort_order } = req.body as Record<string, unknown>;
  const updates: Record<string, unknown> = { updated_at: new Date() };
  if (name !== undefined)        updates["name"]        = name;
  if (price !== undefined)       updates["price"]       = (price as number).toFixed(2);
  if (emoji !== undefined)       updates["emoji"]       = emoji;
  if (description !== undefined) updates["description"] = description;
  if (station !== undefined)     updates["station"]     = station;
  if (available !== undefined)   updates["available"]   = available;
  if (category_id !== undefined) updates["category_id"] = category_id;
  if (sort_order !== undefined)  updates["sort_order"]  = sort_order;
  await db.update(nexusMenuItems).set(updates as Parameters<typeof db.update>[0]).where(eq(nexusMenuItems.item_id, req.params.id));
  res.json({ ok: true });
});

/** PATCH /nexus/admin/items/:id/available — toggle availability */
router.patch("/nexus/admin/items/:id/available", async (req, res) => {
  const [item] = await db.select({ available: nexusMenuItems.available }).from(nexusMenuItems).where(eq(nexusMenuItems.item_id, req.params.id));
  if (!item) return res.status(404).json({ error: "Item not found" });
  const newAvailable = !(item.available);
  await db.update(nexusMenuItems).set({ available: newAvailable, updated_at: new Date() }).where(eq(nexusMenuItems.item_id, req.params.id));
  res.json({ available: newAvailable });
});

/** DELETE /nexus/admin/items/:id — delete a menu item */
router.delete("/nexus/admin/items/:id", async (req, res) => {
  await db.delete(nexusMenuItems).where(eq(nexusMenuItems.item_id, req.params.id));
  res.json({ ok: true });
});

export default router;
