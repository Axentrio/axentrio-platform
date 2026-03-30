import { Router, Request, Response } from 'express';
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

const router = Router();

// Separate router for the callback — mounted before Clerk middleware
export const metaOAuthCallbackRouter = Router();

/**
 * GET /api/v1/channels/meta/oauth/url
 * Returns the Facebook Login URL for the authenticated tenant.
 */
router.get('/url', requireClerkAuth, autoProvision, async (req: Request, res: Response) => {
  const tenantId = (req as any).user?.tenantId;
  if (!tenantId) {
    return res.status(400).json({ error: 'Tenant context required' });
  }

  if (!config.meta.appId || !config.meta.oauthRedirectUri) {
    return res.status(503).json({ error: 'Meta integration not configured' });
  }

  const url = buildOAuthUrl(tenantId);
  return res.json({ url });
});

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
 */
router.get('/pages', requireClerkAuth, autoProvision, async (req: Request, res: Response) => {
  const sessionToken = req.query.session as string;
  if (!sessionToken) {
    return res.status(400).json({ error: 'session token required' });
  }

  try {
    const pages = getSessionPages(sessionToken);
    return res.json({ pages });
  } catch {
    return res.status(401).json({ error: 'Invalid or expired session' });
  }
});

/**
 * POST /api/v1/channels/meta/connect
 * Connect selected Pages/IG accounts for the tenant.
 */
router.post('/connect', requireClerkAuth, autoProvision, async (req: Request, res: Response) => {
  const tenantId = (req as any).user?.tenantId;
  if (!tenantId) {
    return res.status(400).json({ error: 'Tenant context required' });
  }

  const { pageIds, sessionToken } = req.body as { pageIds: string[]; sessionToken: string };

  if (!sessionToken || typeof sessionToken !== 'string') {
    return res.status(400).json({ error: 'sessionToken required' });
  }

  if (!pageIds || !Array.isArray(pageIds) || pageIds.length === 0) {
    return res.status(400).json({ error: 'pageIds required' });
  }

  try {
    // Validate session and get page data
    const pages = getSessionPages(sessionToken);

    // Filter to selected pages and get their tokens from cache
    const selectedPages = pages
      .filter((p) => pageIds.includes(p.id))
      .map((p) => ({
        ...p,
        accessToken: getCachedPageToken(p.id) || '',
      }))
      .filter((p) => p.accessToken);

    if (selectedPages.length === 0) {
      return res.status(400).json({ error: 'No valid pages found. OAuth session may have expired.' });
    }

    // Create connections
    const connections = await setupMetaConnections(tenantId, selectedPages);

    return res.status(201).json({ connections });
  } catch (error) {
    logger.error('[meta-oauth] Connect error:', error);
    const message = error instanceof Error ? error.message : 'Failed to connect';
    return res.status(400).json({ error: message });
  }
});

function getPortalUrl(): string {
  // Derive portal URL from config
  const corsOrigins = Array.isArray(config.cors.origin) ? config.cors.origin : [config.cors.origin];
  return corsOrigins[0] || 'http://localhost:5173';
}

export default router;
