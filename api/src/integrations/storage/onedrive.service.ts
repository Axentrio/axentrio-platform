/**
 * OneDrive OAuth + Graph file access for knowledge import.
 * Separate Azure app from Calendar. Scopes: Files.Read, offline_access, User.Read.
 */
import axios from "axios";
import { config } from "../../config/environment";
import { StorageConnection } from "../../database/entities/StorageConnection";
import { type RefreshResult } from "./token";
import { upsertConnection } from "./connections";
import { pkceChallenge } from "./oauth-state";
import { MAX_IMPORT_BYTES } from "./import-mime";
import { readCappedStream } from "./capped-stream";

const AUTHORIZE_URL =
  "https://login.microsoftonline.com/common/oauth2/v2.0/authorize";
const TOKEN_URL = "https://login.microsoftonline.com/common/oauth2/v2.0/token";
const GRAPH = "https://graph.microsoft.com/v1.0";
const SCOPES = ["offline_access", "openid", "email", "User.Read", "Files.Read"];
const SCOPE_PARAM = SCOPES.join(" ");
/** Well-known tenant id for personal Microsoft accounts. */
const MSA_CONSUMER_TID = "9188040d-6c67-4c5b-b112-36a304b66dad";

function tenantIdFromIdToken(idToken: string | undefined): string | null {
  if (!idToken) return null;
  const parts = idToken.split(".");
  if (parts.length < 2) return null;
  try {
    const payload = JSON.parse(
      Buffer.from(parts[1], "base64url").toString("utf8"),
    ) as { tid?: string };
    return typeof payload.tid === "string" ? payload.tid : null;
  } catch {
    return null;
  }
}

export class OneDriveNotConfiguredError extends Error {
  constructor() {
    super("OneDrive storage connection is not configured");
    this.name = "OneDriveNotConfiguredError";
  }
}

function ensureConfigured(): void {
  const { clientId, clientSecret, redirectUri } = config.microsoftStorage;
  if (!clientId || !clientSecret || !redirectUri) {
    throw new OneDriveNotConfiguredError();
  }
}

export function buildOneDriveAuthUrl(
  nonce: string,
  codeVerifier: string,
): string {
  ensureConfigured();
  const params = new URLSearchParams({
    client_id: config.microsoftStorage.clientId,
    response_type: "code",
    redirect_uri: config.microsoftStorage.redirectUri,
    response_mode: "query",
    scope: SCOPE_PARAM,
    state: nonce,
    code_challenge: pkceChallenge(codeVerifier),
    code_challenge_method: "S256",
    prompt: "consent",
  });
  return `${AUTHORIZE_URL}?${params.toString()}`;
}

interface MsTokenResponse {
  access_token: string;
  refresh_token?: string;
  id_token?: string;
  expires_in?: number;
}

async function tokenRequest(
  extra: Record<string, string>,
): Promise<MsTokenResponse> {
  ensureConfigured();
  const body = new URLSearchParams({
    client_id: config.microsoftStorage.clientId,
    client_secret: config.microsoftStorage.clientSecret,
    redirect_uri: config.microsoftStorage.redirectUri,
    scope: SCOPE_PARAM,
    ...extra,
  });
  const resp = await axios.post(TOKEN_URL, body.toString(), {
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    timeout: 12000,
  });
  return resp.data as MsTokenResponse;
}

export async function exchangeAndStoreOneDrive(opts: {
  tenantId: string;
  userId: string;
  code: string;
  codeVerifier: string;
}): Promise<StorageConnection> {
  const tokens = await tokenRequest({
    grant_type: "authorization_code",
    code: opts.code,
    code_verifier: opts.codeVerifier,
  });
  if (!tokens.access_token)
    throw new Error("Microsoft did not return an access token");
  const tid = tenantIdFromIdToken(tokens.id_token);
  // Picker v8 in this slice is the consumer host (onedrive.live.com).
  // A work account can complete /common connect, then cannot pick.
  if (tid && tid !== MSA_CONSUMER_TID) {
    throw new Error(
      "OneDrive import supports personal Microsoft accounts only",
    );
  }
  const me = await axios.get(`${GRAPH}/me`, {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
    timeout: 8000,
  });
  const sub = String(me.data.id || "");
  if (!sub) throw new Error("Microsoft /me missing id");
  const email = (me.data.mail || me.data.userPrincipalName || null) as
    | string
    | null;
  return upsertConnection({
    tenantId: opts.tenantId,
    userId: opts.userId,
    provider: "onedrive",
    providerAccountId: sub,
    accountEmail: email,
    tokens: {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token ?? null,
      expiry: tokens.expires_in
        ? new Date(Date.now() + tokens.expires_in * 1000)
        : null,
    },
  });
}

export async function refreshOneDriveAccessToken(
  refreshToken: string,
): Promise<RefreshResult> {
  const tokens = await tokenRequest({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });
  if (!tokens.access_token)
    throw new Error("Microsoft did not return an access token");
  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token ?? null,
    expiry: tokens.expires_in
      ? new Date(Date.now() + tokens.expires_in * 1000)
      : null,
  };
}


export async function fetchOneDriveMeta(
  accessToken: string,
  fileId: string,
  driveId?: string | null,
): Promise<{ name: string; mimeType: string }> {
  const meta = await axios.get(driveItemUrl(fileId, driveId), {
    headers: { Authorization: `Bearer ${accessToken}` },
    params: { $select: "id,name,size,file" },
    timeout: 15000,
  });
  return {
    name: String(meta.data.name || "file"),
    mimeType: String(meta.data.file?.mimeType || ""),
  };
}

/**
 * Picker v8 items are addressed per drive ({@link driveId} from the pick
 * command); plain connection listings address the user's default drive.
 */
function driveItemUrl(fileId: string, driveId?: string | null): string {
  const id = encodeURIComponent(fileId);
  return driveId
    ? `${GRAPH}/drives/${encodeURIComponent(driveId)}/items/${id}`
    : `${GRAPH}/me/drive/items/${id}`;
}

/** Stream the content endpoint through a byte-capped reader — never buffer first. */
export async function downloadOneDriveContent(
  accessToken: string,
  fileId: string,
  driveId?: string | null,
): Promise<Buffer> {
  const res = await axios.get(
    `${driveItemUrl(fileId, driveId)}/content`,
    {
      headers: { Authorization: `Bearer ${accessToken}` },
      responseType: "stream",
      timeout: 60000,
      maxRedirects: 5,
    },
  );
  return readCappedStream(res.data, MAX_IMPORT_BYTES);
}
