/**
 * Shared OAuth token handling for cloud-storage connections.
 *
 * Encrypt/decrypt, refresh with a row lock, persist a rotated refresh token
 * before the new access token is used, and decide whether a disconnect may
 * call the provider's revoke endpoint.
 */
import { Not } from 'typeorm';
import { AppDataSource } from '../../database/data-source';
import {
  StorageConnection,
  type StorageProvider,
} from '../../database/entities/StorageConnection';
import { encrypt, decrypt } from '../../utils/encryption';

const EXPIRY_SKEW_MS = 60_000;

export class StorageReauthRequiredError extends Error {
  readonly code = 'STORAGE_REAUTH_REQUIRED';
  constructor(readonly reason: string) {
    super('STORAGE_REAUTH_REQUIRED');
    this.name = 'StorageReauthRequiredError';
  }
}

export interface RefreshResult {
  accessToken: string;
  refreshToken?: string | null;
  expiry: Date | null;
}

export type TokenRefresher = (refreshToken: string) => Promise<RefreshResult>;

export function isPermanentAuthFailure(err: unknown): boolean {
  const data = (err as { response?: { data?: { error?: string } } })?.response?.data;
  if (data?.error === 'invalid_grant') return true;
  const msg = err instanceof Error ? err.message : String(err);
  return /refresh token already used/i.test(msg);
}

export function applyTokens(
  row: StorageConnection,
  tokens: { accessToken: string; refreshToken?: string | null; expiry: Date | null },
): void {
  row.accessTokenEnc = encrypt(tokens.accessToken);
  if (tokens.refreshToken) {
    row.refreshTokenEnc = encrypt(tokens.refreshToken);
  }
  row.tokenExpiry = tokens.expiry;
  row.reauthRequired = false;
}

function isFresh(row: StorageConnection): boolean {
  return !!(
    row.tokenExpiry &&
    row.tokenExpiry.getTime() - Date.now() > EXPIRY_SKEW_MS &&
    !row.reauthRequired
  );
}

export async function getValidAccessToken(
  connection: StorageConnection,
  refresher: TokenRefresher,
): Promise<string> {
  if (isFresh(connection)) return decrypt(connection.accessTokenEnc);

  return AppDataSource.transaction(async (manager) => {
    const locked = await manager
      .createQueryBuilder(StorageConnection, 'c')
      .setLock('pessimistic_write')
      .where('c.id = :id', { id: connection.id })
      .getOne();

    if (!locked) {
      throw new StorageReauthRequiredError('missing');
    }

    if (isFresh(locked)) {
      Object.assign(connection, locked);
      return decrypt(locked.accessTokenEnc);
    }

    if (!locked.refreshTokenEnc) {
      locked.reauthRequired = true;
      await manager.save(locked);
      Object.assign(connection, locked);
      throw new StorageReauthRequiredError('no_refresh_token');
    }

    const refreshToken = decrypt(locked.refreshTokenEnc);
    let result: RefreshResult;
    try {
      result = await refresher(refreshToken);
    } catch (err) {
      if (isPermanentAuthFailure(err)) {
        locked.reauthRequired = true;
        await manager.save(locked);
        Object.assign(connection, locked);
        throw new StorageReauthRequiredError('invalid_grant');
      }
      throw err;
    }

    // Persist rotated refresh first so a crash cannot lose the only valid grant.
    if (result.refreshToken) {
      locked.refreshTokenEnc = encrypt(result.refreshToken);
    }
    locked.accessTokenEnc = encrypt(result.accessToken);
    locked.tokenExpiry = result.expiry;
    locked.reauthRequired = false;
    await manager.save(locked);
    Object.assign(connection, locked);
    return result.accessToken;
  });
}

export async function shouldRevokeProviderGrant(
  provider: StorageProvider,
  providerAccountId: string,
  exceptConnectionId: string,
): Promise<boolean> {
  const remaining = await AppDataSource.getRepository(StorageConnection).count({
    where: {
      provider,
      providerAccountId,
      status: 'active',
      id: Not(exceptConnectionId),
    },
  });
  return remaining === 0;
}

/**
 * Resolve the token refresher for a provider. Lazy requires keep this module
 * free of a static import cycle with the two provider services.
 */
export function refresherFor(
  provider: string,
): (refreshToken: string) => Promise<RefreshResult> {
  const google = require('./google-drive.service') as {
    refreshGoogleAccessToken: (t: string) => Promise<RefreshResult>;
  };
  const ms = require('./onedrive.service') as {
    refreshOneDriveAccessToken: (t: string) => Promise<RefreshResult>;
  };
  return provider === 'onedrive'
    ? ms.refreshOneDriveAccessToken
    : google.refreshGoogleAccessToken;
}
