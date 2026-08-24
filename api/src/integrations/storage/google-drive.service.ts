/**
 * Google Drive OAuth for knowledge import.
 *
 * Uses a SEPARATE OAuth client from Calendar (config.googleStorage).
 * Scope is drive.file only. include_granted_scopes is always false.
 */
import { CodeChallengeMethod, OAuth2Client } from "google-auth-library";
import { config } from "../../config/environment";
import { StorageConnection } from "../../database/entities/StorageConnection";
import { type RefreshResult } from "./token";
import { upsertConnection } from "./connections";
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
  return upsertConnection({
    tenantId: opts.tenantId,
    userId: opts.userId,
    provider: "google_drive",
    providerAccountId: sub,
    accountEmail: email,
    tokens: {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token ?? null,
      expiry: tokens.expiry_date ? new Date(tokens.expiry_date) : null,
    },
  });
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

