import { Router } from "express";
import { asyncHandler } from "../../middleware/error-handler";
import {
  requireClerkAuth,
  autoProvision,
} from "../../middleware/clerk.middleware";
import { resolveTenantContext } from "../../middleware/super-admin.middleware";
import { requireRole } from "../../middleware/auth.middleware";
import { rateLimitByTenant } from "../../middleware/rate-limit.middleware";
import * as ctrl from "./google-drive.controller";
import * as od from "./onedrive.controller";

/** Public — browser navigates here (start hop + Google redirect). */
export const googleDrivePublicRouter = Router();
googleDrivePublicRouter.get("/start", asyncHandler(ctrl.googleDriveStart));
googleDrivePublicRouter.get(
  "/callback",
  asyncHandler(ctrl.googleDriveCallback),
);

/** Authenticated admin — initiate connect, list, disconnect. */
const router = Router();
router.use(requireClerkAuth, autoProvision, resolveTenantContext);
router.use(rateLimitByTenant);
router.get(
  "/google/connect-url",
  requireRole("admin"),
  asyncHandler(ctrl.getGoogleDriveConnectUrl),
);
router.get(
  "/connections",
  requireRole("admin", "supervisor"),
  asyncHandler(ctrl.listStorageConnections),
);
router.delete(
  "/connections/:id",
  requireRole("admin"),
  asyncHandler(ctrl.disconnectStorage),
);
router.get(
  "/google/picker-config",
  requireRole("admin"),
  asyncHandler(ctrl.getPickerConfig),
);
router.post(
  "/import",
  requireRole("admin"),
  asyncHandler(ctrl.startCloudImport),
);
router.get(
  "/jobs",
  requireRole("admin", "supervisor"),
  asyncHandler(ctrl.listImportJobs),
);
router.get(
  "/onedrive/connect-url",
  requireRole("admin"),
  asyncHandler(od.getOneDriveConnectUrl),
);
router.get(
  "/onedrive/picker-config",
  requireRole("admin"),
  asyncHandler(od.getOneDrivePickerConfig),
);

export default router;

