/**
 * Microsoft / Outlook Calendar connect endpoints (P6b).
 *
 * - GET    /integrations/outlook/connect-url (auth) → signed consent URL.
 * - GET    /integrations/outlook/callback (public) → MS redirects here; exchange
 *   code, store credential (revoking any other active provider), bounce to portal.
 * - GET    /integrations/outlook/status (auth) → connection + reauth state.
 * - DELETE /integrations/outlook/disconnect (auth) → revoke.
 *
 * Status + disconnect work even when Microsoft env is unconfigured (DB-only);
 * connect-url returns a clear validation error rather than a 500.
 */
import { Request, Response } from 'express';
import { config } from '../../config/environment';
import { getAnchorBotConfig, getOwnedBot } from '../../services/bot-config.service';
import { requireFeature } from '../../billing/enforce';
import { sendSuccess } from '../../utils/response';
import { ValidationError } from '../../middleware/error-handler';
import { logger } from '../../utils/logger';
import {
  buildConnectUrl,
  validateState,
  exchangeAndStore,
  getStatus,
  disconnect,
  MicrosoftNotConfiguredError,
} from './outlook-calendar.service';

const CALENDAR_FEATURE_ERROR = 'plan_feature_calendar_integrations';

/** Where to send the browser after the OAuth callback. */
function portalBase(): string {
  const origin = config.cors.origin;
  if (typeof origin === 'string' && origin.startsWith('http')) return origin;
  if (Array.isArray(origin) && origin[0]?.startsWith('http')) return origin[0];
  return 'https://chatbot-portal-production-5a54.up.railway.app';
}

export async function getOutlookConnectUrl(req: Request, res: Response): Promise<void> {
  const tenantId = (req as { tenantId?: string }).tenantId!;
  await requireFeature(tenantId, 'calendarIntegrations', CALENDAR_FEATURE_ERROR);
  const { bot } = await getAnchorBotConfig(tenantId);
  try {
    sendSuccess(res, { url: buildConnectUrl(tenantId, bot.id) });
  } catch (err) {
    if (err instanceof MicrosoftNotConfiguredError) {
      throw new ValidationError('Microsoft integration is not configured');
    }
    throw err;
  }
}

export async function outlookCallback(req: Request, res: Response): Promise<void> {
  const portal = portalBase();
  const { code, state, error } = req.query as Record<string, string | undefined>;
  if (error || !code || !state) {
    return void res.redirect(`${portal}/bookings?outlook=error`);
  }
  try {
    const { tenantId, botId } = validateState(state);
    // The connect-url was gated, but this public callback can land later — re-check
    // the entitlement and that the bot still belongs to the tenant before storing.
    await requireFeature(tenantId, 'calendarIntegrations', CALENDAR_FEATURE_ERROR);
    await getOwnedBot(botId, tenantId);
    await exchangeAndStore(tenantId, botId, code);
    return void res.redirect(`${portal}/bookings?outlook=connected`);
  } catch (err) {
    logger.error('[Outlook] OAuth callback failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return void res.redirect(`${portal}/bookings?outlook=error`);
  }
}

export async function getOutlookStatus(req: Request, res: Response): Promise<void> {
  const tenantId = (req as { tenantId?: string }).tenantId!;
  const { bot } = await getAnchorBotConfig(tenantId);
  sendSuccess(res, await getStatus(bot.id));
}

export async function disconnectOutlook(req: Request, res: Response): Promise<void> {
  const tenantId = (req as { tenantId?: string }).tenantId!;
  const { bot } = await getAnchorBotConfig(tenantId);
  await disconnect(bot.id);
  sendSuccess(res, { connected: false });
}
