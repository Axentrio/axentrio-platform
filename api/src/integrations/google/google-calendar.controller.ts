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
import { getAnchorBotConfig, getOwnedBot } from '../../services/bot-config.service';
import { requireFeature } from '../../billing/enforce';
import { sendSuccess } from '../../utils/response';
import { ValidationError } from '../../middleware/error-handler';
import { logger } from '../../utils/logger';
import {
  buildConnectUrl,
  validateState,
  exchangeAndStore,
  getActiveCredential,
  disconnect,
  listWritableCalendars,
  setBotCalendar,
  CalendarNotConnectedError,
  CalendarNotWritableError,
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
    // The connect-url was gated, but this public callback can land later — re-check
    // the entitlement and that the bot still belongs to the tenant before storing.
    await requireFeature(tenantId, 'calendarIntegrations', CALENDAR_FEATURE_ERROR);
    await getOwnedBot(botId, tenantId);
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
    needsReauth: cred?.reauthRequired ?? false,
  });
}

export async function disconnectGoogle(req: Request, res: Response): Promise<void> {
  const tenantId = (req as { tenantId?: string }).tenantId!;
  const { bot } = await getAnchorBotConfig(tenantId);
  await disconnect(bot.id);
  sendSuccess(res, { connected: false });
}

/** GET /integrations/google/calendars — writable calendars for the picker. */
export async function listGoogleCalendars(req: Request, res: Response): Promise<void> {
  const tenantId = (req as { tenantId?: string }).tenantId!;
  const { bot } = await getAnchorBotConfig(tenantId);
  const calendars = await listWritableCalendars(bot.id);
  sendSuccess(res, { calendars });
}

/** PUT /integrations/google/calendar — set the bot's write-target calendar. */
export async function setGoogleCalendar(req: Request, res: Response): Promise<void> {
  const tenantId = (req as { tenantId?: string }).tenantId!;
  await requireFeature(tenantId, 'calendarIntegrations', CALENDAR_FEATURE_ERROR);
  const calendarId = (req.body as { calendarId?: unknown })?.calendarId;
  if (!calendarId || typeof calendarId !== 'string') {
    throw new ValidationError('calendarId is required');
  }
  const { bot } = await getAnchorBotConfig(tenantId);
  try {
    const result = await setBotCalendar(bot.id, calendarId);
    sendSuccess(res, result);
  } catch (err) {
    if (err instanceof CalendarNotConnectedError) throw new ValidationError('Calendar is not connected');
    if (err instanceof CalendarNotWritableError) throw new ValidationError('Selected calendar is not writable');
    throw err;
  }
}
