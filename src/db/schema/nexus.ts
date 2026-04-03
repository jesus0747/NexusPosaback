import {
  pgTable,
  text,
  bigint,
  jsonb,
  timestamp,
  boolean,
  numeric,
  integer,
  index,
} from "drizzle-orm/pg-core";

// ══════════════════════════════════════════════════════════════════════════════
// FASE 18: SaaS Account Layer
//   Account → many Locations (Locations = nexusTenants, extended)
//   User    → many Locations (via location_permissions jsonb)
// ══════════════════════════════════════════════════════════════════════════════

/**
 * nexus_accounts — Top-level SaaS entity (the company/customer)
 * One account can have multiple restaurant locations.
 * Billing happens at the account level; usage is aggregated across locations.
 */
export const nexusAccounts = pgTable("nexus_accounts", {
  account_id:    text("account_id").primaryKey(),
  company_name:  text("company_name").notNull(),
  owner_user_id: text("owner_user_id"),                        // FK → nexus_users (set after user created)
  billing_plan:  text("billing_plan").notNull().default("basic"),   // basic|pro|enterprise
  status:        text("status").notNull().default("active"),        // active|suspended|canceled|trialing
  billing_email: text("billing_email"),
  stripe_customer_id: text("stripe_customer_id"),
  stripe_subscription_id: text("stripe_subscription_id"),
  trial_ends_at: timestamp("trial_ends_at", { withTimezone: true }),
  metadata:      jsonb("metadata").default({}),
  created_at:    timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updated_at:    timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * nexus_users — Staff + owners with RBAC across multiple locations
 * location_permissions: { [locationId]: Role }
 */
export const nexusUsers = pgTable(
  "nexus_users",
  {
    user_id:              text("user_id").primaryKey(),
    account_id:           text("account_id").notNull(),
    email:                text("email").notNull(),
    name:                 text("name").notNull(),
    role:                 text("role").notNull().default("POS_CASHIER"),
    // Allowed roles: OWNER | MANAGER | HOST | POS_CASHIER | KDS_KITCHEN | KDS_BAR
    location_permissions: jsonb("location_permissions").notNull().default({}),
    // e.g. { "loc_abc": "MANAGER", "loc_xyz": "POS_CASHIER" }
    station_id:           text("station_id"),                   // primary assigned station (FK → nexus_stations)
    pin_hash:             text("pin_hash"),                     // hashed 4-digit PIN for POS login
    pin_reset_required:   boolean("pin_reset_required").notNull().default(false), // force PIN change
    display_name:         text("display_name"),                 // short name shown on POS (e.g. "Carlos")
    active:               boolean("active").notNull().default(true),
    last_seen_at:         timestamp("last_seen_at", { withTimezone: true }),
    created_at:           timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updated_at:           timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("nexus_users_account_idx").on(t.account_id),
    index("nexus_users_email_idx").on(t.email),
  ]
);

// ══════════════════════════════════════════════════════════════════════════════
// EXISTING TABLES (preserved, extended with account_id / location fields)
// ══════════════════════════════════════════════════════════════════════════════

/**
 * nexus_events — The immutable append-only event log (core of event sourcing).
 * Extended with account_id and location_id for multi-location scoping.
 * location_id = tenant_id semantically; both kept for backward compatibility.
 */
export const nexusEvents = pgTable(
  "nexus_events",
  {
    event_id:    text("event_id").primaryKey(),
    type:        text("type").notNull(),
    timestamp:   bigint("timestamp", { mode: "number" }).notNull(),
    device_id:   text("device_id").notNull(),
    tenant_id:   text("tenant_id").notNull(),          // = location_id (kept for BC)
    account_id:  text("account_id"),                    // NEW: account scoping
    location_id: text("location_id"),                   // NEW: alias for tenant_id, explicit
    payload:     jsonb("payload").notNull().default({}),
    received_at: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("nexus_events_tenant_idx").on(t.tenant_id),
    index("nexus_events_type_idx").on(t.type),
    index("nexus_events_timestamp_idx").on(t.timestamp),
    index("nexus_events_device_idx").on(t.device_id),
    index("nexus_events_account_idx").on(t.account_id),
    index("nexus_events_location_idx").on(t.location_id),
  ]
);

/**
 * nexus_devices — Hardware devices bound to a location.
 * Extended with location_id; tenant_id kept for backward compatibility.
 */
export const nexusDevices = pgTable("nexus_devices", {
  device_id:   text("device_id").primaryKey(),
  tenant_id:   text("tenant_id").notNull(),             // = location_id (BC)
  location_id: text("location_id"),                     // NEW explicit alias
  account_id:  text("account_id"),                      // NEW account scoping
  name:        text("name").notNull(),
  type:        text("type").notNull().default("POS"),    // POS|KDS|BAR|HOST|ADMIN_DISPLAY
  token:       text("token").notNull().unique(),
  registered_at: timestamp("registered_at", { withTimezone: true }).notNull().defaultNow(),
  last_seen_at:  timestamp("last_seen_at", { withTimezone: true }),
  active:        boolean("active").notNull().default(true),
});

/**
 * nexus_tenants — A restaurant location (the "Location" in SaaS terminology).
 * Each tenant belongs to an account. Extended with timezone, payment_config_id, etc.
 */
export const nexusTenants = pgTable("nexus_tenants", {
  tenant_id:        text("tenant_id").primaryKey(),
  account_id:       text("account_id"),                 // NEW: FK → nexus_accounts
  name:             text("name").notNull(),
  address:          text("address"),
  state:            text("state"),                                           // US state code e.g. "TX", "CA"
  timezone:         text("timezone").notNull().default("America/New_York"),  // NEW
  currency:         text("currency").notNull().default("USD"),
  tax_rate:         numeric("tax_rate", { precision: 5, scale: 2 }).notNull().default("0"),
  tax_config:       jsonb("tax_config").default({}),    // full tax configuration
  payment_config_id: text("payment_config_id"),          // location-specific payment processor
  // ── Business profile (loaded by Android POS on setup) ──────────────────────
  logo_url:         text("logo_url"),                    // URL to business logo image
  phone:            text("phone"),                       // business phone number
  tax_id:           text("tax_id"),                      // RFC / EIN / NIT / etc.
  receipt_header:   text("receipt_header"),              // text shown at top of receipt
  receipt_footer:   text("receipt_footer"),              // text shown at bottom of receipt (e.g. "¡Gracias!")
  receipt_config:   jsonb("receipt_config").default({}), // { show_logo, show_tax, show_cashier, paper_width }
  tip_config:       jsonb("tip_config").default({}),     // { mode: "none"|"included"|"suggested", suggested_pcts: [15,18,20] }
  plan:             text("plan").notNull().default("starter"),
  // ── Billing (FASE 12) ──────────────────────────────────────────────────────
  status:           text("status").notNull().default("active"),
  billing_email:    text("billing_email"),
  trial_ends_at:    timestamp("trial_ends_at", { withTimezone: true }),
  custom_features:  jsonb("custom_features"),
  stripe_customer_id:     text("stripe_customer_id"),
  stripe_subscription_id: text("stripe_subscription_id"),
  created_at:       timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updated_at:       timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// ── FASE 12: Billing events audit log ─────────────────────────────────────────
export const nexusBillingEvents = pgTable(
  "nexus_billing_events",
  {
    id:        text("id").primaryKey(),
    tenant_id: text("tenant_id").notNull(),
    account_id: text("account_id"),                     // NEW
    type:      text("type").notNull(),
    details:   jsonb("details").notNull().default({}),
    actor:     text("actor").notNull().default("system"),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("nexus_billing_events_tenant_idx").on(t.tenant_id),
    index("nexus_billing_events_type_idx").on(t.type),
    index("nexus_billing_events_created_idx").on(t.created_at),
    index("nexus_billing_events_account_idx").on(t.account_id),
  ]
);

export const nexusCategories = pgTable("nexus_categories", {
  category_id: text("category_id").primaryKey(),
  tenant_id:   text("tenant_id").notNull(),
  name:        text("name").notNull(),
  emoji:       text("emoji"),
  sort_order:  integer("sort_order").notNull().default(0),
  active:      boolean("active").notNull().default(true),
  created_at:  timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updated_at:  timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const nexusMenuItems = pgTable(
  "nexus_menu_items",
  {
    item_id:     text("item_id").primaryKey(),
    tenant_id:   text("tenant_id").notNull(),
    category_id: text("category_id").notNull(),
    name:        text("name").notNull(),
    price:       numeric("price", { precision: 10, scale: 2 }).notNull().default("0"),
    emoji:       text("emoji"),
    description: text("description"),
    station:     text("station").notNull().default("kitchen"), // "kitchen" | "bar" | "counter"
    available:   boolean("available").notNull().default(true),
    sort_order:  integer("sort_order").notNull().default(0),
    created_at:  timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updated_at:  timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("nexus_menu_items_tenant_idx").on(t.tenant_id)]
);

export const nexusModifiers = pgTable("nexus_modifiers", {
  modifier_id: text("modifier_id").primaryKey(),
  tenant_id:   text("tenant_id").notNull(),
  item_id:     text("item_id"),
  name:        text("name").notNull(),
  type:        text("type").notNull().default("MULTI"),
  required:    boolean("required").notNull().default(false),
  options:     jsonb("options").notNull().default([]),
  sort_order:  integer("sort_order").notNull().default(0),
  created_at:  timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updated_at:  timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const nexusInventory = pgTable(
  "nexus_inventory",
  {
    item_id:         text("item_id").primaryKey(),
    tenant_id:       text("tenant_id").notNull(),
    qty:             integer("qty").notNull().default(0),
    low_threshold:   integer("low_threshold").notNull().default(5),
    track_inventory: boolean("track_inventory").notNull().default(false),
    updated_at:      timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("nexus_inventory_tenant_idx").on(t.tenant_id)]
);

/**
 * nexus_stations — KDS/POS station definitions within a location.
 * Represents physical preparation or service stations (Kitchen 1, Bar, Counter, etc.)
 * Items are routed to stations; users are assigned to stations.
 */
export const nexusStations = pgTable(
  "nexus_stations",
  {
    station_id:    text("station_id").primaryKey(),
    tenant_id:     text("tenant_id").notNull(),
    name:          text("name").notNull(),            // "Kitchen 1", "Bar", "Counter"
    type:          text("type").notNull().default("kitchen"), // kitchen | bar | counter | host | expo
    display_order: integer("display_order").notNull().default(0),
    color:         text("color").default("#3b82f6"),  // hex color for visual ID
    active:        boolean("active").notNull().default(true),
    created_at:    timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updated_at:    timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("nexus_stations_tenant_idx").on(t.tenant_id)]
);

/**
 * nexus_dining_tables — Physical tables/seats in a restaurant.
 * Each table belongs to a section and can be routed to a station.
 */
export const nexusDiningTables = pgTable(
  "nexus_dining_tables",
  {
    table_id:   text("table_id").primaryKey(),
    tenant_id:  text("tenant_id").notNull(),
    number:     integer("number").notNull(),          // Table 1, Table 2...
    name:       text("name"),                         // Optional label ("Patio-A")
    section:    text("section").notNull().default("floor"), // floor | bar | patio | private | terrace
    capacity:   integer("capacity").notNull().default(4),
    station_id: text("station_id"),                  // FK → nexus_stations (KDS that serves this table)
    status:     text("status").notNull().default("available"), // available | occupied | reserved | cleaning
    active:     boolean("active").notNull().default(true),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("nexus_dining_tables_tenant_idx").on(t.tenant_id),
    index("nexus_dining_tables_section_idx").on(t.section),
  ]
);

// ── FASE 20: Payment Processor Configuration ──────────────────────────────────

/**
 * nexus_platform_processors — Global catalog of processors enabled by Platform Admin
 * Each record = one processor type that tenants can choose from
 */
export const nexusPlatformProcessors = pgTable("nexus_platform_processors", {
  processor_id:  text("processor_id").primaryKey(),  // stripe|adyen|square|clover|custom|custom-*
  label:         text("label").notNull(),             // "Stripe", "Adyen", "Square", ...
  enabled:       boolean("enabled").notNull().default(true),
  description:   text("description"),
  api_endpoint:  text("api_endpoint"),               // optional webhook / REST API endpoint
  logo_url:      text("logo_url"),
  supports_test: boolean("supports_test").notNull().default(true),
  is_custom:     boolean("is_custom").notNull().default(false), // true = user-created, can be deleted
  created_at:    timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updated_at:    timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * nexus_payment_configs — Per-location payment processor configuration
 * secret_key_enc = AES-256-GCM encrypted, never returned to frontend
 */
export const nexusPaymentConfigs = pgTable("nexus_payment_configs", {
  config_id:      text("config_id").primaryKey(),
  location_id:    text("location_id").notNull(),   // FK → nexus_tenants.tenant_id
  account_id:     text("account_id").notNull(),
  processor:      text("processor").notNull(),     // stripe|adyen|square|clover|custom
  public_key:     text("public_key"),              // publishable/public key (safe to return)
  secret_key_enc: text("secret_key_enc"),          // AES-GCM encrypted: iv:tag:ciphertext (never returned)
  extra_config:   jsonb("extra_config").default({}),  // terminal SDK creds, webhook ids, etc.
  status:         text("status").notNull().default("not_configured"),  // connected|invalid_credentials|unreachable|not_configured
  last_verified_at: timestamp("last_verified_at", { withTimezone: true }),
  fallback_processor: text("fallback_processor"),  // optional fallback processor id
  created_at:     timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updated_at:     timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
},
(t) => [
  index("nexus_payment_configs_location_idx").on(t.location_id),
  index("nexus_payment_configs_account_idx").on(t.account_id),
]);

/**
 * nexus_system_settings — global key/value store for platform-level configuration.
 * Used to persist the bootstrap lock and other immutable system flags.
 */
export const nexusSystemSettings = pgTable("nexus_system_settings", {
  key:        text("key").primaryKey(),
  value:      text("value").notNull(),
  created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// ── Type exports ──────────────────────────────────────────────────────────────

export type NexusAccount = typeof nexusAccounts.$inferSelect;
export type InsertNexusAccount = typeof nexusAccounts.$inferInsert;
export type NexusUser = typeof nexusUsers.$inferSelect;
export type InsertNexusUser = typeof nexusUsers.$inferInsert;
export type NexusEvent = typeof nexusEvents.$inferSelect;
export type InsertNexusEvent = typeof nexusEvents.$inferInsert;
export type NexusDevice = typeof nexusDevices.$inferSelect;
export type InsertNexusDevice = typeof nexusDevices.$inferInsert;
export type NexusTenant = typeof nexusTenants.$inferSelect;
export type InsertNexusTenant = typeof nexusTenants.$inferInsert;
export type NexusCategory = typeof nexusCategories.$inferSelect;
export type InsertNexusCategory = typeof nexusCategories.$inferInsert;
export type NexusMenuItem = typeof nexusMenuItems.$inferSelect;
export type InsertNexusMenuItem = typeof nexusMenuItems.$inferInsert;
export type NexusModifier = typeof nexusModifiers.$inferSelect;
export type InsertNexusModifier = typeof nexusModifiers.$inferInsert;
export type NexusInventory = typeof nexusInventory.$inferSelect;
export type InsertNexusInventory = typeof nexusInventory.$inferInsert;
export type NexusBillingEvent = typeof nexusBillingEvents.$inferSelect;
export type InsertNexusBillingEvent = typeof nexusBillingEvents.$inferInsert;
export type NexusTenantStatus = "active" | "suspended" | "canceled" | "trialing";
export type NexusStation = typeof nexusStations.$inferSelect;
export type InsertNexusStation = typeof nexusStations.$inferInsert;
export type NexusDiningTable = typeof nexusDiningTables.$inferSelect;
export type InsertNexusDiningTable = typeof nexusDiningTables.$inferInsert;
export type NexusStationType = "kitchen" | "bar" | "counter" | "host" | "expo";
export type NexusTableSection = "floor" | "bar" | "patio" | "private" | "terrace";
export type NexusTableStatus = "available" | "occupied" | "reserved" | "cleaning";

// RBAC role types
export type NexusRole =
  | "OWNER"
  | "MANAGER"
  | "HOST"
  | "POS_CASHIER"
  | "KDS_KITCHEN"
  | "KDS_BAR";

export type NexusAccountStatus = "active" | "suspended" | "canceled" | "trialing";

export type NexusPlatformProcessor = typeof nexusPlatformProcessors.$inferSelect;
export type InsertNexusPlatformProcessor = typeof nexusPlatformProcessors.$inferInsert;
export type NexusPaymentConfig = typeof nexusPaymentConfigs.$inferSelect;
export type InsertNexusPaymentConfig = typeof nexusPaymentConfigs.$inferInsert;
export type NexusPaymentStatus = "connected" | "invalid_credentials" | "unreachable" | "not_configured";
