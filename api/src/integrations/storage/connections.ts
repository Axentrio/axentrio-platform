/**
 * Provider-neutral StorageConnection operations shared by Google Drive and
 * OneDrive. Lives outside google-drive.* so a third provider reuses it as-is.
 */
import axios from "axios";
import { AppDataSource } from "../../database/data-source";
import { StorageConnection } from "../../database/entities/StorageConnection";
import { decrypt } from "../../utils/encryption";
import { logger } from "../../utils/logger";
import {
  getValidAccessToken,
  refresherFor,
  shouldRevokeProviderGrant,
} from "./token";

export async function listTenantConnections(
  tenantId: string,
): Promise<StorageConnection[]> {
  return AppDataSource.getRepository(StorageConnection).find({
    where: { tenantId, status: "active" },
    order: { createdAt: "DESC" },
  });
}

export async function probeConnection(row: StorageConnection): Promise<void> {
  if (row.reauthRequired) return;
  try {
    await getValidAccessToken(row, refresherFor(row.provider));
  } catch {
    // invalid_grant flips reauthRequired inside getValidAccessToken.
  }
}

export async function disconnectStorageConnection(
  tenantId: string,
  connectionId: string,
): Promise<void> {
  const repo = AppDataSource.getRepository(StorageConnection);
  const row = await repo.findOne({
    where: { id: connectionId, tenantId, status: "active" },
  });
  if (!row) return;

  const mayRevoke = await shouldRevokeProviderGrant(
    row.provider,
    row.providerAccountId,
    row.id,
  );
  if (mayRevoke && row.provider === "google_drive") {
    try {
      const token = decrypt(row.refreshTokenEnc || row.accessTokenEnc);
      await axios.post("https://oauth2.googleapis.com/revoke", null, {
        params: { token },
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        timeout: 8000,
      });
    } catch (err) {
      logger.warn("[Google Drive] token revoke failed (continuing)", {
        connectionId: row.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  } else if (mayRevoke && row.provider === "onedrive") {
    // Microsoft has no per-grant revocation endpoint (no RFC 7009 support);
    // the only API, Graph revokeSignInSessions, would kill the user's sign-in
    // for every Microsoft app including Outlook Calendar. Deleting the row
    // discards our encrypted tokens; the grant itself stays removable in the
    // user's Microsoft account settings.
    logger.info(
      "[OneDrive] local tokens discarded; no per-grant revoke exists at Microsoft",
      {
        connectionId: row.id,
        providerAccountId: row.providerAccountId,
      },
    );
  } else {
    logger.info(
      "[Storage] skip provider revoke; another tenant still holds this account",
      {
        connectionId: row.id,
        providerAccountId: row.providerAccountId,
      },
    );
  }

  await repo.delete({ id: row.id });
}
