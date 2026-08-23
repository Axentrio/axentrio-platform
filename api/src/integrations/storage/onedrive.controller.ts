import type { Request, Response } from "express";
import { config } from "../../config/environment";
import {
  redirectToKnowledge,
  storageApiBase as apiBase,
} from "./portal-redirects";
import { requireFeature } from "../../billing/enforce";
import { ApiError } from "../../middleware/error-handler";
import { sendSuccess } from "../../utils/response";
import { logger } from "../../utils/logger";
import { AppDataSource } from "../../database/data-source";
import { StorageConnection } from "../../database/entities/StorageConnection";
import { getValidAccessToken } from "./token";
import { assertCanConnectStorage } from "./google-drive.controller";
import {
  buildOneDriveAuthUrl,
  exchangeAndStoreOneDrive,
  listOneDriveFiles,
  refreshOneDriveAccessToken,
} from "./onedrive.service";
import {
  clearOAuthCookie,
  newNonce,
  nonceFromCookie,
  peekOAuthState,
  pkceVerifier,
  putOAuthState,
  readOAuthCookie,
  setOAuthCookie,
  takeOAuthState,
} from "./oauth-state";

const CLOUD_IMPORT_ERROR = "plan_feature_cloud_import";

function redirectToMsConsent(res: Response, url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    redirectToKnowledge(res, "error");
    return;
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.hostname !== "login.microsoftonline.com"
  ) {
    redirectToKnowledge(res, "error");
    return;
  }
  res.statusCode = 302;
  res.setHeader(
    "Location",
    `https://login.microsoftonline.com${parsed.pathname}${parsed.search}`,
  );
  res.end();
}

export async function getOneDriveConnectUrl(
  req: Request,
  res: Response,
): Promise<void> {
  assertCanConnectStorage(req);
  const tenantId = req.tenantId!;
  await requireFeature(tenantId, "cloudImport", CLOUD_IMPORT_ERROR);
  const nonce = newNonce();
  const codeVerifier = pkceVerifier();
  await putOAuthState(nonce, {
    tenantId,
    userId: req.userId!,
    provider: "onedrive",
    codeVerifier,
    purpose: "storage-connect",
  });
  sendSuccess(res, {
    startUrl: `${apiBase()}/api/v1/knowledge/storage/onedrive/start?n=${encodeURIComponent(nonce)}`,
  });
}

export async function oneDriveStart(
  req: Request,
  res: Response,
): Promise<void> {
  const nonce = typeof req.query.n === "string" ? req.query.n : "";
  if (!nonce) {
    return void redirectToKnowledge(res, "error");
  }
  try {
    const state = await peekOAuthState(nonce);
    const url = buildOneDriveAuthUrl(nonce, state.codeVerifier);
    setOAuthCookie(res, nonce);
    return void redirectToMsConsent(res, url);
  } catch (err) {
    logger.warn("[OneDrive] start failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return void redirectToKnowledge(res, "error");
  }
}

export async function oneDriveCallback(
  req: Request,
  res: Response,
): Promise<void> {
  const { code, state, error } = req.query as Record<
    string,
    string | undefined
  >;
  if (error || !code || !state) {
    clearOAuthCookie(res);
    return void redirectToKnowledge(res, "error");
  }
  try {
    const cookieNonce = nonceFromCookie(readOAuthCookie(req));
    if (!cookieNonce || cookieNonce !== state) {
      throw new ApiError("OAuth state mismatch", 400, "oauth_state_invalid");
    }
    const stored = await takeOAuthState(state);
    await requireFeature(stored.tenantId, "cloudImport", CLOUD_IMPORT_ERROR);
    await exchangeAndStoreOneDrive({
      tenantId: stored.tenantId,
      userId: stored.userId,
      code,
      codeVerifier: stored.codeVerifier,
    });
    clearOAuthCookie(res);
    return void redirectToKnowledge(res, "connected");
  } catch (err) {
    logger.error("[OneDrive] OAuth callback failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    clearOAuthCookie(res);
    return void redirectToKnowledge(res, "error");
  }
}

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

export async function getOneDrivePickerConfig(req: Request, res: Response): Promise<void> {
  assertCanConnectStorage(req);
  await requireFeature(req.tenantId!, "cloudImport", CLOUD_IMPORT_ERROR);
  sendSuccess(res, { clientId: config.microsoftStorage.clientId || null });
}
