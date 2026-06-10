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
import { ServiceType, type IntakeQuestion } from '../database/entities/ServiceType';
import { AvailabilityRule } from '../database/entities/AvailabilityRule';
import type { BotSettings } from '../database/entities/Bot';
import { getBotConfigForSession, getAnchorBotConfig, getOwnedBot } from '../services/bot-config.service';
import { BookingError, BookingContext, BookingProvider, BookingExtras } from './booking-providers/types';
import { InternalProvider } from './booking-providers/internal.provider';
import { upsertLead } from '../leads/lead-capture.service';
import { requireFeature } from '../billing/enforce';

// Re-export so existing importers (`import { BookingError } from './booking.service'`)
// keep working unchanged.
export { BookingError } from './booking-providers/types';

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

/**
 * The booking backend. Cal.com is shelved — the in-house scheduler is the only
 * active provider, so we ignore any stored `integrations.provider` value. To
 * bring Cal.com back, restore the per-bot switch on `botSettings` here.
 */
function selectProvider(): BookingProvider {
  return internalProvider;
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

export async function listBookings(caller: BookingCaller, sessionId: string, attendeeEmail: string) {
  const ctx = await resolveContext(sessionId);
  await enforceBookingsFeature(ctx.tenant.id, caller);
  return selectProvider().listBookings(ctx, attendeeEmail);
}

export async function checkAvailability(
  caller: BookingCaller,
  sessionId: string,
  startDate: string,
  endDate: string,
  serviceId?: string,
  durationMin?: number
) {
  const ctx = await resolveContext(sessionId);
  await enforceBookingsFeature(ctx.tenant.id, caller);
  return selectProvider().checkAvailability(ctx, startDate, endDate, serviceId, durationMin);
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
  const result = await selectProvider().createBooking(ctx, idempotencyKey, startTime, attendee, notes, serviceId, intakeAnswers, extras);
  captureLeadFromBooking(ctx, attendee, extras);
  return result;
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
  captureLeadFromBooking(ctx, attendee, extras);
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
): void {
  const channel = ctx.session.channel ?? 'widget';
  const isChannel = channel !== 'widget' && !!ctx.session.channelConnectionId;
  void upsertLead({
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
  }).catch(() => {});
}

export async function rescheduleBooking(caller: BookingCaller, sessionId: string, bookingId: string, newStartTime: string) {
  const ctx = await resolveContext(sessionId);
  await enforceBookingsFeature(ctx.tenant.id, caller, { manageableBookingId: bookingId });
  return selectProvider().rescheduleBooking(ctx, bookingId, newStartTime);
}

export async function cancelBooking(caller: BookingCaller, sessionId: string, bookingId: string, reason?: string) {
  const ctx = await resolveContext(sessionId);
  await enforceBookingsFeature(ctx.tenant.id, caller, { manageableBookingId: bookingId });
  return selectProvider().cancelBooking(ctx, bookingId, reason);
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
  /** P3: ordered, pre-labeled intake answers for display (null if none). */
  intakeAnswers?: Array<{ label: string; answer: string }> | null;
  /** P5a: captured contact details (null when not collected). */
  customerAddress?: string | null;
  customerPhone?: string | null;
  /** P5e: attached files (snapshot subset for display/download). */
  uploadedFiles?: Array<{ fileSessionId: string; fileName: string }> | null;
}

/**
 * P3: read-side coercion of a stored intake answer — MUST mirror the write-side
 * `normalizeIntakeAnswers` so reads/writes agree on a "displayable answer".
 * string→trim; number/boolean→String; null/undefined/array/object→null; cap 2000.
 */
function coerceAnswer(value: unknown): string | null {
  let str: string;
  if (typeof value === 'string') str = value;
  else if (typeof value === 'number' || typeof value === 'boolean') str = String(value);
  else return null;
  const trimmed = str.trim();
  return trimmed ? trimmed.slice(0, 2000) : null;
}

/**
 * Build the ordered, pre-labeled answer list for one booking row: walk the
 * service's questions IN ARRAY ORDER (current label), then append any answer
 * keyed by a now-deleted/unknown question id sorted by key (deterministic) with
 * the raw id as label. A malformed/non-array `questions` degrades to "no
 * questions" (all answers fall through to the deleted branch); a non-object
 * stored value reads as no answers. Returns null when nothing displays.
 */
export function buildIntakeAnswers(
  questions: IntakeQuestion[] | null | undefined,
  stored: unknown
): Array<{ label: string; answer: string }> | null {
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return null;
  const answers = stored as Record<string, unknown>;
  const qs = Array.isArray(questions) ? questions : [];
  const out: Array<{ label: string; answer: string }> = [];
  const usedKeys = new Set<string>();
  for (const q of qs) {
    // Skip malformed question entries (non-string id/label from legacy/hand-edited
    // jsonb) WITHOUT marking the id used — a stored answer then falls through to the
    // raw-id branch below (preserved, never dropped; a non-string label can't reach React).
    if (!q || typeof q.id !== 'string' || typeof q.label !== 'string' || !(q.id in answers)) continue;
    const answer = coerceAnswer(answers[q.id]);
    if (answer === null) continue;
    out.push({ label: q.label, answer });
    usedKeys.add(q.id);
  }
  // Deleted/unknown question ids: append sorted by key (jsonb key order isn't guaranteed).
  for (const key of Object.keys(answers).sort()) {
    if (usedKeys.has(key)) continue;
    const answer = coerceAnswer(answers[key]);
    if (answer === null) continue;
    out.push({ label: key, answer });
  }
  return out.length ? out : null;
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
  return { session, tenant, bot, botSettings: bot.settings ?? ({} as BotSettings), isAdmin: true };
}

/** List the tenant anchor bot's internal bookings, upcoming or past. */
export async function adminListBookings(
  caller: BookingCaller,
  tenantId: string,
  scope: BookingScope,
  limit: number,
  offset: number
): Promise<{ bookings: AdminBookingRow[]; total: number }> {
  await enforceBookingsFeature(tenantId, caller);
  const { bot } = await getAnchorBotConfig(tenantId);
  const repo = AppDataSource.getRepository(Booking);
  const now = new Date();

  const qb = repo
    .createQueryBuilder('b')
    .where('b.tenantId = :tenantId', { tenantId })
    .andWhere('b.botId = :botId', { botId: bot.id })
    .andWhere("b.provider = 'internal'");

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
  const refs = ids.length
    ? await AppDataSource.getRepository(BookingReference).find({
        where: { bookingId: In(ids), providerType: 'google' },
      })
    : [];
  const meetByBooking = new Map(refs.map((r) => [r.bookingId, r.meetingUrl ?? null]));

  // Service-name lookup for display (requests have no Meet URL but do name the service).
  const serviceIds = [...new Set(rows.map((r) => r.eventTypeId).filter((v): v is string => !!v))];
  const services = serviceIds.length
    ? await AppDataSource.getRepository(ServiceType).find({
        // Scope the name lookup to this tenant+bot so a stale/cross-linked event_type_id
        // can never surface another tenant's service name.
        where: { id: In(serviceIds), tenantId, botId: bot.id },
      })
    : [];
  const nameByService = new Map(services.map((s) => [s.id, s.name]));
  // Reuse the already-loaded service rows for the per-row intake-answer labels (no extra query).
  const questionsByService = new Map(services.map((s) => [s.id, s.intakeQuestions]));

  return {
    total,
    bookings: rows.map((b) => ({
      id: b.id,
      startTime: b.startUtc.toISOString(),
      endTime: b.endUtc.toISOString(),
      status: b.status,
      attendeeName: b.attendeeName ?? null,
      attendeeEmail: b.attendeeEmail ?? null,
      notes: b.notes ?? null,
      meetingUrl: meetByBooking.get(b.id) ?? null,
      serviceName: b.eventTypeId ? nameByService.get(b.eventTypeId) ?? null : null,
      serviceId: b.eventTypeId ?? null,
      durationMin: b.bookedDurationMin ?? null,
      bookingMode: b.bookingMode ?? null,
      intakeAnswers: buildIntakeAnswers(
        b.eventTypeId ? questionsByService.get(b.eventTypeId) : null,
        b.intakeAnswers
      ),
      customerAddress: b.customerAddress ?? null,
      customerPhone: b.customerPhone ?? null,
      uploadedFiles: Array.isArray(b.uploadedFiles)
        ? (b.uploadedFiles as Array<Record<string, unknown>>)
            .filter((f) => f && typeof f.fileSessionId === 'string' && typeof f.fileName === 'string')
            .map((f) => ({ fileSessionId: f.fileSessionId as string, fileName: f.fileName as string }))
        : null,
    })),
  };
}

/** Real available slots for the anchor bot (powers the admin reschedule picker). */
export async function adminAvailability(
  caller: BookingCaller,
  tenantId: string,
  startDate: string,
  endDate: string,
  serviceId?: string,
  durationMin?: number
) {
  // public-manage may reach this (slot lookup inside the token-verified
  // reschedule flow, scoped to the booking's service) — D8.
  await enforceBookingsFeature(tenantId, caller, { tokenVerifiedLookup: true });
  const { bot, settings } = await getAnchorBotConfig(tenantId);
  const tenant = await AppDataSource.getRepository(Tenant).findOne({ where: { id: tenantId } });
  if (!tenant) throw new BookingError('Tenant not found', 'TENANT_NOT_FOUND', 404);
  // checkAvailability only reads ctx.bot — the synthetic session is never used.
  const ctx: BookingContext = {
    session: { id: bot.id, tenantId, botId: bot.id } as ChatSession,
    tenant,
    bot,
    botSettings: settings,
  };
  // Pass the booking's service + frozen length so the reschedule picker resolves
  // the right service (no SERVICE_REQUIRED when several are active) and shows
  // slots sized to the existing booking.
  return internalProvider.checkAvailability(ctx, startDate, endDate, serviceId, durationMin);
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
  return internalProvider.cancelBooking(ctx, bookingId, reason);
}

export async function adminRescheduleBooking(caller: BookingCaller, tenantId: string, bookingId: string, newStartTime: string) {
  await enforceBookingsFeature(tenantId, caller, { manageableBookingId: bookingId });
  const booking = await loadAdminBooking(tenantId, bookingId);
  const ctx = await buildAdminContext(tenantId, booking);
  return internalProvider.rescheduleBooking(ctx, bookingId, newStartTime);
}

export async function adminAcceptRequest(caller: BookingCaller, tenantId: string, bookingId: string) {
  // Owner action — never public-manage-exempt (D8 is cancel/reschedule only),
  // so no bookingId is passed to the gate.
  await enforceBookingsFeature(tenantId, caller);
  const booking = await loadAdminBooking(tenantId, bookingId);
  const ctx = await buildAdminContext(tenantId, booking);
  return internalProvider.acceptRequest(ctx, bookingId);
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
): Promise<{ booking: Booking; timezone: string; eventName: string } | null> {
  const booking = await AppDataSource.getRepository(Booking).findOne({ where: { id: bookingId } });
  if (!booking || booking.provider !== 'internal') return null;
  const [rule, eventType] = await Promise.all([
    AppDataSource.getRepository(AvailabilityRule).findOne({ where: { botId: booking.botId } }),
    AppDataSource.getRepository(ServiceType).findOne({ where: { botId: booking.botId, isActive: true } }),
  ]);
  return { booking, timezone: rule?.timezone ?? 'UTC', eventName: eventType?.name ?? 'Appointment' };
}
