import { createServer } from "node:http";
import app from "./app.js";
import { logger } from "./lib/logger.js";
import { initNexusWs } from "./lib/nexus-ws.js";
import { initStripe } from "./stripeClient.js";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

const httpServer = createServer(app);

initNexusWs(httpServer);

httpServer.listen(port, () => {
  logger.info({ port }, "Server listening");
  initStripe().catch((err) => logger.warn({ err }, "Stripe init failed (non-fatal)"));
});

httpServer.on("error", (err) => {
  logger.error({ err }, "HTTP server error");
  process.exit(1);
});
