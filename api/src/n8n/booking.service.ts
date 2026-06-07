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
import { AvailabilityRule } from '../database/entities/AvailabilityRule';
import type { BotSettings } from '../database/entities/Bot';
import { getBotConfigForSession, getAnchorBotConfig, getOwnedBot } from '../services/bot-config.service';
import { BookingError, BookingContext, BookingProvider } from './booking-providers/types';
import { InternalProvider } from './booking-providers/internal.provider';

// Re-export so existing importers (`import { BookingError } from './booking.service'`)
// keep working unchanged.
export { BookingError } from './booking-providers/types';

const internalProvider = new InternalProvider();

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

export async function listBookings(sessionId: string, attendeeEmail: string) {
  const ctx = await resolveContext(sessionId);
  return selectProvider().listBookings(ctx, attendeeEmail);
}

export async function checkAvailability(
  sessionId: string,
  startDate: string,
  endDate: string,
  serviceId?: string
) {
  const ctx = await resolveContext(sessionId);
  return selectProvider().checkAvailability(ctx, startDate, endDate, serviceId);
}

export async function createBooking(
  sessionId: string,
  idempotencyKey: string,
  startTime: string,
  attendee: { name: string; email: string },
  notes?: string,
  serviceId?: string
) {
  const ctx = await resolveContext(sessionId);
  return selectProvider().createBooking(ctx, idempotencyKey, startTime, attendee, notes, serviceId);
}

export async function rescheduleBooking(sessionId: string, bookingId: string, newStartTime: string) {
  const ctx = await resolveContext(sessionId);
  return selectProvider().rescheduleBooking(ctx, bookingId, newStartTime);
}

export async function cancelBooking(sessionId: string, bookingId: string, reason?: string) {
  const ctx = await resolveContext(sessionId);
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

export type BookingScope = 'upcoming' | 'past';

export interface AdminBookingRow {
  id: string;
  startTime: string;
  endTime: string;
  status: string;
  attendeeName: string | null;
  attendeeEmail: string | null;
  notes: string | null;
  meetingUrl: string | null;
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
  return { session, tenant, bot, botSettings: bot.settings ?? ({} as BotSettings) };
}

/** List the tenant anchor bot's internal bookings, upcoming or past. */
export async function adminListBookings(
  tenantId: string,
  scope: BookingScope,
  limit: number,
  offset: number
): Promise<{ bookings: AdminBookingRow[]; total: number }> {
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
    })),
  };
}

/** Real available slots for the anchor bot (powers the admin reschedule picker). */
export async function adminAvailability(tenantId: string, startDate: string, endDate: string) {
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
  return internalProvider.checkAvailability(ctx, startDate, endDate);
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

export async function adminCancelBooking(tenantId: string, bookingId: string, reason?: string) {
  const booking = await loadAdminBooking(tenantId, bookingId);
  const ctx = await buildAdminContext(tenantId, booking);
  return internalProvider.cancelBooking(ctx, bookingId, reason);
}

export async function adminRescheduleBooking(tenantId: string, bookingId: string, newStartTime: string) {
  const booking = await loadAdminBooking(tenantId, bookingId);
  const ctx = await buildAdminContext(tenantId, booking);
  return internalProvider.rescheduleBooking(ctx, bookingId, newStartTime);
}

/** Booking + display context for the public self-service manage page. */
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
