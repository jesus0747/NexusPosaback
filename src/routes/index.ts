import { Router, type IRouter } from "express";
import healthRouter from "./health.js";
import nexusRouter from "./nexus.js";
import nexusAdminRouter from "./nexus-admin.js";
import nexusSetupRouter from "./nexus-setup.js";
import nexusMenuRouter from "./nexus-menu.js";
import logoUploadRouter from "./logo-upload.js";
import nexusBillingRouter from "@nexus-pos/backend/billing-routes";
import { printerRouter } from "@nexus-pos/backend/printer-routes";
import { provisioningRouter } from "@nexus-pos/backend/provisioning-routes";
import { otaRouter } from "@nexus-pos/backend/ota-routes";
import { regionRouter } from "@nexus-pos/backend/region-router";
import { streamingRouter } from "@nexus-pos/backend/streaming-engine";
import { observabilityRouter } from "@nexus-pos/backend/observability-routes";
import { disasterRecoveryRouter } from "@nexus-pos/backend/disaster-recovery-routes";
import { locationRouter } from "@nexus-pos/backend/location-routes";
import { paymentRouter } from "@nexus-pos/backend/payment-routes";

const router: IRouter = Router();

router.use(healthRouter);
router.use(logoUploadRouter);
router.use(nexusRouter);
router.use(nexusAdminRouter);
router.use(nexusSetupRouter);
router.use(nexusMenuRouter);
router.use(nexusBillingRouter);
router.use(printerRouter);
router.use(provisioningRouter);
router.use(otaRouter);
router.use(regionRouter);
router.use(streamingRouter);
router.use(observabilityRouter);
router.use(disasterRecoveryRouter);
router.use(locationRouter);
router.use(paymentRouter);

export default router;
