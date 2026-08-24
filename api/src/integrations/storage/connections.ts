/**
 * Provider-neutral StorageConnection operations shared by Google Drive and
 * OneDrive. Lives outside google-drive.* so a third provider reuses it as-is.
 */
import axios from "axios";
import { ApiError } from "../../middleware/error-handler";
import { AppDataSource } from "../../database/data-source";
import {
  StorageConnection,
  type StorageProvider,
} from "../../database/entities/StorageConnection";
import { decrypt } from "../../utils/encryption";
import { logger } from "../../utils/logger";
import {
  applyTokens,
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

export interface ConnectionUpsert {
  tenantId: string;
  userId: string;
  provider: StorageProvider;
  providerAccountId: string;
  accountEmail: string | null;
  tokens: { accessToken: string; refreshToken: string | null; expiry: Date | null };
}

/** Find-or-create the tenant's connection for this provider account, then
 *  apply fresh tokens. Shared by the Google and OneDrive OAuth exchanges. */
export async function upsertConnection(opts: ConnectionUpsert): Promise<StorageConnection> {
  const repo = AppDataSource.getRepository(StorageConnection);
  let row = await repo.findOne({
    where: {
      tenantId: opts.tenantId,
      provider: opts.provider,
      providerAccountId: opts.providerAccountId,
    },
  });
  if (!row) {
    row = repo.create({
      tenantId: opts.tenantId,
      provider: opts.provider,
      providerAccountId: opts.providerAccountId,
      accountEmail: opts.accountEmail,
      status: "active",
      reauthRequired: false,
      connectedByUserId: opts.userId,
      accessTokenEnc: "pending",
      refreshTokenEnc: null,
    });
  }
  row.status = "active";
  row.accountEmail = opts.accountEmail ?? row.accountEmail;
  row.connectedByUserId = opts.userId;
  applyTokens(row, opts.tokens);
  return repo.save(row);
}

/**
 * Bind a picker selection to the stored connection. The picker token's account
 * id (from the provider's identity endpoint) must equal providerAccountId. The
 * stored connection token cannot prove this: it always matches its own row.
 */
export async function assertAccountMatch(opts: {
  providerLabel: string;
  meUrl: string;
  /** JSON path of the account id inside the identity response ("sub" or "id"). */
  accountIdField: "sub" | "id";
  providerAccountId: string;
  pickerAccessToken: string | undefined;
}): Promise<void> {
  const mismatch = (message: string) =>
    new ApiError(message, 400, "storage_account_mismatch");
  if (!opts.pickerAccessToken) {
    throw mismatch(`${opts.providerLabel} account proof is required`);
  }
  let accountId: string | undefined;
  try {
    const me = await axios.get(opts.meUrl, {
      headers: { Authorization: `Bearer ${opts.pickerAccessToken}` },
      timeout: 8000,
    });
    accountId = me.data?.[opts.accountIdField];
  } catch {
    throw mismatch(`${opts.providerLabel} account proof failed`);
  }
  if (!accountId || accountId !== opts.providerAccountId) {
    throw mismatch(
      `${opts.providerLabel} account does not match the connected drive`,
    );
  }
}
