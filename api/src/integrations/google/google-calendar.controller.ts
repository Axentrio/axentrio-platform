/**
 * Google Calendar connect endpoints (Phase 1, slice #8).
 *
 * - GET /integrations/google/connect-url (auth) → signed consent URL the portal opens.
 * - GET /integrations/google/callback (public) → Google redirects here; exchange
 *   code, store credential, bounce back to the portal.
 * - GET /integrations/google/status (auth) → connection state.
 * - DELETE /integrations/google/disconnect (auth) → revoke + remove.
 */
import { Request, Response } from 'express';
import { config } from '../../config/environment';
import { getAnchorBotConfig } from '../../services/bot-config.service';
import { requireFeature } from '../../billing/enforce';
import { sendSuccess } from '../../utils/response';
import { logger } from '../../utils/logger';
import {
  buildConnectUrl,
  validateState,
  exchangeAndStore,
  getActiveCredential,
  disconnect,
} from './google-calendar.service';

const CALENDAR_FEATURE_ERROR = 'plan_feature_calendar_integrations';

/** Where to send the browser after the OAuth callback. */
function portalBase(): string {
  const origin = config.cors.origin;
  if (typeof origin === 'string' && origin.startsWith('http')) return origin;
  if (Array.isArray(origin) && origin[0]?.startsWith('http')) return origin[0];
  return 'https://chatbot-portal-production-5a54.up.railway.app';
}

export async function getGoogleConnectUrl(req: Request, res: Response): Promise<void> {
  const tenantId = (req as { tenantId?: string }).tenantId!;
  await requireFeature(tenantId, 'calendarIntegrations', CALENDAR_FEATURE_ERROR);
  const { bot } = await getAnchorBotConfig(tenantId);
  sendSuccess(res, { url: buildConnectUrl(tenantId, bot.id) });
}

export async function googleCallback(req: Request, res: Response): Promise<void> {
  const portal = portalBase();
  const { code, state, error } = req.query as Record<string, string | undefined>;
  if (error || !code || !state) {
    return void res.redirect(`${portal}/settings?google=error`);
  }
  try {
    const { tenantId, botId } = validateState(state);
    await exchangeAndStore(tenantId, botId, code);
    return void res.redirect(`${portal}/settings?google=connected`);
  } catch (err) {
    logger.error('[Google] OAuth callback failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return void res.redirect(`${portal}/settings?google=error`);
  }
}

export async function getGoogleStatus(req: Request, res: Response): Promise<void> {
  const tenantId = (req as { tenantId?: string }).tenantId!;
  const { bot } = await getAnchorBotConfig(tenantId);
  const cred = await getActiveCredential(bot.id);
  sendSuccess(res, {
    connected: !!cred,
    accountEmail: cred?.accountEmail ?? null,
    calendarId: cred?.calendarId ?? null,
  });
}

export async function disconnectGoogle(req: Request, res: Response): Promise<void> {
  const tenantId = (req as { tenantId?: string }).tenantId!;
  const { bot } = await getAnchorBotConfig(tenantId);
  await disconnect(bot.id);
  sendSuccess(res, { connected: false });
}
