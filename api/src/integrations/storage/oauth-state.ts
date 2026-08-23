/**
 * Single-use OAuth state for cloud-storage connects.
 *
 * Redis key `storage:oauth:<nonce>` holds {tenantId, userId, provider, codeVerifier,
 * purpose}. TTL 15 minutes. GETDEL on callback. Redis down = fail closed.
 * A SameSite=Lax HttpOnly cookie binds the nonce to the browser that started
 * the flow so a leaked state cannot be redeemed elsewhere.
 */
import crypto from "crypto";
import type { Request, Response } from "express";
import { getRedisClient } from "../../config/redis";
import { config } from "../../config/environment";
import { ApiError } from "../../middleware/error-handler";
import { secureCompare } from "../../utils/encryption";

export const STORAGE_OAUTH_COOKIE = "ax_storage_oauth";
export const STORAGE_OAUTH_COOKIE_PATH = "/api/v1/knowledge/storage";
const STATE_TTL_SEC = 15 * 60;
const KEY_PREFIX = "storage:oauth:";

export type StorageOAuthProvider = "google_drive" | "onedrive";

export interface StorageOAuthState {
  tenantId: string;
  userId: string;
  provider: StorageOAuthProvider;
  codeVerifier: string;
  purpose: "storage-connect";
}

export function newNonce(): string {
  return crypto.randomBytes(32).toString("base64url");
}

export function pkceVerifier(): string {
  return crypto.randomBytes(32).toString("base64url");
}

export function pkceChallenge(verifier: string): string {
  return crypto.createHash("sha256").update(verifier).digest("base64url");
}

function requireSecret(): string {
  const secret = config.googleStorage.stateSecret;
  if (!secret) {
    throw new ApiError(
      "OAuth state store unavailable",
      503,
      "oauth_state_unavailable",
    );
  }
  return secret;
}

function requireRedis() {
  const redis = getRedisClient();
  if (!redis) {
    throw new ApiError(
      "OAuth state store unavailable",
      503,
      "oauth_state_unavailable",
    );
  }
  return redis;
}

function stateKey(nonce: string): string {
  return `${KEY_PREFIX}${nonce}`;
}

export function signNonce(nonce: string): string {
  const mac = crypto
    .createHmac("sha256", requireSecret())
    .update(nonce)
    .digest("base64url");
  return `${nonce}.${mac}`;
}

export function nonceFromCookie(value: string | undefined): string | null {
  if (!value) return null;
  const dot = value.indexOf(".");
  if (dot <= 0) return null;
  const nonce = value.slice(0, dot);
  const mac = value.slice(dot + 1);
  const expected = crypto
    .createHmac("sha256", requireSecret())
    .update(nonce)
    .digest("base64url");
  if (mac.length !== expected.length || !secureCompare(mac, expected))
    return null;
  return nonce;
}

export async function putOAuthState(
  nonce: string,
  payload: StorageOAuthState,
): Promise<void> {
  if (payload.purpose !== "storage-connect") {
    throw new ApiError("OAuth state invalid", 400, "oauth_state_invalid");
  }
  const redis = requireRedis();
  try {
    await redis.set(
      stateKey(nonce),
      JSON.stringify(payload),
      "EX",
      STATE_TTL_SEC,
    );
  } catch {
    throw new ApiError(
      "OAuth state store unavailable",
      503,
      "oauth_state_unavailable",
    );
  }
}

/** Read without consuming — used by /start before redirecting to Google. */
export async function peekOAuthState(
  nonce: string,
): Promise<StorageOAuthState> {
  const redis = requireRedis();
  let raw: string | null;
  try {
    raw = await redis.get(stateKey(nonce));
  } catch {
    throw new ApiError(
      "OAuth state store unavailable",
      503,
      "oauth_state_unavailable",
    );
  }
  return parseState(raw);
}

/** Consume the state (GETDEL). Replay after this fails. */
export async function takeOAuthState(
  nonce: string,
): Promise<StorageOAuthState> {
  const redis = requireRedis();
  let raw: string | null;
  try {
    raw = await redis.getdel(stateKey(nonce));
  } catch {
    throw new ApiError(
      "OAuth state store unavailable",
      503,
      "oauth_state_unavailable",
    );
  }
  return parseState(raw);
}

function parseState(raw: string | null): StorageOAuthState {
  if (!raw) {
    throw new ApiError(
      "OAuth state expired or already used",
      400,
      "oauth_state_invalid",
    );
  }
  let parsed: StorageOAuthState;
  try {
    parsed = JSON.parse(raw) as StorageOAuthState;
  } catch {
    throw new ApiError(
      "OAuth state expired or already used",
      400,
      "oauth_state_invalid",
    );
  }
  if (
    parsed.purpose !== "storage-connect" ||
    !parsed.codeVerifier ||
    !parsed.tenantId
  ) {
    throw new ApiError(
      "OAuth state expired or already used",
      400,
      "oauth_state_invalid",
    );
  }
  return parsed;
}

export function setOAuthCookie(res: Response, nonce: string): void {
  res.cookie(STORAGE_OAUTH_COOKIE, signNonce(nonce), {
    httpOnly: true,
    sameSite: "lax",
    secure: config.server.isProduction,
    maxAge: STATE_TTL_SEC * 1000,
    path: STORAGE_OAUTH_COOKIE_PATH,
  });
}

export function clearOAuthCookie(res: Response): void {
  res.clearCookie(STORAGE_OAUTH_COOKIE, { path: STORAGE_OAUTH_COOKIE_PATH });
}

export function readOAuthCookie(req: Request): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const name = trimmed.slice(0, eq);
    if (name === STORAGE_OAUTH_COOKIE) {
      return decodeURIComponent(trimmed.slice(eq + 1));
    }
  }
  return undefined;
}
