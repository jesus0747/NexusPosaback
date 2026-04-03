import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";
import { WebhookHandlers } from "./webhookHandlers.js";
import { regionMiddleware } from "@nexus-pos/backend/region-router";
import { tracingMiddleware } from "@nexus-pos/backend/observability-routes";
import { paymentRouter } from "@nexus-pos/backend/payment-routes";
import adminRouter from "@nexus-pos/backend/admin-routes";
import setupRouter from "@nexus-pos/backend/setup-routes";
import { locationRouter } from "@nexus-pos/backend/location-routes";
import billingRouter from "@nexus-pos/backend/billing-routes";
import { provisioningRouter } from "@nexus-pos/backend/provisioning-routes";
import { printerRouter } from "@nexus-pos/backend/printer-routes";
import { otaRouter } from "@nexus-pos/backend/ota-routes";
import { disasterRecoveryRouter } from "@nexus-pos/backend/disaster-recovery-routes";
import menuEngineRouter from "@nexus-pos/backend/menu-engine";

const app: Express = express();

// ── Stripe webhook MUST be registered BEFORE express.json() ──────────────────
// Stripe requires the raw Buffer body for signature verification.
app.post(
  "/api/stripe/webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    const signature = req.headers["stripe-signature"];
    if (!signature) {
      res.status(400).json({ error: "Missing stripe-signature header" });
      return;
    }
    try {
      const sig = Array.isArray(signature) ? signature[0] : signature;
      await WebhookHandlers.processWebhook(req.body as Buffer, sig);
      res.status(200).json({ received: true });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Webhook processing failed";
      logger.error({ err }, "Stripe webhook error");
      res.status(400).json({ error: msg });
    }
  }
);

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.use(cors());
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(express.text({ type: "application/x-ndjson", limit: "50mb" }));

// Enterprise middleware — region stamping + distributed tracing
app.use(regionMiddleware);
app.use(tracingMiddleware);

app.get("/health", (_req, res) => {
  res.status(200).json({ status: "ok", ts: new Date().toISOString() });
});

app.use("/api", router);
app.use("/api", adminRouter);
app.use("/api", setupRouter);
app.use("/api", locationRouter);
app.use("/api", billingRouter);
app.use("/api", provisioningRouter);
app.use("/api", printerRouter);
app.use("/api", otaRouter);
app.use("/api", disasterRecoveryRouter);
app.use("/api", paymentRouter);
app.use("/api", menuEngineRouter);

export default app;
