/**
 * Booking service — provider dispatcher.
 *
 * Resolves the provider-agnostic context (session → tenant → bot settings) and
 * delegates each operation to the in-house `InternalProvider`. Cal.com is
 * shelved: `CalcomProvider` stays on disk (dormant) for an easy revival, but
 * every bot now books through the internal scheduler regardless of any legacy
 * `integrations.provider` value. The five exported functions keep their
 * original signatures so callers (n8n booking tools, the `/internal/booking/*`
 * routes, the in-house agent tool) are unchanged.
 */
import { In } from 'typeorm';
import { AppDataSource } from '../database/data-source';
import { ChatSession } from '../database/entities/ChatSession';
import { Tenant } from '../database/entities/Tenant';
import { Booking } from '../database/entities/Booking';
import { BookingReference } from '../database/entities/BookingReference';
import { ServiceType } from '../database/entities/ServiceType';
import { serviceNeedsCustomerAddress } from './service-location';
import { Bot, type BotSettings } from '../database/entities/Bot';
import { getBotBusinessTimezone } from './business-timezone';
import {
  getBotConfigForSession,
  getAnchorBotConfig,
  getOwnedBot,
  getOwnedBotConfig,
} from '../services/bot-config.service';
import { BookingError, BookingContext, BookingExtras, type UpdateBookingPatch, type ClockWindow } from './booking-providers/types';
import { serviceRequiresCustomerEmail } from './booking-providers/contact';
import { InternalProvider } from './booking-providers/internal.provider';
import { findBookableService } from './booking-providers/find-bookable-service';
import { subjectToCustomerChangePolicy, DEFAULT_CUSTOMER_CHANGE_MODE } from './customer-change-policy';
import type { CustomerChangeMode } from '../database/entities/ServiceType';
import { upsertLead } from '../leads/lead-capture.service';
import { requireFeature } from '../billing/enforce';
import { buildIntakeAnswers } from './intake-answers';
import { logger } from '../utils/logger';
import { resolveItineraryKey } from '../scheduler/itinerary-key';
import { resolveTravelEligibility } from './travel/travel-eligibility';
import { loadTravelNeighbours } from './travel/travel-neighbours';
import { storedPlace } from './travel/booking-place';
import {
  estimateDrive,
  precedingNeighbour,
  followingNeighbour,
  type DriveEstimate,
} from './travel/travel-gate';

// Re-export so existing importers (`import { BookingError } from './booking.service'`)
// keep working unchanged.
export { BookingError } from './booking-providers/types';
// The booking backend. Cal.com is shelved — the in-house scheduler is the only
// active provider, so we ignore any stored `integrations.provider` value. To
// bring Cal.com back, restore the per-bot switch on `botSettings` here.
const internalProvider = new InternalProvider();

/**
 * Booking-service boundary gate (plan D7/D8). Every entry point passes an
 * explicit caller context; the `bookings` feature is enforced here once so
 * agent tools, /internal/booking/* n8n routes, and the scheduler admin
 * routes can't drift apart. Tool absence is not authorization.
 *
 * `public-manage` is the ONLY exemption (D8): token-verified self-service
 * management of an EXISTING appointment. The controller constructs the
 * object only after verifying the manage token, and the carried
 * `verifiedBookingId` must match the booking being acted on — a bare claim
 * without the verified id gets the full gate. Creation is never exempt.
 *
 * Unknown/missing caller context fails closed (the parameter is required —
 * a new entry point that forgets it doesn't compile).
 */
export type PublicManageCaller = { kind: 'public-manage'; verifiedBookingId: string };
export type BookingCaller = 'agent' | 'internal-n8n' | 'scheduler-admin' | PublicManageCaller;

async function enforceBookingsFeature(
  tenantId: string,
  caller: BookingCaller,
  exemption?: { manageableBookingId: string } | { tokenVerifiedLookup: true },
): Promise<void> {
  if (typeof caller === 'object' && caller.kind === 'public-manage' && exemption) {
    // The exemption is an explicit per-call-site opt-in — a public-manage
    // caller reaching a function that doesn't opt in (creation, owner
    // accept/decline, lists) always gets the full gate.
    if ('manageableBookingId' in exemption && caller.verifiedBookingId === exemption.manageableBookingId) {
      return; // mutating the exact booking the token was issued for
    }
    if ('tokenVerifiedLookup' in exemption) {
      return; // slot lookup inside the token-verified public reschedule flow
    }
  }
  // Same envelope as every other feature gate: HTTP 402, plan_limit_bookings.
  await requireFeature(tenantId, 'bookings', 'plan_limit_bookings');
}

/** Resolve session, tenant, and bot settings — provider-agnostic. */
async function resolveContext(sessionId: string): Promise<BookingContext> {
  const session = await AppDataSource.getRepository(ChatSession).findOne({ where: { id: sessionId } });
  if (!session) throw new BookingError('Session not found', 'SESSION_NOT_FOUND', 404);

  const tenant = await AppDataSource.getRepository(Tenant).findOne({ where: { id: session.tenantId } });
  if (!tenant) throw new BookingError('Tenant not found', 'TENANT_NOT_FOUND', 404);

  // Multi-bot Phase 4 (#16d): integrations + businessHours live on Bot.settings
  // resolved from the session's bot (anchor fallback if session.botId is null).
  const { bot, settings: botSettings } = await getBotConfigForSession(session);

  return { session, tenant, bot, botSettings };
}

/**
 * Link a Booking or Request back to the offer it came from (#80, LP3).
 *
 * Fire-and-forget, and deliberately AFTER the booking has already succeeded: this is the
 * measurement half of the pre-steering baseline, and a statistics row is never worth a booking.
 * An unattributable booking is left unattributed rather than guessed at - an owner adding an
 * appointment by hand was never steered and cannot evidence steering, so putting it in the
 * denominator would understate first-offer acceptance for free.
 */
function attributeToOffer(
  ctx: BookingContext,
  bookingId: string | undefined,
  startTime: string,
  serviceId: string | undefined,
  selectionType: 'booking' | 'request'
): void {
  if (!bookingId) return;
  const startUtc = new Date(startTime);
  if (Number.isNaN(startUtc.getTime())) return;
  void import('./offer-record.service')
    .then((m) =>
      m.recordOfferSelection({
        sessionId: ctx.session.id,
        serviceId: serviceId ?? null,
        bookingId,
        startUtc,
        selectionType,
      })
    )
    .catch(() => undefined);
}

export async function listBookings(caller: BookingCaller, sessionId: string, attendeeEmail?: string) {
  const ctx = await resolveContext(sessionId);
  await enforceBookingsFeature(ctx.tenant.id, caller);
  return internalProvider.listBookings(ctx, attendeeEmail);
}

export async function checkAvailability(
  caller: BookingCaller,
  sessionId: string,
  startDate: string,
  endDate: string,
  serviceId?: string,
  durationMin?: number,
  /**
   * Where the job is. Only consulted for a service carried out at the customer's address on an
   * Agent with travel time on — the times that can be offered depend on whether the owner can
   * physically get there between whatever is already in the diary.
   */
  customerAddress?: string,
  locationChoice?: 'business' | 'customer',
  customerPhone?: string,
  clockWindow?: ClockWindow,
) {
  const ctx = await resolveContext(sessionId);
  await enforceBookingsFeature(ctx.tenant.id, caller);
  // `excludeBookingId` stays undefined here: this entry point is a NEW booking. The reschedule
  // picker has its own function below, which passes both it and the address on the row.
  return internalProvider.checkAvailability(
    ctx, startDate, endDate, serviceId, durationMin, undefined, customerAddress, locationChoice, customerPhone, clockWindow,
  );
}

/**
 * Availability for MOVING one existing booking: the same diary read with that booking's own
 * occupancy excluded. Without the exclusion a 09:30 target on the caller's own 09:00-10:00
 * hold reads as busy, so the move is refused against nobody but themselves. The availability
 * tool calls this for its moveTargets when the range holds exactly one of the caller's rows;
 * authorization is unchanged - the excluded id comes from the caller's own alreadyHeld result.
 */
export async function checkMoveAvailability(
  caller: BookingCaller,
  sessionId: string,
  startDate: string,
  endDate: string,
  excludeBookingId: string,
  serviceId?: string,
  durationMin?: number,
  customerAddress?: string,
  locationChoice?: 'business' | 'customer',
  customerPhone?: string,
  clockWindow?: ClockWindow,
) {
  const ctx = await resolveContext(sessionId);
  await enforceBookingsFeature(ctx.tenant.id, caller);
  return internalProvider.checkAvailability(
    ctx, startDate, endDate, serviceId, durationMin, excludeBookingId, customerAddress, locationChoice, customerPhone, clockWindow,
  );
}

export async function createBooking(
  caller: BookingCaller,
  sessionId: string,
  idempotencyKey: string,
  startTime: string,
  attendee: { name: string; email?: string },
  notes?: string,
  serviceId?: string,
  intakeAnswers?: unknown,
  extras?: BookingExtras
) {
  const ctx = await resolveContext(sessionId);
  await enforceBookingsFeature(ctx.tenant.id, caller);
  const result = await internalProvider.createBooking(ctx, idempotencyKey, startTime, attendee, notes, serviceId, intakeAnswers, extras);
  captureLeadFromBooking(ctx, attendee, extras, result.booking?.id);
  attributeToOffer(ctx, result.booking?.id, startTime, serviceId, 'booking');
  return result;
}

/**
 * Does this call's service require an email before create_booking may ask
 * for confirmation? EMAIL_REQUIRED must beat CONFIRMATION_REQUIRED: otherwise
 * the model summarises "book without email", the customer says yes, the write
 * gate refuses, and a second summary is asked.
 */
export async function peekCustomerEmailRequired(
  sessionId: string,
  serviceId?: string,
): Promise<boolean> {
  const ctx = await resolveContext(sessionId);
  const svc = await findBookableService(ctx.bot.id, serviceId);
  return serviceRequiresCustomerEmail(svc);
}

/**
 * Capture an appointment request (the agent's `request_appointment` fallback).
 * Internal-only — `requestAppointment` is not on the `BookingProvider` interface,
 * so we go straight to the in-house provider (mirrors the admin functions below).
 */
export async function requestBooking(
  caller: BookingCaller,
  sessionId: string,
  idempotencyKey: string,
  preferredTime: string,
  attendee: { name: string; email?: string },
  notes?: string,
  serviceId?: string,
  aiSummary?: string,
  intakeAnswers?: unknown,
  extras?: BookingExtras
) {
  const ctx = await resolveContext(sessionId);
  await enforceBookingsFeature(ctx.tenant.id, caller);
  const result = await internalProvider.requestAppointment(ctx, idempotencyKey, preferredTime, attendee, notes, serviceId, aiSummary, intakeAnswers, extras);
  captureLeadFromBooking(ctx, attendee, extras, result.booking?.id);
  // Recorded as a REQUEST, not a booking. The customer expressed a choice and the gate declined
  // to confirm it - that is expressed choice, not conversion, and folding the two together would
  // flatter LP5's comparison later.
  attributeToOffer(ctx, result.booking?.id, preferredTime, serviceId, 'request');
  return result;
}

/**
 * Hook 2 (leads-across-all-channels): a customer who books or requests an
 * appointment is a Lead — they've handed over name + email (and on a channel,
 * a reachable handle). Fire-and-forget after a successful create/request.
 *
 * On a channel session, `session.visitorId` IS the binding's `externalUserId`
 * (set identically in the inbound pipeline), so the channel-keyed dedup
 * collapses this onto the Lead Hook 1 already created and upgrades its source
 * to `booking`. On the widget it keys on the booking email/phone. This is the
 * deterministic path that finally captures the "29-type" booking customers.
 */
function captureLeadFromBooking(
  ctx: BookingContext,
  attendee: { name: string; email?: string },
  extras?: BookingExtras,
  bookingId?: string,
): void {
  const channel = ctx.session.channel ?? 'widget';
  const isChannel = channel !== 'widget' && !!ctx.session.channelConnectionId;
  void (async () => {
    const res = await upsertLead({
      dataSource: AppDataSource,
      tenantId: ctx.tenant.id,
      sessionId: ctx.session.id,
      botId: ctx.bot.id,
      source: 'booking',
      channel,
      externalUserId: isChannel ? ctx.session.visitorId : null,
      name: attendee.name,
      email: attendee.email ?? null,
      phone: extras?.customerPhone ?? null,
      // NOTE: `notes` is deliberately NOT passed. `upsertLead` merges notes
      // new-value-wins, and booking is the highest-ranked source, so passing booking
      // prose here would overwrite the request summary that `capture_lead` captured —
      // the one field whose prompt wording was empirically measured. Booking detail is
      // reached by join instead (see below), never by copying over the summary.
    });
    if (!res || !bookingId) return;

    // Link the booking to the lead. This single FK is the whole "Pro structured
    // fields" projection: address, requested service, preferred date, booking status
    // and list price are then DERIVED by joining chatbot_bookings → chatbot_service_types
    // at read time. Nothing is copied onto the lead, because a copy would go stale the
    // moment the booking is rescheduled or cancelled and neither path notifies the lead.
    await AppDataSource.query(
      `UPDATE chatbot_bookings SET lead_id = $1 WHERE id = $2 AND tenant_id = $3 AND lead_id IS NULL`,
      [res.leadId, bookingId, ctx.tenant.id],
    );
  })().catch(() => {
    // Fire-and-forget by design: a lead-capture failure must never fail a booking the
    // customer has already been told about. upsertLead logs its own errors.
  });
}

export async function rescheduleBooking(
  caller: BookingCaller,
  sessionId: string,
  bookingId: string,
  newStartTime: string,
  opts?: { customerAddress?: string },
) {
  const ctx = await resolveContext(sessionId);
  ctx.subjectToCustomerChangePolicy = subjectToCustomerChangePolicy(caller);
  await enforceBookingsFeature(ctx.tenant.id, caller, { manageableBookingId: bookingId });
  return opts
    ? internalProvider.rescheduleBooking(ctx, bookingId, newStartTime, opts)
    : internalProvider.rescheduleBooking(ctx, bookingId, newStartTime);
}

export async function updateBooking(
  caller: BookingCaller,
  sessionId: string,
  patch: UpdateBookingPatch,
) {
  const ctx = await resolveContext(sessionId);
  await enforceBookingsFeature(ctx.tenant.id, caller, patch.bookingId ? { manageableBookingId: patch.bookingId } : undefined);
  const result = await internalProvider.updateBooking(ctx, patch);
  if (patch.attendeeName || patch.attendeeEmail || patch.customerPhone) {
    captureLeadFromBooking(
      ctx,
      { name: patch.attendeeName ?? '', email: patch.attendeeEmail },
      patch.customerPhone ? { customerPhone: patch.customerPhone } : undefined,
      result.booking.id,
    );
  }
  return result;
}

export async function cancelBooking(caller: BookingCaller, sessionId: string, bookingId: string, reason?: string) {
  const ctx = await resolveContext(sessionId);
  ctx.subjectToCustomerChangePolicy = subjectToCustomerChangePolicy(caller);
  await enforceBookingsFeature(ctx.tenant.id, caller, { manageableBookingId: bookingId });
  return internalProvider.cancelBooking(ctx, bookingId, reason);
}

// ---------------------------------------------------------------------------
// Admin (portal) surface — tenant-scoped management of internal bookings.
//
// The customer-facing functions above resolve context from a chat session. The
// portal has no session, so these resolve context from the tenant's anchor bot
// (where the scheduler config lives) and operate only on the `internal`
// provider — Cal.com bookings live in Cal.com and are managed there.
// ---------------------------------------------------------------------------

export type BookingScope = 'upcoming' | 'past' | 'requests';

export interface AdminBookingRow {
  id: string;
  startTime: string;
  endTime: string;
  status: string;
  attendeeName: string | null;
  attendeeEmail: string | null;
  notes: string | null;
  meetingUrl: string | null;
  serviceName?: string | null;
  /** The booking's service id + frozen length — the reschedule picker needs both
   *  to compute availability for the right service when several are active. */
  serviceId?: string | null;
  durationMin?: number | null;
  bookingMode?: string | null;
  /** `new` (or absent) is a new-job Request. Change Requests name the original. */
  requestKind?: string | null;
  relatedBookingId?: string | null;
  /** P3: ordered, pre-labeled intake answers for display (null if none). */
  intakeAnswers?: Array<{ label: string; answer: string }> | null;
  /** P5a: captured contact details (null when not collected). */
  customerAddress?: string | null;
  customerPhone?: string | null;
  /** Requests only: the drive either side, from distance alone. Null when nothing can be said. */
  travelEstimate?: { before: DriveEstimate | null; after: DriveEstimate | null; basis: 'distance' } | null;
  /** What the travel gate DID. Null = it did not apply, which is every booking today. */
  travelCheck?: 'ok' | 'degraded' | 'captured' | 'overridden' | null;
  /** P5e: attached files (snapshot subset for display/download). */
  uploadedFiles?: Array<{ fileSessionId: string; fileName: string; mimeType?: string }> | null;

  /**
   * WHICH AGENT sold this appointment (#87).
   *
   * The list used to be one Agent's by construction, so saying whose it was would have been
   * noise. Now that it is every Agent's, a page that mixes them without labelling them trades
   * one confusion for another - the owner would see appointments they cannot place. The portal
   * shows this only when a page actually holds more than one, so a single-Agent tenant sees no
   * new column and is asked no new question.
   */
  agentId: string;
  agentName: string | null;
}

function uploadedFileSnapshots(
  files: Booking['uploadedFiles'],
): Array<{ fileSessionId: string; fileName: string; mimeType?: string }> | null {
  if (!Array.isArray(files)) return null;
  return (files as Array<Record<string, unknown>>)
    .filter((f) => f && typeof f.fileSessionId === 'string' && typeof f.fileName === 'string')
    .map((f) => ({
      fileSessionId: f.fileSessionId as string,
      fileName: f.fileName as string,
      ...(typeof f.mimeType === 'string' && f.mimeType ? { mimeType: f.mimeType } : {}),
    }));
}

function adminServiceSlice(
  eventTypeId: string | null | undefined,
  nameByService: Map<string, string>,
  questionsByService: Map<string, ServiceType['intakeQuestions']>,
  storedAnswers: Booking['intakeAnswers'],
): Pick<AdminBookingRow, 'serviceName' | 'serviceId' | 'intakeAnswers'> {
  if (!eventTypeId) {
    return {
      serviceName: null,
      serviceId: null,
      intakeAnswers: buildIntakeAnswers(null, storedAnswers),
    };
  }
  return {
    serviceName: nameByService.get(eventTypeId) ?? null,
    serviceId: eventTypeId,
    intakeAnswers: buildIntakeAnswers(questionsByService.get(eventTypeId), storedAnswers),
  };
}

function toAdminBookingRow(
  b: Booking,
  ctx: {
    agentNameById: Map<string, string>;
    meetByBooking: Map<string, string | null>;
    mirroredBookingIds: Set<string>;
    nameByService: Map<string, string>;
    questionsByService: Map<string, ServiceType['intakeQuestions']>;
    estimateByBooking: Map<string, { before: DriveEstimate | null; after: DriveEstimate | null; basis: 'distance' }>;
  },
) {
  return {
    id: b.id,
    agentId: b.botId,
    agentName: ctx.agentNameById.get(b.botId) ?? null,
    startTime: b.startUtc.toISOString(),
    endTime: b.endUtc.toISOString(),
    status: b.status,
    attendeeName: b.attendeeName ?? null,
    attendeeEmail: b.attendeeEmail ?? null,
    notes: b.notes ?? null,
    meetingUrl: ctx.meetByBooking.get(b.id) ?? null,
    calendarSync: calendarSyncState(b, ctx.mirroredBookingIds.has(b.id)),
    sourceChannel: b.sourceChannel ?? null,
    aiSummary: b.aiSummary ?? null,
    ...adminServiceSlice(b.eventTypeId, ctx.nameByService, ctx.questionsByService, b.intakeAnswers),
    durationMin: b.bookedDurationMin ?? null,
    bookingMode: b.bookingMode ?? null,
    requestKind: b.requestKind ?? 'new',
    relatedBookingId: b.relatedBookingId ?? null,
    customerAddress: b.customerAddress ?? null,
    serviceAreaMatch: b.serviceAreaMatch ?? null,
    travelCheck: b.travelCheck ?? null,
    travelEstimate: ctx.estimateByBooking.get(b.id) ?? null,
    customerPhone: b.customerPhone ?? null,
    uploadedFiles: uploadedFileSnapshots(b.uploadedFiles),
  };
}


/** Build a provider context for admin actions from a booking's own bot/session. */
async function buildAdminContext(tenantId: string, booking: Booking): Promise<BookingContext> {
  const tenant = await AppDataSource.getRepository(Tenant).findOne({ where: { id: tenantId } });
  if (!tenant) throw new BookingError('Tenant not found', 'TENANT_NOT_FOUND', 404);
  const bot = await getOwnedBot(booking.botId, tenantId);
  // Reuse the booking's originating session for audit-log parity. If the row
  // was purged, synthesize a minimal session (booking_logs.session_id is a
  // plain uuid column, not a FK to chat_sessions).
  let session = booking.sessionId
    ? await AppDataSource.getRepository(ChatSession).findOne({ where: { id: booking.sessionId } })
    : null;
  if (!session) {
    session = { id: booking.sessionId ?? booking.id, tenantId, botId: bot.id } as ChatSession;
  }
  return {
    session,
    tenant,
    bot,
    botSettings: bot.settings ?? ({} as BotSettings),
    isAdmin: true,
    // The OWNER acting on their own diary. Travel warns them and never blocks them — plan
    // §6.17, ADR-0015 — and this is the one place every owner-side write path gets the policy,
    // so accept, decline, cancel and the portal reschedule cannot disagree about it. Set here
    // rather than at each call site because a path that forgot would silently gate the owner,
    // which is the failure the read side already had to fix once.
    travelPolicy: 'annotate',
  };
}

/**
 * The drive either side of every request on ONE page, from one diary read.
 *
 * THE COST SHAPE IS THE POINT. Per-row this is N HTTP calls and N diary reads to answer the
 * same question N times; here it is one span covering every request on the page, loaded once and
 * matched in memory. The requests a business is looking at cluster in time, so that span is
 * usually a few days.
 *
 * Everything expensive is behind the same four gates the rest of travel is, so for every tenant
 * on the platform today this returns an empty map after one settings read.
 *
 * Never throws. An estimate is a courtesy on a list; failing to produce one must not fail the
 * list.
 */
async function travelEstimatesForRequests(
  tenantId: string,
  botId: string,
  rows: Booking[],
  services: ServiceType[]
): Promise<Map<string, { before: DriveEstimate | null; after: DriveEstimate | null; basis: 'distance' }>> {
  const out = new Map<string, { before: DriveEstimate | null; after: DriveEstimate | null; basis: 'distance' }>();
  const travelServices = new Set(services.filter((s) => serviceNeedsCustomerAddress(s)).map((s) => s.id));
  const candidates = rows.filter((b) => b.eventTypeId && travelServices.has(b.eventTypeId));
  if (!candidates.length) return out;

  try {
    const itineraryKey = await resolveItineraryKey(botId);
    const eligibility = await resolveTravelEligibility({ tenantId, botId, itineraryKey });
    if (!eligibility.active) return out;

    const from = new Date(Math.min(...candidates.map((b) => b.startUtc.getTime())));
    const to = new Date(Math.max(...candidates.map((b) => b.endUtc.getTime())));
    const { neighbours } = await loadTravelNeighbours({ eligibility, botId, from, to });

    for (const b of candidates) {
      // A request holds no blocked range, so its own row is not among the neighbours and there
      // is nothing to exclude. Its place is read from the row rather than resolved: a list is
      // not the place to spend an element, and a request whose address was never placed simply
      // has no estimate.
      const place = storedPlace(b);
      if (!place) continue;
      const point = { lat: place.lat, lng: place.lng };
      const before = precedingNeighbour(neighbours, { blockedStart: b.startUtc });
      const after = followingNeighbour(neighbours, { blockedEnd: b.endUtc });
      const leg = (n: typeof before): DriveEstimate | null =>
        n && (n.location.kind === 'known' || n.location.kind === 'coarse')
          ? estimateDrive(n.location.point, point)
          : null;
      const estimate = { before: leg(before), after: leg(after), basis: 'distance' as const };
      if (estimate.before || estimate.after) out.set(b.id, estimate);
    }
  } catch (error) {
    logger.warn('[Travel] could not estimate drives for the requests list', { tenantId, botId, error });
  }
  return out;
}

/**
 * A named Agent, or a 404 in this module's own error vocabulary.
 *
 * `getOwnedBot` throws `BotNotFoundConfigError`, which the global handler does not recognise
 * and reports as a **500**. That turns "that Agent is not yours" into "the server broke", which
 * is both wrong and less safe: a 500 invites a retry. Every booking-service failure is already
 * a `BookingError` carrying its own status, so this converts at the one place it can happen.
 */
async function ownedBotOr404(botId: string, tenantId: string): Promise<Bot> {
  return (await ownedBotConfigOr404(botId, tenantId)).bot;
}

/** The same, keeping the Agent's own settings — availability is computed from them. */
async function ownedBotConfigOr404(
  botId: string,
  tenantId: string
): Promise<{ bot: Bot; settings: BotSettings }> {
  try {
    return await getOwnedBotConfig(botId, tenantId);
  } catch {
    throw new BookingError('Agent not found', 'BOT_NOT_FOUND', 404);
  }
}

/**
 * The same estimates, for a page that may hold more than one Agent's requests.
 *
 * Splits by Agent and asks each question of the right diary. Merging is safe because a
 * booking belongs to exactly one Agent, so no two passes can answer for the same row.
 */
async function travelEstimatesByAgent(
  tenantId: string,
  rows: Booking[],
  services: ServiceType[]
): Promise<Map<string, { before: DriveEstimate | null; after: DriveEstimate | null; basis: 'distance' }>> {
  const byAgent = new Map<string, Booking[]>();
  for (const row of rows) {
    const list = byAgent.get(row.botId) ?? [];
    list.push(row);
    byAgent.set(row.botId, list);
  }
  const merged = new Map<string, { before: DriveEstimate | null; after: DriveEstimate | null; basis: 'distance' }>();
  for (const [botId, agentRows] of byAgent) {
    const estimates = await travelEstimatesForRequests(tenantId, botId, agentRows, services);
    for (const [bookingId, estimate] of estimates) merged.set(bookingId, estimate);
  }
  return merged;
}

/**
 * List a tenant's internal bookings, upcoming or past.
 *
 * `botId` ABSENT MEANS EVERY AGENT, not the default one, and that is the fix for #87. This
 * used to resolve the anchor unconditionally, so in a tenant with more than one Agent the
 * second Agent's appointments were invisible in the portal: they existed, held time, sent
 * confirmations and calendar invites, and the owner could not see, cancel, reschedule, accept
 * or decline any of them. A tenant with one Agent is unaffected - "all of them" is that one -
 * so nobody gains a choice they did not have a reason to make.
 */
export async function adminListBookings(
  caller: BookingCaller,
  tenantId: string,
  scope: BookingScope,
  limit: number,
  offset: number,
  botId?: string
): Promise<{ bookings: AdminBookingRow[]; total: number }> {
  await enforceBookingsFeature(tenantId, caller);
  // Named, not just filtered on. A bare `WHERE bot_id = $1` would answer an empty list for
  // another tenant's Agent id, which reads as "no appointments" rather than "not yours".
  const bot = botId ? await ownedBotOr404(botId, tenantId) : null;
  const repo = AppDataSource.getRepository(Booking);
  const now = new Date();

  const qb = repo
    .createQueryBuilder('b')
    .where('b.tenantId = :tenantId', { tenantId })
    .andWhere("b.provider = 'internal'");
  if (bot) qb.andWhere('b.botId = :botId', { botId: bot.id });

  if (scope === 'upcoming') {
    qb.andWhere("b.status = 'confirmed'").andWhere('b.endUtc >= :now', { now }).orderBy('b.startUtc', 'ASC');
  } else if (scope === 'requests') {
    // Captured requests awaiting owner follow-up. Same tenant/bot/provider scoping
    // as upcoming/past — this scope must not widen access.
    qb.andWhere("b.status = 'request_created'").orderBy('b.createdAt', 'DESC');
  } else {
    qb.andWhere("(b.status = 'cancelled' OR (b.status = 'confirmed' AND b.endUtc < :now))", { now }).orderBy(
      'b.startUtc',
      'DESC'
    );
  }

  const total = await qb.getCount();
  const rows = await qb.take(limit).skip(offset).getMany();

  const ids = rows.map((r) => r.id);
  // Every provider, not just Google: filtering to google here meant an Outlook-synced
  // booking showed no sync evidence at all. The Meet URL is still Google-only.
  const refs = ids.length
    ? await AppDataSource.getRepository(BookingReference).find({ where: { bookingId: In(ids) } })
    : [];
  const meetByBooking = new Map(
    refs.filter((r) => r.providerType === 'google').map((r) => [r.bookingId, r.meetingUrl ?? null])
  );
  const mirroredBookingIds = new Set(refs.map((r) => r.bookingId));

  // Service-name lookup for display (requests have no Meet URL but do name the service).
  const serviceIds = [...new Set(rows.map((r) => r.eventTypeId).filter((v): v is string => !!v))];
  // Scoped to the tenant AND to the Agents these rows actually belong to, so a stale or
  // cross-linked `event_type_id` can never surface another tenant's service name. Narrowing
  // to a single Agent, as this did, would blank the service name on every row belonging to
  // any other one.
  const rowBotIds = [...new Set(rows.map((r) => r.botId))];
  // One lookup for the whole page. Named from the Agents the rows actually reference, so a
  // deleted Agent's historical bookings still list with a null name rather than vanishing.
  const agentNameById = new Map(
    rowBotIds.length
      ? (
          await AppDataSource.getRepository(Bot).find({
            where: { id: In(rowBotIds), tenantId },
            select: ['id', 'name'],
          })
        ).map((b) => [b.id, b.name])
      : []
  );
  const services =
    serviceIds.length && rowBotIds.length
      ? await AppDataSource.getRepository(ServiceType).find({
          where: { id: In(serviceIds), tenantId, botId: In(rowBotIds) },
        })
      : [];
  const nameByService = new Map(services.map((s) => [s.id, s.name]));
  // Reuse the already-loaded service rows for the per-row intake-answer labels (no extra query).
  const questionsByService = new Map(services.map((s) => [s.id, s.intakeQuestions]));

  // ONE diary read for the whole page, not one per row. Accepting a captured Request is an
  // owner OVERRIDE (ADR-0015), and an override whose grounds nobody can see is a rubber stamp —
  // so the drive has to be on the row, next to the button, before it is clicked. The first
  // version of that put a fetch INSIDE the row component, which turned "thirty requests" into
  // thirty HTTP calls to learn thirty times that travel is off. Same information, one query,
  // computed here where the whole page is already in hand.
  // PER AGENT, because an itinerary is per Agent. Travel eligibility, the itinerary key and
  // the neighbouring jobs are all that Agent's; computing one Agent's requests against
  // another's diary would put a confident, wrong drive time beside an override button, which
  // is worse than showing none. One pass per Agent that actually has rows on this page - in a
  // single-Agent tenant that is exactly the one query it always was.
  const estimateByBooking =
    scope === 'requests' ? await travelEstimatesByAgent(tenantId, rows, services) : new Map();

  return {
    total,
    bookings: rows.map((b) =>
      toAdminBookingRow(b, {
        agentNameById,
        meetByBooking,
        mirroredBookingIds,
        nameByService,
        questionsByService,
        estimateByBooking,
      }),
    ),
  };
}

/** Real available slots for the anchor bot (powers the admin reschedule picker). */
export async function adminAvailability(
  caller: BookingCaller,
  tenantId: string,
  startDate: string,
  endDate: string,
  serviceId?: string,
  durationMin?: number,
  /** Set by the reschedule flows so a booking is not counted against its own move. */
  excludeBookingId?: string,
  /**
   * WHOSE availability. Absent means the tenant's default Agent, which is the only sensible
   * answer for a question asked without a booking in hand.
   *
   * Both reschedule pickers pass it, and #87 is what happens when they do not: availability
   * was computed against the default Agent's diary, opening hours, services and travel
   * settings while the customer was moving a different Agent's appointment. The offered times
   * were answers to a question nobody asked.
   */
  botId?: string
) {
  // public-manage may reach this (slot lookup inside the token-verified
  // reschedule flow, scoped to the booking's service) — D8.
  await enforceBookingsFeature(tenantId, caller, { tokenVerifiedLookup: true });
  const { bot, settings } = botId
    ? await ownedBotConfigOr404(botId, tenantId)
    : await getAnchorBotConfig(tenantId);
  const tenant = await AppDataSource.getRepository(Tenant).findOne({ where: { id: tenantId } });
  if (!tenant) throw new BookingError('Tenant not found', 'TENANT_NOT_FOUND', 404);
  // checkAvailability only reads ctx.bot — the synthetic session is never used.
  const ctx: BookingContext = {
    session: { id: bot.id, tenantId, botId: bot.id } as ChatSession,
    tenant,
    bot,
    botSettings: settings,
    // Both callers of this helper are moving a booking that already exists: the owner's
    // portal picker and the customer's token-verified manage link. A booking pause stops
    // *new* online bookings, so neither may be gated by it — without this the pause makes
    // the owner's own diary look empty and reports the customer's link as expired.
    isAdmin: true,
    // ...and here the two part company. `isAdmin` covers them both because neither is a new
    // online booking. Feasibility is a different question — whose judgement decides whether a
    // drive is possible — and the answer is the owner's for their own diary and NOT the
    // customer's for theirs. A customer following a manage link must never be offered a time
    // nobody can drive to, so they get the same enforcement the bot does.
    travelPolicy: caller === 'scheduler-admin' ? 'annotate' : 'enforce',
  };
  // Pass the booking's service + frozen length so the reschedule picker resolves
  // the right service (no SERVICE_REQUIRED when several are active) and shows
  // slots sized to the existing booking.
  return internalProvider.checkAvailability(ctx, startDate, endDate, serviceId, durationMin, excludeBookingId);
}

/** Load a tenant-owned internal booking or throw a 404 (no cross-tenant leak). */
async function loadAdminBooking(tenantId: string, bookingId: string): Promise<Booking> {
  const booking = await AppDataSource.getRepository(Booking).findOne({ where: { id: bookingId } });
  if (!booking || booking.tenantId !== tenantId) {
    throw new BookingError('Booking not found', 'BOOKING_NOT_FOUND', 404);
  }
  if (booking.provider !== 'internal') {
    throw new BookingError('Only internal bookings can be managed here', 'BOOKING_PROVIDER_UNSUPPORTED', 400);
  }
  return booking;
}

export async function adminCancelBooking(caller: BookingCaller, tenantId: string, bookingId: string, reason?: string) {
  await enforceBookingsFeature(tenantId, caller, { manageableBookingId: bookingId });
  const booking = await loadAdminBooking(tenantId, bookingId);
  const ctx = await buildAdminContext(tenantId, booking);
  ctx.subjectToCustomerChangePolicy = subjectToCustomerChangePolicy(caller);
  return internalProvider.cancelBooking(ctx, bookingId, reason);
}

export async function adminRescheduleBooking(caller: BookingCaller, tenantId: string, bookingId: string, newStartTime: string) {
  await enforceBookingsFeature(tenantId, caller, { manageableBookingId: bookingId });
  const booking = await loadAdminBooking(tenantId, bookingId);
  const ctx = await buildAdminContext(tenantId, booking);
  ctx.subjectToCustomerChangePolicy = subjectToCustomerChangePolicy(caller);
  return internalProvider.rescheduleBooking(ctx, bookingId, newStartTime);
}

/** Apply an owner's external-calendar edit. Callers MUST have already passed
 *  isCalendarSyncAllowed(tenantId) - the entitlement taxonomy forces calendarSync
 *  off whenever bookings is off, so no second feature gate is needed here. */
export async function externalRescheduleBooking(
  tenantId: string,
  bookingId: string,
  newStartTime: string,
  durationMin: number
) {
  const booking = await loadAdminBooking(tenantId, bookingId);
  const ctx = await buildAdminContext(tenantId, booking);
  const start = new Date(newStartTime);
  const end = new Date(start.getTime() + durationMin * 60_000);
  return internalProvider.rescheduleBooking(ctx, bookingId, newStartTime, {
    durationMin,
    excludeExternalInterval: { start, end },
  });
}

export async function externalCancelBooking(tenantId: string, bookingId: string, reason: string) {
  const booking = await loadAdminBooking(tenantId, bookingId);
  const ctx = await buildAdminContext(tenantId, booking);
  return internalProvider.cancelBooking(ctx, bookingId, reason);
}

export async function adminAcceptRequest(
  caller: BookingCaller,
  tenantId: string,
  bookingId: string,
  /** #72: the owner has been shown the appointment this would duplicate and wants it anyway. */
  options?: { allowDuplicate?: boolean }
) {
  // Owner action — never public-manage-exempt (D8 is cancel/reschedule only),
  // so no bookingId is passed to the gate.
  await enforceBookingsFeature(tenantId, caller);
  const booking = await loadAdminBooking(tenantId, bookingId);
  const ctx = await buildAdminContext(tenantId, booking);
  return internalProvider.acceptRequest(ctx, bookingId, options);
}

export async function adminDeclineRequest(caller: BookingCaller, tenantId: string, bookingId: string, reason?: string) {
  // Owner action — never public-manage-exempt (D8 is cancel/reschedule only).
  await enforceBookingsFeature(tenantId, caller);
  const booking = await loadAdminBooking(tenantId, bookingId);
  const ctx = await buildAdminContext(tenantId, booking);
  return internalProvider.declineRequest(ctx, bookingId, reason);
}

/**
 * Booking + display context for the public self-service manage page.
 * Intentionally ungated (D8): the manage page must render for the customer
 * even after the tenant loses the bookings feature — existing appointments
 * stay manageable; only NEW bookings are gated. Access control is the manage
 * token, verified by the public controller before this is called.
 */
export async function getManageBooking(
  bookingId: string
): Promise<{
  booking: Booking;
  timezone: string;
  eventName: string;
  rescheduleMode: CustomerChangeMode;
  cancelMode: CustomerChangeMode;
  rescheduleUntilMin: number | null;
  cancelUntilMin: number | null;
} | null> {
  const booking = await AppDataSource.getRepository(Booking).findOne({ where: { id: bookingId } });
  if (!booking || booking.provider !== 'internal') return null;
  // Canonical, server-owned business timezone — the bot is authoritative on
  // read; the AvailabilityRule copy is a denormalization.
  // Load THIS booking's Service, not any active one: two Services can disagree
  // on reschedule/cancel policy, and the manage page must follow the one booked.
  const [timezone, eventType] = await Promise.all([
    getBotBusinessTimezone(booking.botId),
    booking.eventTypeId
      ? AppDataSource.getRepository(ServiceType).findOne({ where: { id: booking.eventTypeId } })
      : AppDataSource.getRepository(ServiceType).findOne({ where: { botId: booking.botId, isActive: true } }),
  ]);
  return {
    booking,
    timezone,
    eventName: eventType?.name ?? 'Appointment',
    rescheduleMode: eventType?.rescheduleMode ?? DEFAULT_CUSTOMER_CHANGE_MODE,
    cancelMode: eventType?.cancelMode ?? DEFAULT_CUSTOMER_CHANGE_MODE,
    rescheduleUntilMin: eventType?.rescheduleUntilMin ?? null,
    cancelUntilMin: eventType?.cancelUntilMin ?? null,
  };
}

// Lifted to its own dependency-free module; re-exported so existing importers are unaffected.
export { buildIntakeAnswers };


export type CalendarSyncState = 'synced' | 'pending' | 'failed' | 'none';

/**
 * What the owner is told about a booking's calendar mirror.
 *
 * `sync_last_error` is written by BOTH the retry path and the terminal one; the ONLY thing
 * that distinguishes them is `sync_pending`, which `terminal()` clears and `recordFailure()`
 * deliberately leaves true. So pending must be tested FIRST. Testing the error first
 * reported attempt 1 of 6 — with the next try due in minutes — as a red "Not on your
 * calendar" alarm telling the owner to reconnect and add the event by hand, while the
 * reconciler was busy fixing it.
 *
 * Exported and pure so the rule can be tested directly rather than re-stated in a test.
 */
export function calendarSyncState(
  b: Pick<Booking, 'status' | 'syncPending' | 'syncLastError'>,
  hasMirror: boolean
): CalendarSyncState {
  if (b.status !== 'confirmed') return 'none';
  if (b.syncPending) return 'pending';
  if (b.syncLastError) return 'failed';
  return hasMirror ? 'synced' : 'none';
}

