/**
 * Shared start/callback scaffolding for the per-provider cloud-storage OAuth
 * controllers. Both providers follow one shape:
 *   - /connect-url: gate on impersonation + cloudImport feature, mint a
 *     single-use nonce, hand the portal a start URL.
 *   - /start (public): set the signed-nonce cookie, 302 to the provider
 *     consent screen (hostname allowlisted).
 *   - /callback (public): cookie nonce must match the state query, consume
 *     the GETDEL Redis state, exchange the code.
 */
import type { Request, Response } from "express";
import { ApiError } from "../../middleware/error-handler";
import { requireFeature } from "../../billing/enforce";
import { sendSuccess } from "../../utils/response";
import { logger } from "../../utils/logger";
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
import {
  redirectToKnowledge,
  redirectToProviderConsent,
  storageApiBase,
} from "./portal-redirects";

export const CLOUD_IMPORT_ERROR = "plan_feature_cloud_import";

/** Super-admins may not connect storage while impersonating a tenant. */
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

export interface StorageOAuthFlow {
  provider: "google_drive" | "onedrive";
  /** Log prefix, e.g. "Google Drive". */
  logTag: string;
  /** URL path segment of this provider's public routes, e.g. "google". */
  urlPath: string;
  /** Consent-screen hostname the redirect is allowlisted to. */
  consentHost: "accounts.google.com" | "login.microsoftonline.com";
  buildAuthUrl: (nonce: string, codeVerifier: string) => string;
  exchangeAndStore: (opts: {
    tenantId: string;
    userId: string;
    code: string;
    codeVerifier: string;
  }) => Promise<unknown>;
}

export function makeStorageOAuthFlow(flow: StorageOAuthFlow) {
  async function getConnectUrl(req: Request, res: Response): Promise<void> {
    assertCanConnectStorage(req);
    const tenantId = req.tenantId!;
    await requireFeature(tenantId, "cloudImport", CLOUD_IMPORT_ERROR);
    const nonce = newNonce();
    const codeVerifier = pkceVerifier();
    await putOAuthState(nonce, {
      tenantId,
      userId: req.userId!,
      provider: flow.provider,
      codeVerifier,
      purpose: "storage-connect",
    });
    sendSuccess(res, {
      startUrl: `${storageApiBase()}/api/v1/knowledge/storage/${flow.urlPath}/start?n=${encodeURIComponent(nonce)}`,
    });
  }

  /** Public: browser navigates here so Set-Cookie is same-site, then 302. */
  async function start(req: Request, res: Response): Promise<void> {
    const nonce = typeof req.query.n === "string" ? req.query.n : "";
    if (!nonce) {
      return void redirectToKnowledge(res, "error");
    }
    try {
      const state = await peekOAuthState(nonce);
      const url = flow.buildAuthUrl(nonce, state.codeVerifier);
      setOAuthCookie(res, nonce);
      return void redirectToProviderConsent(res, url, flow.consentHost);
    } catch (err) {
      logger.warn(`[${flow.logTag}] start failed`, {
        error: err instanceof Error ? err.message : String(err),
      });
      return void redirectToKnowledge(res, "error");
    }
  }

  async function callback(req: Request, res: Response): Promise<void> {
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
      await flow.exchangeAndStore({
        tenantId: stored.tenantId,
        userId: stored.userId,
        code,
        codeVerifier: stored.codeVerifier,
      });
      clearOAuthCookie(res);
      return void redirectToKnowledge(res, "connected");
    } catch (err) {
      logger.error(`[${flow.logTag}] OAuth callback failed`, {
        error: err instanceof Error ? err.message : String(err),
      });
      clearOAuthCookie(res);
      return void redirectToKnowledge(res, "error");
    }
  }

  return { getConnectUrl, start, callback };
}
