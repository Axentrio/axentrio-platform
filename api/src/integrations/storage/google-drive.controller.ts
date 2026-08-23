/**
 * Google Drive storage connect endpoints.
 *
 * - GET  /knowledge/storage/google/connect-url (auth) → startUrl the portal opens
 * - GET  /knowledge/storage/google/start (public) → set cookie, 302 to Google
 * - GET  /knowledge/storage/google/callback (public) → exchange, bounce to portal
 * - GET  /knowledge/storage/connections (auth) → list + health probe
 * - DELETE /knowledge/storage/connections/:id (auth) → disconnect
 */
import type { Request, Response } from "express";
import { config } from "../../config/environment";
import {
  redirectToKnowledge,
  storageApiBase as apiBase,
} from "./portal-redirects";
import { AppDataSource } from "../../database/data-source";
import { User } from "../../database/entities/User";
import { requireFeature } from "../../billing/enforce";
import { ApiError } from "../../middleware/error-handler";
import { sendSuccess } from "../../utils/response";
import { logger } from "../../utils/logger";
import { logAudit } from "../../utils/audit";
import { In } from "typeorm";
import {
  buildGoogleAuthUrl,
  disconnectStorageConnection,
  exchangeAndStore,
  listTenantConnections,
  probeConnection,
} from "./google-drive.service";
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
import { enqueueStorageImport } from "./import.service";
import { StorageImportJob } from "../../database/entities/StorageImportJob";

const CLOUD_IMPORT_ERROR = "plan_feature_cloud_import";

export function assertCanConnectStorage(req: Request): void {
  const user = req.user;
  if (!user || !req.userId) {
    throw new ApiError("Unauthorized", 401, "UNAUTHORIZED");
  }
  if (user.role === "super_admin" && req.tenantId !== user.tenantId) {
    throw new ApiError(
      "Cannot connect cloud storage while impersonating a tenant",
      403,
      "impersonated_connect_forbidden",
    );
  }
}

function redirectToGoogleConsent(res: Response, url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    redirectToKnowledge(res, "error");
    return;
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.hostname !== "accounts.google.com"
  ) {
    logger.error("[Google Drive] blocked unexpected consent host", {
      host: parsed.hostname,
    });
    redirectToKnowledge(res, "error");
    return;
  }
  // Host allowlisted to accounts.google.com. Origin is a string literal.
  // pi-lens-ignore: ast-grep:no-open-redirect-js
  // pi-lens-ignore: ts-open-redirect
  res.statusCode = 302;
  res.setHeader(
    "Location",
    `https://accounts.google.com${parsed.pathname}${parsed.search}`,
  );
  res.end();
}

export async function getGoogleDriveConnectUrl(
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
    provider: "google_drive",
    codeVerifier,
    purpose: "storage-connect",
  });

  sendSuccess(res, {
    startUrl: `${apiBase()}/api/v1/knowledge/storage/google/start?n=${encodeURIComponent(nonce)}`,
  });
}

/** Public: browser navigates here so Set-Cookie is same-site, then 302 to Google. */
export async function googleDriveStart(
  req: Request,
  res: Response,
): Promise<void> {
  const nonce = typeof req.query.n === "string" ? req.query.n : "";
  if (!nonce) {
    return void redirectToKnowledge(res, "error");
  }
  try {
    const state = await peekOAuthState(nonce);
    const url = buildGoogleAuthUrl(nonce, state.codeVerifier);
    setOAuthCookie(res, nonce);
    return void redirectToGoogleConsent(res, url);
  } catch (err) {
    logger.warn("[Google Drive] start failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return void redirectToKnowledge(res, "error");
  }
}

export async function googleDriveCallback(
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
    await exchangeAndStore({
      tenantId: stored.tenantId,
      userId: stored.userId,
      code,
      codeVerifier: stored.codeVerifier,
    });
    clearOAuthCookie(res);
    return void redirectToKnowledge(res, "connected");
  } catch (err) {
    logger.error("[Google Drive] OAuth callback failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    clearOAuthCookie(res);
    return void redirectToKnowledge(res, "error");
  }
}

export async function listStorageConnections(
  req: Request,
  res: Response,
): Promise<void> {
  const tenantId = req.tenantId!;
  await requireFeature(tenantId, "cloudImport", CLOUD_IMPORT_ERROR);
  const connections = await listTenantConnections(tenantId);
  await Promise.all(connections.map((c) => probeConnection(c)));

  const userIds = [...new Set(connections.map((c) => c.connectedByUserId))];
  const users = userIds.length
    ? await AppDataSource.getRepository(User).find({
        where: { id: In(userIds) },
        select: ["id", "name", "email"],
      })
    : [];
  const byId = new Map(users.map((u) => [u.id, u]));

  sendSuccess(res, {
    connections: connections.map((c) => {
      const owner = byId.get(c.connectedByUserId);
      return {
        id: c.id,
        provider: c.provider,
        accountEmail: c.accountEmail,
        reauthRequired: c.reauthRequired,
        connectedByUserId: c.connectedByUserId,
        connectedByName: owner?.name ?? owner?.email ?? null,
        createdAt: c.createdAt,
      };
    }),
  });
}

export async function disconnectStorage(
  req: Request,
  res: Response,
): Promise<void> {
  assertCanConnectStorage(req);
  const tenantId = req.tenantId!;
  const id = req.params.id;
  if (!id) throw new ApiError("Connection id is required", 400, "BAD_REQUEST");
  await disconnectStorageConnection(tenantId, id);
  await logAudit(req.userId!, "knowledge.storage.disconnect", "storage_connection", id, tenantId);
  sendSuccess(res, { disconnected: true });
}


export async function getPickerConfig(req: Request, res: Response): Promise<void> {
  assertCanConnectStorage(req);
  await requireFeature(req.tenantId!, "cloudImport", CLOUD_IMPORT_ERROR);
  const { clientId, pickerApiKey } = config.googleStorage;
  sendSuccess(res, {
    clientId: clientId || null,
    pickerApiKey: pickerApiKey || null,
  });
}

export async function startCloudImport(req: Request, res: Response): Promise<void> {
  assertCanConnectStorage(req);
  const tenantId = req.tenantId!;
  await requireFeature(tenantId, "cloudImport", CLOUD_IMPORT_ERROR);
  const body = req.body as {
    storageConnectionId?: string;
    files?: Array<{ id: string; name?: string; mimeType?: string; size?: number }>;
    googleAccessToken?: string;
    kbId?: string;
  };
  if (!body.storageConnectionId) {
    throw new ApiError("storageConnectionId is required", 400, "BAD_REQUEST");
  }
  const result = await enqueueStorageImport({
    tenantId,
    userId: req.userId!,
    kbId: body.kbId,
    storageConnectionId: body.storageConnectionId,
    files: body.files ?? [],
    googleAccessToken: body.googleAccessToken,
  });
  await logAudit(req.userId!, "knowledge.storage.import", "storage_connection", body.storageConnectionId, tenantId, {
    provider: "google_drive",
    fileCount: (body.files ?? []).length,
    fileIds: (body.files ?? []).map((f) => f.id),
  });
  sendSuccess(res, result);
}

export async function listImportJobs(req: Request, res: Response): Promise<void> {
  const tenantId = req.tenantId!;
  await requireFeature(tenantId, "cloudImport", CLOUD_IMPORT_ERROR);
  const kbId = typeof req.query.kbId === "string" ? req.query.kbId : undefined;
  const repo = AppDataSource.getRepository(StorageImportJob);
  const jobs = await repo.find({
    where: kbId ? { tenantId, knowledgeBaseId: kbId } : { tenantId },
    order: { createdAt: "DESC" },
    take: 100,
  });
  sendSuccess(res, {
    jobs: jobs.map((j) => ({
      id: j.id,
      fileId: j.fileId,
      provider: j.provider,
      status: j.status,
      error: j.error,
      documentId: j.documentId,
      createdAt: j.createdAt,
    })),
  });
}
