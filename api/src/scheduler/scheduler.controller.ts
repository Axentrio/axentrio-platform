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
import { BookingSettings } from '../database/entities/BookingSettings';
import { Booking } from '../database/entities/Booking';
import type { Bot, BotSettings } from '../database/entities/Bot';
import { resolveTargetBot, replaceBotSettingsSection } from '../services/bot-config.service';
import { targetBotId } from '../utils/target-bot';
import { requireFeature } from '../billing/enforce';
import { getEntitlements } from '../billing/entitlements';
import { resolveItineraryKey, itineraryKeyIsShared } from './itinerary-key';
import { config } from '../config/environment';
import {
  updateSchedulerSchema,
  serviceInputSchema,
  serviceCreateSchema,
  serviceUpdateSchema,
  listBookingsQuerySchema,
  availabilityQuerySchema,
  reorderServicesSchema,
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

/** Switching travel time ON needs the separately-sold `travelTime` grant (ADR-0014). */
const TRAVEL_FEATURE_ERROR = 'plan_limit_travel_time';

/**
 * Refuse to switch travel time on while another Agent's diary resolves to the same
 * itinerary key.
 *
 * This is the multi-driver case arriving early by accident (ADR-0016), and it is the one
 * configuration in which the feature makes a business worse off than not having it: the
 * two Agents' bookings read as one person's day, so the gate strips slots for journeys
 * neither of them makes. The message says why, because "invalid state" would send an owner
 * looking for a fault in their booking settings when the fix is in their calendar
 * connection.
 */
async function assertTravelEnableAllowed(tenantId: string, botId: string): Promise<void> {
  // Same cheapest-first order the runtime gate uses, and for the same reason it is worth
  // stating: with no platform key the feature is inert, so arming a switch that cannot do
  // anything is a worse answer than saying so. Checking this BEFORE the entitlement also
  // stops an unentitled tenant being told to upgrade for a capability the platform could
  // not have delivered either way.
  if (!config.travel.googleMapsApiKey) {
    throw new ApiError('Travel time is not available on this platform', 503, 'TRAVEL_UNAVAILABLE');
  }
  await requireFeature(tenantId, 'travelTime', TRAVEL_FEATURE_ERROR);
  const itineraryKey = await resolveItineraryKey(botId);
  if (await itineraryKeyIsShared(tenantId, botId, itineraryKey)) {
    // UPPER_SNAKE like every other hand-thrown code here (ADR-0011). The lowercase
    // `plan_limit_*` family belongs to PlanLimitError, which this is not.
    throw new ApiError(
      // WORD FOR WORD the sentence the settings screen shows, because both are owner-facing
      // and both are reachable — the screen explains it before the attempt, this answers a
      // client that tried anyway. Two spellings of one refusal is how an owner starts
      // wondering whether they are two different problems. `Agent`, not `bot`: CONTEXT.md.
      'Travel time cannot be switched on while another Agent books into the same calendar. ' +
        'Their appointments would be read as one person’s day and times would be held back ' +
        'for journeys nobody makes. Give each Agent its own calendar first.',
      409,
      'TRAVEL_SHARED_ITINERARY'
    );
  }
}

/**
 * The same four gates `assertTravelEnableAllowed` throws on, as a value the screen can read.
 *
 * DELIBERATELY A SECOND READING of the same conditions rather than a refactor of the thrower
 * into a returner. The thrower is the enforcement and must stay a hard boundary on the write;
 * this is advice on a read, and it runs on a settings page rather than the booking hot path.
 * Collapsing them would put a `throw`/`return` mode flag through a security check.
 *
 * `null` means the switch is available — it does NOT mean travel is currently running, which
 * is what `enabled` beside it says.
 */
async function travelBlockedReason(
  tenantId: string,
  botId: string
): Promise<'no_maps_key' | 'not_entitled' | 'shared_itinerary' | null> {
  if (!config.travel.googleMapsApiKey) return 'no_maps_key';
  const entitlements = await getEntitlements(tenantId);
  if (!entitlements.features.travelTime) return 'not_entitled';
  const itineraryKey = await resolveItineraryKey(botId);
  return (await itineraryKeyIsShared(tenantId, botId, itineraryKey)) ? 'shared_itinerary' : null;
}

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
  submitted: Array<{
    id?: string;
    label: string;
    type: 'text' | 'choice';
    required: boolean;
    options?: string[];
    aiInstruction?: string;
    exampleAnswer?: string;
    active?: boolean;
    includeInCalendar?: boolean;
  }>,
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
    // Rebuilt field by field rather than spread, so anything the client invents is dropped
    // — which also means a field added above and forgotten HERE is silently discarded on
    // every save. Only store what was actually set: `active: true` and
    // `includeInCalendar: true` are the absent-value defaults, so writing them adds noise
    // to every row for no change in meaning.
    if (q.aiInstruction?.trim()) question.aiInstruction = q.aiInstruction.trim();
    if (q.exampleAnswer?.trim()) question.exampleAnswer = q.exampleAnswer.trim();
    if (q.active === false) question.active = false;
    if (q.includeInCalendar === false) question.includeInCalendar = false;
    return question;
  });
  return out.length ? out : null;
}

async function readConfig(tenantId: string, bot: Bot) {
  const repo = AppDataSource.getRepository(ServiceType);
  const [eventType, services, availability, bookingSettings] = await Promise.all([
    repo.findOne({ where: { botId: bot.id, isActive: true }, order: { sortOrder: 'ASC' } }),
    repo.find({ where: { botId: bot.id }, order: { sortOrder: 'ASC', createdAt: 'ASC' } }),
    AppDataSource.getRepository(AvailabilityRule).findOne({ where: { botId: bot.id } }),
    AppDataSource.getRepository(BookingSettings).findOne({ where: { botId: bot.id } }),
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
    // No settings row (or a hand-edited non-array) reads as "no area configured", which
    // never blocks a booking.
    serviceArea: Array.isArray(bookingSettings?.serviceArea) ? bookingSettings.serviceArea : [],
    // Must be returned explicitly: readConfig cherry-picks, so a field added to the entity
    // but not here reads as undefined, the portal hydrates it blank, and the owner's next
    // Save writes that blank back over a real value.
    bookingRules: {
      maxBookingsPerDay: bookingSettings?.maxBookingsPerDay ?? null,
      maxBookedMinutesPerDay: bookingSettings?.maxBookedMinutesPerDay ?? null,
      minGapMin: bookingSettings?.minGapMin ?? null,
      defaultBufferBeforeMin: bookingSettings?.defaultBufferBeforeMin ?? null,
      defaultBufferAfterMin: bookingSettings?.defaultBufferAfterMin ?? null,
      defaultMinNoticeMin: bookingSettings?.defaultMinNoticeMin ?? null,
      defaultMaxHorizonDays: bookingSettings?.defaultMaxHorizonDays ?? null,
    },
    // Cherry-picked like everything else here, so omitting it would make the portal hydrate
    // "not paused" and quietly un-pause a business on its next Save.
    bookingsPaused: bookingSettings?.bookingsPaused === true,
    // Same reason as bookingRules: cherry-picked, so a field added to the entity but not
    // here reads as undefined, the editor hydrates it blank, and the next Save writes the
    // blank back over a real venue.
    venueAddress: {
      street: bookingSettings?.venueStreet ?? null,
      postalCode: bookingSettings?.venuePostalCode ?? null,
      city: bookingSettings?.venueCity ?? null,
      country: bookingSettings?.venueCountry ?? null,
    },
    // WHICH AGENT THESE SETTINGS BELONG TO.
    //
    // Since #86 this is whichever Agent the caller named, defaulting to the anchor — so it is
    // no longer a disclaimer about a limitation but the identity of the thing being edited.
    // The portal echoes it back on write, and renders it in the Agent picker.
    agent: { id: bot.id, name: bot.name },
    // Cherry-picked like everything else here — a field on the entity but missing from this
    // object hydrates the editor blank and the owner's next Save writes the blank back.
    travel: {
      enabled: bookingSettings?.travelTimeEnabled === true,
      slackMin: bookingSettings?.travelSlackMin ?? null,
      startFromBase: bookingSettings?.travelStartFromBase === true,
      /**
       * Why the switch cannot be turned on, or null when it can.
       *
       * The WRITE path already refuses each of these with a clear 409, so this is not the
       * enforcement — it is the difference between a screen that explains itself and one that
       * lets an owner flip a switch, wait, and read an error. The shared-diary case especially:
       * it is the feature's one genuinely harmful state, it arrives months later when somebody
       * connects a calendar, and "give each Agent its own calendar" is an action the owner can
       * only take if they are told to.
       */
      blockedReason: await travelBlockedReason(tenantId, bot.id),
    },
  };
}

export async function getSchedulerConfig(req: Request, res: Response): Promise<void> {
  const tenantId = (req as { tenantId?: string }).tenantId!;
  await requireFeature(tenantId, 'bookings', BOOKINGS_FEATURE_ERROR);
  const bot = await resolveTargetBot({ tenantId, botId: targetBotId(req) });
  sendSuccess(res, await readConfig(tenantId, bot));
}

export async function updateSchedulerConfig(req: Request, res: Response): Promise<void> {
  const tenantId = (req as { tenantId?: string }).tenantId!;
  const data = updateSchedulerSchema.parse(req.body);

  // Every config write (provider, event type, or availability) requires the
  // bookings feature. Closes the path where an unentitled tenant could persist
  // scheduler config by omitting `provider` from the payload.
  await requireFeature(tenantId, 'bookings', BOOKINGS_FEATURE_ERROR);
  const bot = await resolveTargetBot({ tenantId, botId: targetBotId(req) });
  // Same fallback `getAnchorBotConfig` applies to its own `settings` — a bot row can predate
  // the column. Kept here rather than in the resolver so the resolver answers one question.
  const settings = bot.settings ?? ({} as BotSettings);

  if (data.provider) {
    // Ignore any legacy 'calcom' input — the provider is always internal now.
    await replaceBotSettingsSection(bot.id, tenantId, 'integrations', {
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

  // Checked BEFORE the upsert, so a refused enable leaves nothing written — not even the
  // slack value that rode along in the same payload. Only an enable is gated: switching
  // travel OFF must always be possible, including for a tenant who has since lost the
  // entitlement or connected a second Agent to their calendar.
  //
  // A TRANSITION, NOT A VALUE. This used to fire whenever the payload carried `enabled: true`,
  // including when travel was ALREADY on — which is the state a tenant lands in when somebody
  // connects a second Agent to their calendar months later. The stored preference is
  // deliberately not rewritten then (see `resolveTravelEligibility`: travel goes inert and
  // returns by itself when the diaries separate), so the editor keeps sending `true`, and every
  // Save of the WHOLE page began to 409 — venue, opening hours and the pause switch along with
  // it. An owner was locked out of their booking settings by a state they did not create and
  // could not clear.
  const travelAlreadyOn = (await AppDataSource.getRepository(BookingSettings)
    .findOne({ where: { botId: bot.id } }))?.travelTimeEnabled === true;
  if (data.travel?.enabled === true && !travelAlreadyOn) {
    await assertTravelEnableAllowed(tenantId, bot.id);
  }

  // `!== undefined`, not truthiness: [] is how the owner clears their service area, and
  // null is how they clear a capacity rule or a business default.
  if (
    data.serviceArea !== undefined ||
    data.bookingRules ||
    data.venueAddress !== undefined ||
    data.bookingsPaused !== undefined ||
    data.travel !== undefined
  ) {
    const br = (data.bookingRules ?? {}) as Record<string, number | null | undefined>;
    // `venueAddress: null` clears the whole venue; an omitted key leaves it alone. Reusing
    // the rules' value+provided pairing means one mechanism, not two.
    const va = (data.venueAddress ?? {}) as Record<string, string | null | undefined>;
    const venueProvided = data.venueAddress !== undefined;
    // Generated rather than hand-written: seven nullable int columns, each needing a value
    // AND a "was it provided" flag so an untouched rule keeps its stored value while an
    // explicit null clears it. Hand-maintaining fourteen positional params is how a column
    // ends up silently bound to the wrong slot.
    const RULE_COLUMNS: Array<[string, string]> = [
      ['maxBookingsPerDay', 'max_bookings_per_day'],
      ['maxBookedMinutesPerDay', 'max_booked_minutes_per_day'],
      ['minGapMin', 'min_gap_min'],
      ['defaultBufferBeforeMin', 'default_buffer_before_min'],
      ['defaultBufferAfterMin', 'default_buffer_after_min'],
      ['defaultMinNoticeMin', 'default_min_notice_min'],
      ['defaultMaxHorizonDays', 'default_max_horizon_days'],
    ];
    const VENUE_COLUMNS: Array<[string, string]> = [
      ['street', 'venue_street'],
      ['postalCode', 'venue_postal_code'],
      ['city', 'venue_city'],
      ['country', 'venue_country'],
    ];

    const params: unknown[] = [
      tenantId,
      bot.id,
      data.serviceArea === undefined ? null : JSON.stringify(data.serviceArea),
      data.serviceArea !== undefined,
    ];
    const insertCols = ['tenant_id', 'bot_id', 'service_area'];
    const insertVals = ['$1', '$2', `COALESCE($3::jsonb, '[]'::jsonb)`];
    const updates = [
      `service_area = CASE WHEN $4 THEN COALESCE($3::jsonb, '[]'::jsonb) ELSE chatbot_booking_settings.service_area END`,
    ];
    for (const [key, column] of RULE_COLUMNS) {
      const valueParam = `$${params.length + 1}`;
      const providedParam = `$${params.length + 2}`;
      params.push(br[key] ?? null, br[key] !== undefined);
      insertCols.push(column);
      insertVals.push(valueParam);
      updates.push(
        `${column} = CASE WHEN ${providedParam} THEN ${valueParam} ELSE chatbot_booking_settings.${column} END`
      );
    }

    for (const [key, column] of VENUE_COLUMNS) {
      const valueParam = `$${params.length + 1}`;
      const providedParam = `$${params.length + 2}`;
      // `venueAddress: null` already collapsed to `{}` above, so every component reads
      // null and the venue clears — no special case needed. A partial edit sends only the
      // components it has, and `venueProvided` alone decides whether the row is touched.
      const raw = va[key] ?? null;
      params.push(typeof raw === 'string' && raw.trim() ? raw.trim().slice(0, 200) : null, venueProvided);
      insertCols.push(column);
      insertVals.push(valueParam);
      updates.push(
        `${column} = CASE WHEN ${providedParam} THEN ${valueParam} ELSE chatbot_booking_settings.${column} END`
      );
    }

    // NOT NULL, so the INSERT arm must always bind a real boolean — it cannot ride the
    // RULE_COLUMNS loop, which binds `?? null` and would fail on a first write. Same for
    // the two travel switches below.
    const BOOLEAN_COLUMNS: Array<[boolean | undefined, string]> = [
      [data.bookingsPaused, 'bookings_paused'],
      [data.travel?.enabled, 'travel_time_enabled'],
      [data.travel?.startFromBase, 'travel_start_from_base'],
    ];
    for (const [submitted, column] of BOOLEAN_COLUMNS) {
      const valueParam = `$${params.length + 1}`;
      const providedParam = `$${params.length + 2}`;
      params.push(submitted === true, submitted !== undefined);
      insertCols.push(column);
      insertVals.push(valueParam);
      updates.push(
        `${column} = CASE WHEN ${providedParam} THEN ${valueParam} ELSE chatbot_booking_settings.${column} END`
      );
    }

    // Nullable int, so it follows the RULE_COLUMNS contract — undefined leaves the stored
    // value alone, an explicit null clears it.
    {
      const valueParam = `$${params.length + 1}`;
      const providedParam = `$${params.length + 2}`;
      params.push(data.travel?.slackMin ?? null, data.travel?.slackMin !== undefined);
      insertCols.push('travel_slack_min');
      insertVals.push(valueParam);
      updates.push(
        `travel_slack_min = CASE WHEN ${providedParam} THEN ${valueParam} ELSE chatbot_booking_settings.travel_slack_min END`
      );
    }

    // A real upsert rather than findOne-then-save: the unique index on bot_id means two
    // concurrent first-writes for the same bot raced to a 23505.
    await AppDataSource.query(
      `INSERT INTO chatbot_booking_settings (${insertCols.join(', ')})
       VALUES (${insertVals.join(', ')})
       ON CONFLICT (bot_id) DO UPDATE SET ${updates.join(', ')}, updated_at = now()`,
      params
    );
  }

  logger.info('[Scheduler] config updated', { tenantId, botId: bot.id, keys: Object.keys(data) });
  sendSuccess(res, await readConfig(tenantId, bot));
}

// --- Services CRUD (multi-service catalog, K3) ---

export async function listServices(req: Request, res: Response): Promise<void> {
  const tenantId = (req as { tenantId?: string }).tenantId!;
  await requireFeature(tenantId, 'bookings', BOOKINGS_FEATURE_ERROR);
  const bot = await resolveTargetBot({ tenantId, botId: targetBotId(req) });
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
  const bot = await resolveTargetBot({ tenantId, botId: targetBotId(req) });
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
  const bot = await resolveTargetBot({ tenantId, botId: targetBotId(req) });
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
/**
 * Reorder the service catalog.
 *
 * Positions come from the ARRAY, not from numbers the client invents, so the stored order
 * can never disagree with what the owner saw. Everything is renumbered 0..n-1 in one
 * transaction: partial application would leave the catalog in an order nobody chose, and
 * this is exactly the surface where every row starts life at sortOrder 0.
 *
 * Ids not belonging to this bot are ignored rather than rejected — a stale tab is a normal
 * thing to have open, and it must not be able to renumber somebody else's catalog. Any
 * service the client did not mention keeps its relative place AFTER the ones it did.
 */
export async function reorderServices(req: Request, res: Response): Promise<void> {
  const tenantId = (req as { tenantId?: string }).tenantId!;
  await requireFeature(tenantId, 'bookings', BOOKINGS_FEATURE_ERROR);
  const bot = await resolveTargetBot({ tenantId, botId: targetBotId(req) });
  const { serviceIds } = reorderServicesSchema.parse(req.body);

  await AppDataSource.transaction(async (manager) => {
    const repo = manager.getRepository(ServiceType);
    const owned = await repo.find({
      where: { botId: bot.id },
      order: { sortOrder: 'ASC', createdAt: 'ASC' },
    });
    const byId = new Map(owned.map((s) => [s.id, s]));
    const ordered = serviceIds.map((id) => byId.get(id)).filter((s): s is ServiceType => !!s);
    const rest = owned.filter((s) => !serviceIds.includes(s.id));
    const final = [...ordered, ...rest];
    for (let i = 0; i < final.length; i++) {
      if (final[i].sortOrder !== i) await repo.update({ id: final[i].id }, { sortOrder: i });
    }
  });

  logger.info('[Scheduler] services reordered', { tenantId, botId: bot.id, count: serviceIds.length });
  sendSuccess(res, await readConfig(tenantId, bot));
}

export async function deleteService(req: Request, res: Response): Promise<void> {
  const tenantId = (req as { tenantId?: string }).tenantId!;
  await requireFeature(tenantId, 'bookings', BOOKINGS_FEATURE_ERROR);
  const bot = await resolveTargetBot({ tenantId, botId: targetBotId(req) });
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
  const bot = await resolveTargetBot({ tenantId, botId: targetBotId(req) });
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
  const { scope, limit, offset, botId } = listBookingsQuerySchema.parse(req.query);
  try {
    // Server-side entitlement gate: this endpoint returns attendee PII (email, notes,
    // requests) — don't rely on the portal's client-side feature gate alone.
    await requireFeature(tenantId, 'bookings', 'plan_limit_bookings');
    sendSuccess(res, await adminListBookings('scheduler-admin', tenantId, scope, limit, offset, botId));
  } catch (err) {
    asApiError(err);
  }
}

/**
 * Which Agent owns this booking, if it is one of the tenant's.
 *
 * Answers `undefined` rather than throwing for an unknown id: the caller is choosing whose
 * diary to read, and a bad `excludeBookingId` should fall back to the ordinary answer instead
 * of failing the whole slot lookup. The tenant filter is what stops another tenant's booking
 * id naming an Agent here.
 */
async function bookingAgent(tenantId: string, bookingId: string): Promise<string | undefined> {
  const booking = await AppDataSource.getRepository(Booking).findOne({
    where: { id: bookingId, tenantId },
    select: ['id', 'botId'],
  });
  return booking?.botId;
}

export async function getBookingAvailability(req: Request, res: Response): Promise<void> {
  const tenantId = (req as { tenantId?: string }).tenantId!;
  await requireFeature(tenantId, 'bookings', BOOKINGS_FEATURE_ERROR);
  const { startDate, endDate, serviceId, durationMin, excludeBookingId, botId } = availabilityQuerySchema.parse(
    req.query
  );
  try {
    // THE BOOKING DECIDES, when there is one. The picker only ever opens against an existing
    // appointment, and the Agent that owns it is a fact in the database - reading it here beats
    // trusting the client to send a `botId` that matches the `excludeBookingId` beside it. A
    // mismatched pair would compute one Agent's slots for another's appointment, which is #87
    // wearing a query parameter.
    const bookingAgentId = excludeBookingId ? await bookingAgent(tenantId, excludeBookingId) : undefined;
    sendSuccess(
      res,
      await adminAvailability(
        'scheduler-admin',
        tenantId,
        startDate,
        endDate,
        serviceId,
        durationMin,
        excludeBookingId,
        bookingAgentId ?? botId
      )
    );
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
