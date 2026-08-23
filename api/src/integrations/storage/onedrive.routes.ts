import { Router } from "express";
import { asyncHandler } from "../../middleware/error-handler";
import * as od from "./onedrive.controller";

/** Public — browser navigates here (start hop + Microsoft redirect). */
export const oneDrivePublicRouter = Router();
oneDrivePublicRouter.get("/start", asyncHandler(od.oneDriveStart));
oneDrivePublicRouter.get("/callback", asyncHandler(od.oneDriveCallback));
