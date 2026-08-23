/**
 * OneDrive storage connect endpoints.
 *
 * - GET  /knowledge/storage/onedrive/connect-url (auth)
 * - GET  /knowledge/storage/onedrive/start (public)
 * - GET  /knowledge/storage/onedrive/callback (public)
 * - GET  /knowledge/storage/onedrive/files (auth)
 * - GET  /knowledge/storage/onedrive/picker-config (auth)
 */
import type { Request, Response } from "express";
import { config } from "../../config/environment";
import { requireFeature } from "../../billing/enforce";
import { ApiError } from "../../middleware/error-handler";
import { sendSuccess } from "../../utils/response";
import { AppDataSource } from "../../database/data-source";
import { StorageConnection } from "../../database/entities/StorageConnection";
import { getValidAccessToken } from "./token";
import {
  assertCanConnectStorage,
  CLOUD_IMPORT_ERROR,
  makeStorageOAuthFlow,
} from "./oauth-flow";
import {
  buildOneDriveAuthUrl,
  exchangeAndStoreOneDrive,
  listOneDriveFiles,
  refreshOneDriveAccessToken,
} from "./onedrive.service";

const oneDriveFlow = makeStorageOAuthFlow({
  provider: "onedrive",
  logTag: "OneDrive",
  urlPath: "onedrive",
  consentHost: "login.microsoftonline.com",
  buildAuthUrl: buildOneDriveAuthUrl,
  exchangeAndStore: exchangeAndStoreOneDrive,
});

export const getOneDriveConnectUrl = oneDriveFlow.getConnectUrl;
export const oneDriveStart = oneDriveFlow.start;
export const oneDriveCallback = oneDriveFlow.callback;

export async function listOneDriveRootFiles(
  req: Request,
  res: Response,
): Promise<void> {
  assertCanConnectStorage(req);
  const tenantId = req.tenantId!;
  await requireFeature(tenantId, "cloudImport", CLOUD_IMPORT_ERROR);
  const connectionId =
    typeof req.query.connectionId === "string" ? req.query.connectionId : "";
  if (!connectionId)
    throw new ApiError("connectionId is required", 400, "BAD_REQUEST");
  const conn = await AppDataSource.getRepository(StorageConnection).findOne({
    where: {
      id: connectionId,
      tenantId,
      provider: "onedrive",
      status: "active",
    },
  });
  if (!conn)
    throw new ApiError("Storage connection not found", 404, "NOT_FOUND");
  const token = await getValidAccessToken(conn, refreshOneDriveAccessToken);
  const files = await listOneDriveFiles(token);
  sendSuccess(res, { files });
}

export async function getOneDrivePickerConfig(
  req: Request,
  res: Response,
): Promise<void> {
  assertCanConnectStorage(req);
  await requireFeature(req.tenantId!, "cloudImport", CLOUD_IMPORT_ERROR);
  sendSuccess(res, { clientId: config.microsoftStorage.clientId || null });
}
