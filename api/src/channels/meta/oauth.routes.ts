import { Router, Request, Response, NextFunction } from 'express';
import { requireClerkAuth, autoProvision } from '../../middleware/clerk.middleware';
import { logger } from '../../utils/logger';
import { config } from '../../config/environment';
import {
  buildOAuthUrl,
  validateOAuthState,
  handleOAuthCallback,
  getSessionPages,
  getCachedPageToken,
} from './oauth.service';
import { setupMetaConnections } from './setup.service';
import { requireAnyMetaChannelEntitled } from '../channel-entitlement';
import {
  ApiError,
  asyncHandler,
  BadRequestError,
  UnauthorizedError,
} from '../../middleware/error-handler';
import { sendSuccess, sendCreated } from '../../utils/response';
import { ERROR_CODES } from '../../middleware/error-codes';

const router = Router();

// Separate router for the callback — mounted before Clerk middleware
export const metaOAuthCallbackRouter = Router();

/**
 * GET /api/v1/channels/meta/oauth/url
 * Returns the Facebook Login URL for the authenticated tenant.
 */
router.get(
  '/url',
  requireClerkAuth,
  autoProvision,
  asyncHandler(async (req: Request, res: Response) => {
    const tenantId = (req as any).user?.tenantId;
    if (!tenantId) {
      throw new BadRequestError('Tenant context required');
    }

    if (!config.meta.appId || !config.meta.oauthRedirectUri) {
      throw new ApiError(
        'Meta integration not configured',
        503,
        ERROR_CODES.UPSTREAM_FAILED,
      );
    }

    // The OAuth flow serves Messenger AND Instagram — entitled to either is
    // enough to start it; per-type filtering happens at connect time.
    await requireAnyMetaChannelEntitled(tenantId);

    const url = buildOAuthUrl(tenantId);
    sendSuccess(res, { url });
  }),
);

/**
 * GET /api/v1/channels/meta/oauth/callback
 * Facebook redirects here after user grants permissions.
 * On the callback router (no Clerk auth required).
 */
metaOAuthCallbackRouter.get('/callback', async (req: Request, res: Response) => {
  const { code, state, error: oauthError } = req.query;

  if (oauthError) {
    logger.warn('[meta-oauth] User denied permissions', { error: oauthError });
    return res.redirect(`${getPortalUrl()}/settings/channels?error=denied`);
  }

  if (!code || !state) {
    return res.redirect(`${getPortalUrl()}/settings/channels?error=missing_params`);
  }

  try {
    // Validate state JWT
    const { tenantId: _tenantId } = validateOAuthState(state as string);

    // Exchange code for tokens + list pages
    const { sessionToken } = await handleOAuthCallback(code as string);

    // Redirect to portal with session token
    return res.redirect(
      `${getPortalUrl()}/settings/channels?meta_setup=${sessionToken}`,
    );
  } catch (error) {
    logger.error('[meta-oauth] Callback error:', error);
    return res.redirect(`${getPortalUrl()}/settings/channels?error=auth_failed`);
  }
});

/**
 * GET /api/v1/channels/meta/oauth/pages
 * Returns available Pages from the OAuth session.
 * On the callback router — no Clerk auth needed, session JWT is self-validating.
 */
metaOAuthCallbackRouter.get(
  '/pages',
  asyncHandler(async (req: Request, res: Response) => {
    const sessionToken = req.query.session as string;
    if (!sessionToken) {
      throw new BadRequestError('session token required');
    }

    let pages;
    try {
      pages = getSessionPages(sessionToken);
    } catch {
      throw new UnauthorizedError('Invalid or expired session');
    }
    sendSuccess(res, { pages });
  }),
);

/**
 * POST /api/v1/channels/meta/connect
 * Connect selected Pages/IG accounts for the tenant.
 */
router.post(
  '/connect',
  requireClerkAuth,
  autoProvision,
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = (req as any).user?.tenantId;
    if (!tenantId) {
      throw new BadRequestError('Tenant context required');
    }

    const { pageIds, sessionToken } = req.body as { pageIds: string[]; sessionToken: string };

    if (!sessionToken || typeof sessionToken !== 'string') {
      throw new BadRequestError('sessionToken required');
    }

    if (!pageIds || !Array.isArray(pageIds) || pageIds.length === 0) {
      throw new BadRequestError('pageIds required');
    }

    try {
      // Validate session and get page data
      const pages = getSessionPages(sessionToken);

      // Filter to selected pages and get their tokens from cache
      const selectedPages = (await Promise.all(
        pages
          .filter((p) => pageIds.includes(p.id))
          .map(async (p) => ({
            ...p,
            accessToken: (await getCachedPageToken(p.id)) || '',
          })),
      )).filter((p) => p.accessToken);

      if (selectedPages.length === 0) {
        throw new BadRequestError('No valid pages found. OAuth session may have expired.');
      }

      // Per-channel plan gate (channels plan D7/D8): entitled to at least one
      // Meta channel to proceed; setupMetaConnections filters per type and
      // never creates/subscribes a locked channel.
      await requireAnyMetaChannelEntitled(tenantId);

      // Create connections (only the entitled channel types; `skipped` lists
      // the entitlement-locked ones so the portal can surface the filtering).
      const { connections, skipped } = await setupMetaConnections(tenantId, selectedPages);

      sendCreated(res, { connections, skipped });
    } catch (err) {
      logger.error('[meta-oauth] Connect error:', err);
      // If the underlying service threw a typed ApiError (plan-limit 402,
      // upstream 502, etc.), propagate it so the global handler emits the
      // correct status. Unknown errors fall back to today's legacy 400 envelope
      // — this preserves the historical wire-shape contract for the portal
      // Cmd+K integration that drives this endpoint.
      if (err instanceof ApiError) {
        return next(err);
      }
      const message = err instanceof Error ? err.message : 'Connect failed';
      return next(new BadRequestError(message));
    }
  }),
);

function getPortalUrl(): string {
  // Derive portal URL from config
  const corsOrigins = Array.isArray(config.cors.origin) ? config.cors.origin : [config.cors.origin];
  return corsOrigins[0] || 'http://localhost:5173';
}

export default router;
