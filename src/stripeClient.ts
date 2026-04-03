// ─── Stripe Client — fetches credentials from Replit Connections API ──────────
//
// Pattern: Replit injects the Stripe secret key via the connection settings.
// We fetch it from the Replit Connections endpoint at startup.
// Never hard-code API keys.

import { StripeSync, runMigrations } from "stripe-replit-sync";
import type Stripe from "stripe";

const CONNECTION_ID = "conn_stripe_01KN823QWRDEP96SMGESWRQCTD";
const CONNECTORS_HOSTNAME = process.env["CONNECTORS_HOSTNAME"] ?? "connectors.replit.com";

interface StripeConnectionSettings {
  secret: string;
  publishable: string;
  account_id: string;
}

async function fetchStripeCredentials(): Promise<StripeConnectionSettings> {
  const url = `https://${CONNECTORS_HOSTNAME}/connections/${CONNECTION_ID}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) {
    throw new Error(`Failed to fetch Stripe credentials: ${res.status} ${res.statusText}`);
  }
  const data = (await res.json()) as { settings: StripeConnectionSettings };
  return data.settings;
}

// ─── Singleton ────────────────────────────────────────────────────────────────

let _sync: StripeSync | null = null;

export async function getStripeSync(): Promise<StripeSync> {
  if (_sync) return _sync;

  const creds = await fetchStripeCredentials();
  const databaseUrl = process.env["DATABASE_URL"];
  if (!databaseUrl) throw new Error("DATABASE_URL required for Stripe sync");

  _sync = new StripeSync({
    stripeSecretKey: creds.secret,
    databaseUrl,
    schema: "stripe",
  });

  return _sync;
}

export async function getUncachableStripeClient(): Promise<Stripe> {
  const sync = await getStripeSync();
  return (sync as unknown as { stripe: Stripe }).stripe;
}

// ─── Initialize Stripe on server startup ─────────────────────────────────────
// Call this once from index.ts AFTER the HTTP server is set up.

export async function initStripe(): Promise<void> {
  const databaseUrl = process.env["DATABASE_URL"];
  if (!databaseUrl) {
    console.warn("[Stripe] DATABASE_URL not set — skipping Stripe init");
    return;
  }

  try {
    console.log("[Stripe] Running migrations…");
    await runMigrations({ databaseUrl, schema: "stripe" });
    console.log("[Stripe] Migrations complete");

    const sync = await getStripeSync();

    const domain = process.env["REPLIT_DOMAINS"]?.split(",")[0];
    if (domain) {
      const webhookUrl = `https://${domain}/api/stripe/webhook`;
      console.log(`[Stripe] Registering webhook → ${webhookUrl}`);
      await sync.findOrCreateManagedWebhook(webhookUrl);
      console.log("[Stripe] Webhook registered");
    }

    // Backfill runs async — does not block server startup
    sync.syncBackfill().then(() => {
      console.log("[Stripe] Backfill complete");
    }).catch((err) => {
      console.error("[Stripe] Backfill error:", err);
    });
  } catch (err) {
    console.error("[Stripe] Init error (non-fatal):", err);
    // Non-fatal — billing still works for admin-side operations
  }
}
