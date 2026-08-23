/**
 * OneDrive storage connect endpoints.
 *
 * - GET  /knowledge/storage/onedrive/connect-url (auth)
 * - GET  /knowledge/storage/onedrive/start (public)
 * - GET  /knowledge/storage/onedrive/callback (public)
 * - GET  /knowledge/storage/onedrive/picker-config (auth)
 */
import type { Request, Response } from "express";
import { config } from "../../config/environment";
import { requireFeature } from "../../billing/enforce";
import { sendSuccess } from "../../utils/response";
import {
  assertCanConnectStorage,
  CLOUD_IMPORT_ERROR,
  makeStorageOAuthFlow,
} from "./oauth-flow";
import {
  buildOneDriveAuthUrl,
  exchangeAndStoreOneDrive,
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

export async function getOneDrivePickerConfig(
  req: Request,
  res: Response,
): Promise<void> {
  assertCanConnectStorage(req);
  await requireFeature(req.tenantId!, "cloudImport", CLOUD_IMPORT_ERROR);
  sendSuccess(res, { clientId: config.microsoftStorage.clientId || null });
}
