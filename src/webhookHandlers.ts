import { getStripeSync } from "./stripeClient.js";
import {
  onSubscriptionCreated,
  onSubscriptionRenewed,
  onSubscriptionFailed,
  onSubscriptionSuspended,
} from "@nexus-pos/backend/billing-engine";
import { db } from "@workspace/db";
import { nexusTenants } from "@workspace/db/schema";
import { eq, sql } from "drizzle-orm";

export class WebhookHandlers {
  static async processWebhook(payload: Buffer, signature: string): Promise<void> {
    if (!Buffer.isBuffer(payload)) {
      throw new Error(
        "STRIPE WEBHOOK ERROR: Payload must be a Buffer. " +
          "Ensure webhook route is registered BEFORE app.use(express.json())."
      );
    }

    const sync = await getStripeSync();
    const event = await sync.processWebhook(payload, signature);

    if (!event) return;

    // ── Map Stripe events → Nexus billing lifecycle ──────────────────────────
    switch (event.type) {
      case "customer.subscription.created": {
        const sub = event.data.object as {
          id: string;
          customer: string;
          status: string;
          items?: { data?: Array<{ price?: { product?: string | { name?: string } } }> };
          metadata?: Record<string, string>;
        };
        const tenantId = sub.metadata?.["nexus_tenant_id"];
        if (!tenantId) break;

        // Determine plan from product metadata or subscription metadata
        const planFromMeta = sub.metadata?.["nexus_plan"] ?? "starter";
        const customerId = typeof sub.customer === "string"
          ? sub.customer
          : (sub.customer as { id: string }).id;

        await onSubscriptionCreated(tenantId, planFromMeta, sub.id, customerId);
        break;
      }

      case "invoice.payment_succeeded": {
        const invoice = event.data.object as {
          id: string;
          customer: string;
          subscription?: string;
          amount_paid: number;
          currency: string;
          metadata?: Record<string, string>;
          customer_metadata?: Record<string, string>;
        };

        const tenantId = invoice.metadata?.["nexus_tenant_id"]
          ?? await resolveTenantByStripeCustomer(typeof invoice.customer === "string" ? invoice.customer : "");

        if (!tenantId) break;
        await onSubscriptionRenewed(tenantId, invoice.amount_paid, invoice.currency, invoice.id);
        break;
      }

      case "invoice.payment_failed": {
        const invoice = event.data.object as {
          id: string;
          customer: string;
          metadata?: Record<string, string>;
        };

        const tenantId = invoice.metadata?.["nexus_tenant_id"]
          ?? await resolveTenantByStripeCustomer(typeof invoice.customer === "string" ? invoice.customer : "");

        if (!tenantId) break;
        await onSubscriptionFailed(tenantId, invoice.id, "payment_failed");
        break;
      }

      case "customer.subscription.deleted": {
        const sub = event.data.object as {
          id: string;
          customer: string;
          cancellation_details?: { reason?: string };
          metadata?: Record<string, string>;
        };

        const tenantId = sub.metadata?.["nexus_tenant_id"]
          ?? await resolveTenantByStripeCustomer(typeof sub.customer === "string" ? sub.customer : "");

        if (!tenantId) break;
        const reason = sub.cancellation_details?.reason ?? "subscription_deleted";
        await onSubscriptionSuspended(tenantId, sub.id, reason);
        break;
      }
    }
  }
}

async function resolveTenantByStripeCustomer(customerId: string): Promise<string | null> {
  if (!customerId) return null;
  const [row] = await db
    .select({ tenant_id: nexusTenants.tenant_id })
    .from(nexusTenants)
    .where(eq(nexusTenants.stripe_customer_id, customerId))
    .limit(1);
  return row?.tenant_id ?? null;
}
