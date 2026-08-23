/**
 * OneDrive OAuth + Graph file access for knowledge import.
 * Separate Azure app from Calendar. Scopes: Files.Read, offline_access, User.Read.
 */
import axios from "axios";
import { config } from "../../config/environment";
import { AppDataSource } from "../../database/data-source";
import { StorageConnection } from "../../database/entities/StorageConnection";
import { applyTokens, type RefreshResult } from "./token";
import { pkceChallenge } from "./oauth-state";
import { KB_DOCX, KB_PDF, MAX_IMPORT_BYTES } from "./import-mime";

const AUTHORIZE_URL =
  "https://login.microsoftonline.com/common/oauth2/v2.0/authorize";
const TOKEN_URL = "https://login.microsoftonline.com/common/oauth2/v2.0/token";
const GRAPH = "https://graph.microsoft.com/v1.0";
const SCOPES = ["offline_access", "openid", "email", "User.Read", "Files.Read"];
const SCOPE_PARAM = SCOPES.join(" ");

export class OneDriveNotConfiguredError extends Error {
  constructor() {
    super("OneDrive storage integration is not configured");
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
  const me = await axios.get(`${GRAPH}/me`, {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
    timeout: 8000,
  });
  const sub = String(me.data.id || "");
  if (!sub) throw new Error("Microsoft /me missing id");
  const email = (me.data.mail || me.data.userPrincipalName || null) as
    | string
    | null;
  const repo = AppDataSource.getRepository(StorageConnection);
  let row = await repo.findOne({
    where: {
      tenantId: opts.tenantId,
      provider: "onedrive",
      providerAccountId: sub,
    },
  });
  if (!row) {
    row = repo.create({
      tenantId: opts.tenantId,
      provider: "onedrive",
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
    expiry: tokens.expires_in
      ? new Date(Date.now() + tokens.expires_in * 1000)
      : null,
  });
  return repo.save(row);
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

export async function listOneDriveFiles(
  accessToken: string,
): Promise<
  Array<{ id: string; name: string; mimeType: string; size: number }>
> {
  const resp = await axios.get(`${GRAPH}/me/drive/root/children`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    params: {
      $select: "id,name,file,size,folder",
      $top: 50,
    },
    timeout: 15000,
  });
  const items = (resp.data.value || []) as Array<{
    id: string;
    name: string;
    size?: number;
    folder?: unknown;
    file?: { mimeType?: string };
  }>;
  const allowed = new Set([KB_PDF, KB_DOCX]);
  return items
    .filter(
      (it) => !it.folder && it.file?.mimeType && allowed.has(it.file.mimeType),
    )
    .map((it) => ({
      id: it.id,
      name: it.name,
      mimeType: it.file!.mimeType!,
      size: it.size ?? 0,
    }));
}

export async function fetchOneDriveMeta(
  accessToken: string,
  fileId: string,
): Promise<{ name: string; mimeType: string }> {
  const meta = await axios.get(
    `${GRAPH}/me/drive/items/${encodeURIComponent(fileId)}`,
    {
      headers: { Authorization: `Bearer ${accessToken}` },
      params: { $select: "id,name,size,file" },
      timeout: 15000,
    },
  );
  return {
    name: String(meta.data.name || "file"),
    mimeType: String(meta.data.file?.mimeType || ""),
  };
}

/** Stream the content endpoint through a byte-capped reader — never buffer first. */
export async function downloadOneDriveContent(
  accessToken: string,
  fileId: string,
): Promise<Buffer> {
  const res = await axios.get(
    `${GRAPH}/me/drive/items/${encodeURIComponent(fileId)}/content`,
    {
      headers: { Authorization: `Bearer ${accessToken}` },
      responseType: "stream",
      timeout: 60000,
      maxRedirects: 5,
    },
  );
  return readCappedStream(res.data, MAX_IMPORT_BYTES);
}

async function readCappedStream(
  stream: AsyncIterable<Buffer>,
  maxBytes: number,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let n = 0;
  for await (const chunk of stream) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    n += buf.length;
    if (n > maxBytes) throw new Error("File exceeds the size limit");
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}
