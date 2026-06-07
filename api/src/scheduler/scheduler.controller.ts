/**
 * Internal scheduler config — per-tenant (anchor bot) booking configuration:
 * provider selection, the single event type, and weekly availability. The
 * portal Bookings settings page reads/writes these. Cal.com config is managed
 * separately via the integrations endpoints.
 */
import { Request, Response } from 'express';
import { AppDataSource } from '../database/data-source';
import { ServiceType } from '../database/entities/ServiceType';
import { AvailabilityRule } from '../database/entities/AvailabilityRule';
import { getAnchorBotConfig, replaceAnchorBotSettingsSection } from '../services/bot-config.service';
import { requireFeature } from '../billing/enforce';
import {
  updateSchedulerSchema,
  listBookingsQuerySchema,
  availabilityQuerySchema,
  cancelBookingBodySchema,
  rescheduleBookingBodySchema,
} from '../schemas/scheduler.schema';
import {
  adminListBookings,
  adminAvailability,
  adminCancelBooking,
  adminRescheduleBooking,
} from '../n8n/booking.service';
import { BookingError } from '../n8n/booking-providers/types';
import { ApiError } from '../middleware/error-handler';
import { sendSuccess } from '../utils/response';
import { logger } from '../utils/logger';

/** Surface a BookingError through the global handler with its real status/code. */
function asApiError(err: unknown): never {
  if (err instanceof BookingError) throw new ApiError(err.message, err.statusCode, err.code);
  throw err;
}

const CALENDAR_FEATURE_ERROR = 'plan_feature_calendar_integrations';

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'appointment';
}

async function readConfig(tenantId: string) {
  const { bot } = await getAnchorBotConfig(tenantId);
  const [eventType, availability] = await Promise.all([
    AppDataSource.getRepository(ServiceType).findOne({ where: { botId: bot.id, isActive: true } }),
    AppDataSource.getRepository(AvailabilityRule).findOne({ where: { botId: bot.id } }),
  ]);
  return {
    // Cal.com is shelved — the internal scheduler is the only provider, so we
    // normalize away any legacy `integrations.provider: 'calcom'` left on old bots.
    provider: 'internal' as const,
    eventType: eventType ?? null,
    availability: availability ?? null,
  };
}

export async function getSchedulerConfig(req: Request, res: Response): Promise<void> {
  const tenantId = (req as { tenantId?: string }).tenantId!;
  sendSuccess(res, await readConfig(tenantId));
}

export async function updateSchedulerConfig(req: Request, res: Response): Promise<void> {
  const tenantId = (req as { tenantId?: string }).tenantId!;
  const data = updateSchedulerSchema.parse(req.body);

  // Cal.com is shelved — the internal scheduler is the only backend and stays
  // gated by the same Pro+ entitlement, so every config write (provider, event
  // type, or availability) requires it. Closes the path where a sub-Pro tenant
  // could persist scheduler config by omitting `provider` from the payload.
  await requireFeature(tenantId, 'calendarIntegrations', CALENDAR_FEATURE_ERROR);
  const { bot, settings } = await getAnchorBotConfig(tenantId);

  if (data.provider) {
    // Ignore any legacy 'calcom' input — the provider is always internal now.
    await replaceAnchorBotSettingsSection(tenantId, 'integrations', {
      ...(settings.integrations ?? {}),
      provider: 'internal',
    });
  }

  if (data.eventType) {
    const repo = AppDataSource.getRepository(ServiceType);
    let et = await repo.findOne({ where: { botId: bot.id, isActive: true } });
    if (!et) et = repo.create({ tenantId, botId: bot.id, isActive: true });
    Object.assign(et, data.eventType, { slug: slugify(data.eventType.name) });
    await repo.save(et);
  }

  if (data.availability) {
    const repo = AppDataSource.getRepository(AvailabilityRule);
    let rule = await repo.findOne({ where: { botId: bot.id } });
    if (!rule) rule = repo.create({ tenantId, botId: bot.id });
    Object.assign(rule, data.availability);
    await repo.save(rule);
  }

  logger.info('[Scheduler] config updated', { tenantId, botId: bot.id, keys: Object.keys(data) });
  sendSuccess(res, await readConfig(tenantId));
}

// --- Admin bookings management ---

export async function listBookings(req: Request, res: Response): Promise<void> {
  const tenantId = (req as { tenantId?: string }).tenantId!;
  const { scope, limit, offset } = listBookingsQuerySchema.parse(req.query);
  try {
    sendSuccess(res, await adminListBookings(tenantId, scope, limit, offset));
  } catch (err) {
    asApiError(err);
  }
}

export async function getBookingAvailability(req: Request, res: Response): Promise<void> {
  const tenantId = (req as { tenantId?: string }).tenantId!;
  const { startDate, endDate } = availabilityQuerySchema.parse(req.query);
  try {
    sendSuccess(res, await adminAvailability(tenantId, startDate, endDate));
  } catch (err) {
    asApiError(err);
  }
}

export async function cancelBooking(req: Request, res: Response): Promise<void> {
  const tenantId = (req as { tenantId?: string }).tenantId!;
  const { reason } = cancelBookingBodySchema.parse(req.body ?? {});
  try {
    sendSuccess(res, await adminCancelBooking(tenantId, req.params.id, reason));
  } catch (err) {
    asApiError(err);
  }
}

export async function rescheduleBooking(req: Request, res: Response): Promise<void> {
  const tenantId = (req as { tenantId?: string }).tenantId!;
  const { newStartTime } = rescheduleBookingBodySchema.parse(req.body);
  try {
    sendSuccess(res, await adminRescheduleBooking(tenantId, req.params.id, newStartTime));
  } catch (err) {
    asApiError(err);
  }
}
