/**
 * Google Drive OAuth for knowledge import.
 *
 * Uses a SEPARATE OAuth client from Calendar (config.googleStorage).
 * Scope is drive.file only. include_granted_scopes is always false.
 */
import axios from "axios";
import { CodeChallengeMethod, OAuth2Client } from "google-auth-library";
import { config } from "../../config/environment";
import { AppDataSource } from "../../database/data-source";
import { StorageConnection } from "../../database/entities/StorageConnection";
import { decrypt } from "../../utils/encryption";
import { logger } from "../../utils/logger";
import {
  applyTokens,
  getValidAccessToken,
  refresherFor,
  shouldRevokeProviderGrant,
  type RefreshResult,
} from "./token";
import { pkceChallenge } from "./oauth-state";

const SCOPES = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/drive.file",
];

export class GoogleStorageNotConfiguredError extends Error {
  constructor() {
    super("Google Drive storage connection is not configured");
    this.name = "GoogleStorageNotConfiguredError";
  }
}

function storageOauthClient(): OAuth2Client {
  const { clientId, clientSecret, redirectUri } = config.googleStorage;
  if (!clientId || !clientSecret || !redirectUri) {
    throw new GoogleStorageNotConfiguredError();
  }
  return new OAuth2Client(clientId, clientSecret, redirectUri);
}

export function buildGoogleAuthUrl(
  nonce: string,
  codeVerifier: string,
): string {
  const client = storageOauthClient();
  return client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: SCOPES,
    state: nonce,
    include_granted_scopes: false,
    code_challenge: pkceChallenge(codeVerifier),
    code_challenge_method: CodeChallengeMethod.S256,
  });
}

export async function verifiedIdentityFromIdToken(
  idToken: string | null | undefined,
): Promise<{ sub: string; email: string | null }> {
  if (!idToken) {
    throw new Error("Google did not return an id_token");
  }
  const client = storageOauthClient();
  const ticket = await client.verifyIdToken({
    idToken,
    audience: config.googleStorage.clientId,
  });
  const payload = ticket.getPayload();
  if (!payload?.sub) {
    throw new Error("Google id_token missing sub");
  }
  const email =
    payload.email && payload.email_verified === true ? payload.email : null;
  return { sub: payload.sub, email };
}

export async function exchangeAndStore(opts: {
  tenantId: string;
  userId: string;
  code: string;
  codeVerifier: string;
}): Promise<StorageConnection> {
  const client = storageOauthClient();
  const { tokens } = await client.getToken({
    code: opts.code,
    codeVerifier: opts.codeVerifier,
  });
  if (!tokens.access_token) {
    throw new Error("Google did not return an access token");
  }
  const { sub, email } = await verifiedIdentityFromIdToken(tokens.id_token);
  const repo = AppDataSource.getRepository(StorageConnection);
  let row = await repo.findOne({
    where: {
      tenantId: opts.tenantId,
      provider: "google_drive",
      providerAccountId: sub,
    },
  });
  if (!row) {
    row = repo.create({
      tenantId: opts.tenantId,
      provider: "google_drive",
      providerAccountId: sub,
      accountEmail: email,
      status: "active",
      reauthRequired: false,
      connectedByUserId: opts.userId,
      accessTokenEnc: "pending",
      refreshTokenEnc: null,
    });
  }
  row.status = "active";
  row.accountEmail = email ?? row.accountEmail;
  row.connectedByUserId = opts.userId;
  applyTokens(row, {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token ?? null,
    expiry: tokens.expiry_date ? new Date(tokens.expiry_date) : null,
  });
  return repo.save(row);
}

export async function refreshGoogleAccessToken(
  refreshToken: string,
): Promise<RefreshResult> {
  const client = storageOauthClient();
  client.setCredentials({ refresh_token: refreshToken });
  const { token } = await client.getAccessToken();
  if (!token) {
    throw new Error("Google did not return an access token");
  }
  return {
    accessToken: token,
    refreshToken: client.credentials.refresh_token ?? null,
    expiry: client.credentials.expiry_date
      ? new Date(client.credentials.expiry_date)
      : null,
  };
}

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
