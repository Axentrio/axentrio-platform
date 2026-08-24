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
import { AppDataSource } from "../../database/data-source";
import { User } from "../../database/entities/User";
import { requireFeature } from "../../billing/enforce";
import { ApiError } from "../../middleware/error-handler";
import { sendSuccess } from "../../utils/response";
import { logAudit } from "../../utils/audit";
import { In } from "typeorm";
import {
  buildGoogleAuthUrl,
  exchangeAndStore,
} from "./google-drive.service";
import {
  disconnectStorageConnection,
  listTenantConnections,
  probeConnection,
} from "./connections";
import { enqueueStorageImport } from "./import.service";
import { StorageImportJob } from "../../database/entities/StorageImportJob";
import {
  assertCanConnectStorage,
  CLOUD_IMPORT_ERROR,
  makeStorageOAuthFlow,
} from "./oauth-flow";

export { assertCanConnectStorage };

const googleFlow = makeStorageOAuthFlow({
  provider: "google_drive",
  logTag: "Google Drive",
  urlPath: "google",
  consentHost: "accounts.google.com",
  buildAuthUrl: buildGoogleAuthUrl,
  exchangeAndStore,
});

export const getGoogleDriveConnectUrl = googleFlow.getConnectUrl;
export const googleDriveStart = googleFlow.start;
export const googleDriveCallback = googleFlow.callback;

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
    files?: Array<{
      id: string;
      name?: string;
      mimeType?: string;
      size?: number;
      driveId?: string;
    }>;
    googleAccessToken?: string;
    oneDriveAccessToken?: string;
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
    oneDriveAccessToken: body.oneDriveAccessToken,
  });
  await logAudit(req.userId!, "knowledge.storage.import", "storage_connection", body.storageConnectionId, tenantId, {
    provider: result.provider,
    fileCount: (body.files ?? []).length,
    fileIds: (body.files ?? []).map((f) => f.id),
  });
    sendSuccess(res, {
    jobs: result.jobs,
    skipped: result.skipped,
  });
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
