/**
 * Internal scheduler config — per-tenant (anchor bot) booking configuration:
 * provider selection, the single event type, and weekly availability. The
 * portal Bookings settings page reads/writes these. Cal.com config is managed
 * separately via the integrations endpoints.
 */
import { randomUUID } from 'crypto';
import { z } from 'zod';
import { Request, Response } from 'express';
import { AppDataSource } from '../database/data-source';
import { ServiceType, type IntakeQuestion } from '../database/entities/ServiceType';
import { AvailabilityRule } from '../database/entities/AvailabilityRule';
import { getAnchorBotConfig, replaceAnchorBotSettingsSection } from '../services/bot-config.service';
import { requireFeature } from '../billing/enforce';
import {
  updateSchedulerSchema,
  serviceInputSchema,
  serviceCreateSchema,
  serviceUpdateSchema,
  listBookingsQuerySchema,
  availabilityQuerySchema,
  cancelBookingBodySchema,
  rescheduleBookingBodySchema,
} from '../schemas/scheduler.schema';
import type { Repository, EntityManager } from 'typeorm';
import {
  adminListBookings,
  adminAvailability,
  adminCancelBooking,
  adminRescheduleBooking,
  adminAcceptRequest,
  adminDeclineRequest,
} from '../booking/booking.service';
import { findPreset, listPresetSummaries, presetServiceSchema, presetAvailabilitySchema } from './presets';
import { BookingError } from '../booking/booking-providers/types';
import { ApiError } from '../middleware/error-handler';
import { sendSuccess } from '../utils/response';
import { logger } from '../utils/logger';

/** Surface a BookingError through the global handler with its real status/code. */
function asApiError(err: unknown): never {
  if (err instanceof BookingError) throw new ApiError(err.message, err.statusCode, err.code);
  throw err;
}

/**
 * Single booking gate (plan D6/D7): every scheduler route checks the
 * `bookings` feature. `calendarSync` now means external calendar
 * sync only and is never read here.
 */
const BOOKINGS_FEATURE_ERROR = 'plan_limit_bookings';

/** Exported for the P4 preset CI invariant test (intra-preset slug-collision check). */
export function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'appointment';
}

/** Unique `(bot_id, slug)` — appends -2/-3/… on collision (enforced by a DB index). */
async function uniqueSlug(
  repo: Repository<ServiceType>,
  botId: string,
  name: string,
  excludeId?: string
): Promise<string> {
  const base = slugify(name);
  let slug = base;
  let n = 1;
  // Bounded loop — a handful of same-named services at most for a solo business.
  while (n < 1000) {
    const existing = await repo.findOne({ where: { botId, slug } });
    if (!existing || existing.id === excludeId) return slug;
    n += 1;
    slug = `${base}-${n}`;
  }
  return `${base}-${Date.now()}`;
}

/**
 * P3: reconcile submitted intake questions against the currently-stored set.
 * The server is the sole authority on ids: a submitted id is honored ONLY if it
 * matches a stored question id on this service (and not already used in this pass —
 * first-in-array wins on a duplicate); every other id (forged, stale, missing,
 * blank, or any id on create where `stored` is empty) is reminted. Stored ids
 * absent from the submission are dropped. An empty result collapses to `null`.
 */
function reconcileIntakeQuestions(
  submitted: Array<{ id?: string; label: string; type: 'text' | 'choice'; required: boolean; options?: string[] }>,
  stored: IntakeQuestion[] | null | undefined
): IntakeQuestion[] | null {
  const storedIds = new Set(
    (Array.isArray(stored) ? stored : []).map((q) => q.id).filter((id): id is string => typeof id === 'string')
  );
  const usedIds = new Set<string>();
  const out: IntakeQuestion[] = submitted.map((q) => {
    const id = q.id && storedIds.has(q.id) && !usedIds.has(q.id) ? q.id : randomUUID();
    usedIds.add(id);
    const question: IntakeQuestion = { id, label: q.label, type: q.type, required: q.required };
    if (q.type === 'choice') question.options = q.options ?? [];
    return question;
  });
  return out.length ? out : null;
}

async function readConfig(tenantId: string) {
  const { bot } = await getAnchorBotConfig(tenantId);
  const repo = AppDataSource.getRepository(ServiceType);
  const [eventType, services, availability] = await Promise.all([
    repo.findOne({ where: { botId: bot.id, isActive: true }, order: { sortOrder: 'ASC' } }),
    repo.find({ where: { botId: bot.id }, order: { sortOrder: 'ASC', createdAt: 'ASC' } }),
    AppDataSource.getRepository(AvailabilityRule).findOne({ where: { botId: bot.id } }),
  ]);
  return {
    // Cal.com is shelved — the internal scheduler is the only provider, so we
    // normalize away any legacy `integrations.provider: 'calcom'` left on old bots.
    provider: 'internal' as const,
    // `eventType` (first active) kept for back-compat with the single-service UI;
    // `services` is the full catalog (K3).
    eventType: eventType ?? null,
    services,
    availability: availability ?? null,
  };
}

export async function getSchedulerConfig(req: Request, res: Response): Promise<void> {
  const tenantId = (req as { tenantId?: string }).tenantId!;
  await requireFeature(tenantId, 'bookings', BOOKINGS_FEATURE_ERROR);
  sendSuccess(res, await readConfig(tenantId));
}

export async function updateSchedulerConfig(req: Request, res: Response): Promise<void> {
  const tenantId = (req as { tenantId?: string }).tenantId!;
  const data = updateSchedulerSchema.parse(req.body);

  // Every config write (provider, event type, or availability) requires the
  // bookings feature. Closes the path where an unentitled tenant could persist
  // scheduler config by omitting `provider` from the payload.
  await requireFeature(tenantId, 'bookings', BOOKINGS_FEATURE_ERROR);
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

// --- Services CRUD (multi-service catalog, K3) ---

export async function listServices(req: Request, res: Response): Promise<void> {
  const tenantId = (req as { tenantId?: string }).tenantId!;
  await requireFeature(tenantId, 'bookings', BOOKINGS_FEATURE_ERROR);
  const { bot } = await getAnchorBotConfig(tenantId);
  const services = await AppDataSource.getRepository(ServiceType).find({
    where: { botId: bot.id },
    order: { sortOrder: 'ASC', createdAt: 'ASC' },
  });
  sendSuccess(res, { services });
}

/**
 * Helper data = the parsed service input minus catalog-state fields, which the
 * callers supply explicitly: `isActive` falls to the entity default (true),
 * `sortOrder` is set by the preset apply loop, and `intakeQuestions` is the
 * already-reconciled value (manual path) or omitted (presets). A bespoke type
 * (not `z.infer<typeof serviceInputSchema>`, whose `.default()` fields are
 * required) so both callers type-check.
 */
type ServiceRowInput = Omit<z.infer<typeof serviceInputSchema>, 'isActive' | 'sortOrder' | 'intakeQuestions'> & {
  isActive?: boolean;
  sortOrder?: number;
  intakeQuestions?: IntakeQuestion[] | null;
};

/**
 * Single insert path for a ServiceType row, shared by manual create and preset apply
 * (so create logic can't diverge). Parsing/reconciliation happen in the CALLER; this
 * does only create + uniqueSlug + save on the given manager.
 */
async function createServiceRow(
  manager: EntityManager,
  tenantId: string,
  botId: string,
  data: ServiceRowInput
): Promise<ServiceType> {
  const repo = manager.getRepository(ServiceType);
  const svc = repo.create({ tenantId, botId, ...data, slug: await uniqueSlug(repo, botId, data.name) });
  return repo.save(svc);
}

export async function createService(req: Request, res: Response): Promise<void> {
  const tenantId = (req as { tenantId?: string }).tenantId!;
  await requireFeature(tenantId, 'bookings', BOOKINGS_FEATURE_ERROR);
  const data = serviceCreateSchema.parse(req.body);
  const { bot } = await getAnchorBotConfig(tenantId);
  const { intakeQuestions, ...rest } = data;
  // Reconcile intake ids before the shared insert (manual path only; presets carry none).
  const reconciled = intakeQuestions !== undefined ? reconcileIntakeQuestions(intakeQuestions, null) : undefined;
  const svc = await createServiceRow(AppDataSource.manager, tenantId, bot.id, {
    ...rest,
    ...(reconciled !== undefined ? { intakeQuestions: reconciled } : {}),
  });
  logger.info('[Scheduler] service created', { tenantId, botId: bot.id, serviceId: svc.id });
  sendSuccess(res, svc);
}

export async function updateService(req: Request, res: Response): Promise<void> {
  const tenantId = (req as { tenantId?: string }).tenantId!;
  await requireFeature(tenantId, 'bookings', BOOKINGS_FEATURE_ERROR);
  const data = serviceUpdateSchema.parse(req.body);
  const { bot } = await getAnchorBotConfig(tenantId);
  const repo = AppDataSource.getRepository(ServiceType);
  const svc = await repo.findOne({ where: { id: req.params.id, botId: bot.id } });
  if (!svc) throw new ApiError('Service not found', 404, 'SERVICE_NOT_FOUND');
  const { intakeQuestions, ...rest } = data;
  Object.assign(svc, rest);
  // Present ⇒ replace (reconciled against the loaded stored set); absent ⇒ unchanged.
  if (intakeQuestions !== undefined) svc.intakeQuestions = reconcileIntakeQuestions(intakeQuestions, svc.intakeQuestions);
  if (data.name) svc.slug = await uniqueSlug(repo, bot.id, data.name, svc.id);
  await repo.save(svc);
  sendSuccess(res, svc);
}

/**
 * Hard-delete the service row. Existing bookings survive: the FK on
 * chatbot_bookings.event_type_id is ON DELETE SET NULL, so they keep their
 * date/customer and fall back to the bot's active service for reschedule/cancel.
 * To retire a service without removing it (e.g. a seasonal/recurring one), set
 * isActive=false via updateService instead.
 */
export async function deleteService(req: Request, res: Response): Promise<void> {
  const tenantId = (req as { tenantId?: string }).tenantId!;
  await requireFeature(tenantId, 'bookings', BOOKINGS_FEATURE_ERROR);
  const { bot } = await getAnchorBotConfig(tenantId);
  const repo = AppDataSource.getRepository(ServiceType);
  const svc = await repo.findOne({ where: { id: req.params.id, botId: bot.id } });
  if (!svc) throw new ApiError('Service not found', 404, 'SERVICE_NOT_FOUND');
  await repo.remove(svc);
  logger.info('[Scheduler] service deleted', { tenantId, botId: bot.id, serviceId: req.params.id });
  sendSuccess(res, { id: req.params.id, deleted: true });
}

// --- Business-type presets (P4) ---

/** List presets for the picker (entitlement-gated read). */
export async function listPresets(req: Request, res: Response): Promise<void> {
  const tenantId = (req as { tenantId?: string }).tenantId!;
  await requireFeature(tenantId, 'bookings', BOOKINGS_FEATURE_ERROR);
  sendSuccess(res, { presets: listPresetSummaries() });
}

/**
 * Seed a bot's catalog from a preset: one transaction, a per-bot advisory lock to
 * serialize concurrent applies, an empty-catalog precondition (any row, active or
 * inactive, → 409), bulk service create via the shared helper, and a conditional
 * availability insert (only when the bot has none — owner's real hours always win).
 */
export async function applyPreset(req: Request, res: Response): Promise<void> {
  const tenantId = (req as { tenantId?: string }).tenantId!;
  await requireFeature(tenantId, 'bookings', BOOKINGS_FEATURE_ERROR);
  const preset = findPreset(req.params.key);
  if (!preset) throw new ApiError('Preset not found', 404, 'PRESET_NOT_FOUND');
  const { bot } = await getAnchorBotConfig(tenantId);
  const botId = bot.id;

  await AppDataSource.transaction(async (manager) => {
    // Serialize concurrent applies for this bot (hash a text key → bigint the lock needs).
    await manager.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`preset:${botId}`]);

    // Empty-catalog precondition — inactive (soft-deleted) rows count, since they keep
    // their (bot_id, slug) and would muddy a fresh seed.
    const existing = await manager.getRepository(ServiceType).count({ where: { botId } });
    if (existing > 0) throw new ApiError('This bot already has services', 409, 'CATALOG_NOT_EMPTY');

    // Bulk-create the seed services in order (sortOrder = index).
    for (let i = 0; i < preset.services.length; i++) {
      const parsed = presetServiceSchema.parse(preset.services[i]);
      await createServiceRow(manager, tenantId, botId, { ...parsed, sortOrder: i });
    }

    // Conditional availability: insert the preset default only if the bot has no rule.
    if (preset.availability) {
      const hasRule = await manager.getRepository(AvailabilityRule).findOne({ where: { botId } });
      if (!hasRule) {
        const a = presetAvailabilitySchema.parse(preset.availability);
        // Raw targeted ON CONFLICT (bot_id) — jsonb params JSON.stringify'd so node-pg
        // doesn't serialize the arrays/objects as Postgres array literals.
        await manager.query(
          `INSERT INTO chatbot_availability_rules
             (tenant_id, bot_id, timezone, weekly_hours, date_overrides, slot_granularity_min)
           VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6)
           ON CONFLICT (bot_id) DO NOTHING`,
          [tenantId, botId, a.timezone, JSON.stringify(a.weeklyHours), JSON.stringify(a.dateOverrides), a.slotGranularityMin]
        );
      }
    }
  });

  // Re-read through the same query listServices uses, so the portal refresh is unchanged.
  const services = await AppDataSource.getRepository(ServiceType).find({
    where: { botId },
    order: { sortOrder: 'ASC', createdAt: 'ASC' },
  });
  logger.info('[Scheduler] preset applied', { tenantId, botId, preset: preset.key, count: services.length });
  sendSuccess(res, { services });
}

// --- Admin bookings management ---

export async function listBookings(req: Request, res: Response): Promise<void> {
  const tenantId = (req as { tenantId?: string }).tenantId!;
  const { scope, limit, offset } = listBookingsQuerySchema.parse(req.query);
  try {
    // Server-side entitlement gate: this endpoint returns attendee PII (email, notes,
    // requests) — don't rely on the portal's client-side feature gate alone.
    await requireFeature(tenantId, 'bookings', 'plan_limit_bookings');
    sendSuccess(res, await adminListBookings('scheduler-admin', tenantId, scope, limit, offset));
  } catch (err) {
    asApiError(err);
  }
}

export async function getBookingAvailability(req: Request, res: Response): Promise<void> {
  const tenantId = (req as { tenantId?: string }).tenantId!;
  await requireFeature(tenantId, 'bookings', BOOKINGS_FEATURE_ERROR);
  const { startDate, endDate, serviceId, durationMin } = availabilityQuerySchema.parse(req.query);
  try {
    sendSuccess(res, await adminAvailability('scheduler-admin', tenantId, startDate, endDate, serviceId, durationMin));
  } catch (err) {
    asApiError(err);
  }
}

export async function cancelBooking(req: Request, res: Response): Promise<void> {
  const tenantId = (req as { tenantId?: string }).tenantId!;
  await requireFeature(tenantId, 'bookings', BOOKINGS_FEATURE_ERROR);
  const { reason } = cancelBookingBodySchema.parse(req.body ?? {});
  try {
    sendSuccess(res, await adminCancelBooking('scheduler-admin', tenantId, req.params.id, reason));
  } catch (err) {
    asApiError(err);
  }
}

export async function rescheduleBooking(req: Request, res: Response): Promise<void> {
  const tenantId = (req as { tenantId?: string }).tenantId!;
  await requireFeature(tenantId, 'bookings', BOOKINGS_FEATURE_ERROR);
  const { newStartTime } = rescheduleBookingBodySchema.parse(req.body);
  try {
    sendSuccess(res, await adminRescheduleBooking('scheduler-admin', tenantId, req.params.id, newStartTime));
  } catch (err) {
    asApiError(err);
  }
}

/** Accept a request_created lead → confirm it (creates the calendar event + email). */
export async function acceptRequest(req: Request, res: Response): Promise<void> {
  const tenantId = (req as { tenantId?: string }).tenantId!;
  await requireFeature(tenantId, 'bookings', BOOKINGS_FEATURE_ERROR);
  try {
    sendSuccess(res, await adminAcceptRequest('scheduler-admin', tenantId, req.params.id));
  } catch (err) {
    asApiError(err);
  }
}

/** Decline a request_created lead → close it. */
export async function declineRequest(req: Request, res: Response): Promise<void> {
  const tenantId = (req as { tenantId?: string }).tenantId!;
  await requireFeature(tenantId, 'bookings', BOOKINGS_FEATURE_ERROR);
  const { reason } = cancelBookingBodySchema.parse(req.body ?? {});
  try {
    sendSuccess(res, await adminDeclineRequest('scheduler-admin', tenantId, req.params.id, reason));
  } catch (err) {
    asApiError(err);
  }
}
