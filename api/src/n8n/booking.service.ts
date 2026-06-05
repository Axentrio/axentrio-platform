/**
 * Booking service — provider dispatcher.
 *
 * Resolves the provider-agnostic context (session → tenant → bot settings) and
 * delegates each operation to the `BookingProvider` configured for the bot
 * (`bot.settings.integrations.provider`, default `'calcom'`). The five exported
 * functions keep their original signatures so callers (n8n booking tools, the
 * `/internal/booking/*` routes, the in-house agent tool) are unchanged.
 */
import { AppDataSource } from '../database/data-source';
import { ChatSession } from '../database/entities/ChatSession';
import { Tenant } from '../database/entities/Tenant';
import type { BotSettings } from '../database/entities/Bot';
import { getBotConfigForSession } from '../services/bot-config.service';
import { BookingError, BookingContext, BookingProvider } from './booking-providers/types';
import { CalcomProvider } from './booking-providers/calcom.provider';

// Re-export so existing importers (`import { BookingError } from './booking.service'`)
// keep working unchanged.
export { BookingError } from './booking-providers/types';

const calcomProvider = new CalcomProvider();

/** Select the booking backend for a bot. Defaults to Cal.com when unset. */
function selectProvider(botSettings: BotSettings): BookingProvider {
  const provider = botSettings.integrations?.provider ?? 'calcom';
  switch (provider) {
    case 'calcom':
      return calcomProvider;
    // case 'internal': added in a later slice
    default:
      return calcomProvider;
  }
}

/** Resolve session, tenant, and bot settings — provider-agnostic. */
async function resolveContext(sessionId: string): Promise<BookingContext> {
  const session = await AppDataSource.getRepository(ChatSession).findOne({ where: { id: sessionId } });
  if (!session) throw new BookingError('Session not found', 'SESSION_NOT_FOUND', 404);

  const tenant = await AppDataSource.getRepository(Tenant).findOne({ where: { id: session.tenantId } });
  if (!tenant) throw new BookingError('Tenant not found', 'TENANT_NOT_FOUND', 404);

  // Multi-bot Phase 4 (#16d): integrations + businessHours live on Bot.settings
  // resolved from the session's bot (anchor fallback if session.botId is null).
  const { settings: botSettings } = await getBotConfigForSession(session);

  return { session, tenant, botSettings };
}

export async function listBookings(sessionId: string, attendeeEmail: string) {
  const ctx = await resolveContext(sessionId);
  return selectProvider(ctx.botSettings).listBookings(ctx, attendeeEmail);
}

export async function checkAvailability(sessionId: string, startDate: string, endDate: string) {
  const ctx = await resolveContext(sessionId);
  return selectProvider(ctx.botSettings).checkAvailability(ctx, startDate, endDate);
}

export async function createBooking(
  sessionId: string,
  idempotencyKey: string,
  startTime: string,
  attendee: { name: string; email: string },
  notes?: string
) {
  const ctx = await resolveContext(sessionId);
  return selectProvider(ctx.botSettings).createBooking(ctx, idempotencyKey, startTime, attendee, notes);
}

export async function rescheduleBooking(sessionId: string, bookingId: string, newStartTime: string) {
  const ctx = await resolveContext(sessionId);
  return selectProvider(ctx.botSettings).rescheduleBooking(ctx, bookingId, newStartTime);
}

export async function cancelBooking(sessionId: string, bookingId: string, reason?: string) {
  const ctx = await resolveContext(sessionId);
  return selectProvider(ctx.botSettings).cancelBooking(ctx, bookingId, reason);
}
