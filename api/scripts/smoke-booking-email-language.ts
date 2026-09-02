/**
 * Local smoke test for booking email / manage-page i18n.
 *
 * Usage:
 *   cd api && npm run smoke:booking-i18n
 *
 * Env:
 *   SMOKE_CUSTOMER_LANG=fr       manage-page stamp language (default fr)
 *   SMOKE_CREATE_LANG=nl-BE      create_booking language for E2E (default nl-BE)
 *   SMOKE_BOOKING_ID=<uuid>      template booking; else latest confirmed
 *   SMOKE_API_BASE=http://...    manage-page HTTP check (default http://127.0.0.1:$PORT)
 *   SMOKE_SKIP_LLM=1             skip live LLM translation check
 *   SMOKE_SKIP_E2E=1             skip create_booking + email_deliveries path
 *
 * E2E caveat: when Google free/busy is unavailable locally, create_booking downgrades to
 * request mode and this script calls sendBookingEmail by hand. That fallback does NOT
 * exercise mirrorCreatedBooking (audienceLanguages → getBookingCopy → sendBookingEmail).
 * See integration/internal-provider-create-email-i18n.test.ts for that wiring.
 */
import 'reflect-metadata';
import crypto from 'crypto';
import { DateTime } from 'luxon';
import { initializeDatabase, AppDataSource } from '../src/database/data-source';
import { initializeRedis, getRedisClient } from '../src/config/redis';
import { Booking } from '../src/database/entities/Booking';
import { ChatSession } from '../src/database/entities/ChatSession';
import { EmailDelivery } from '../src/database/entities/EmailDelivery';
import { ServiceType } from '../src/database/entities/ServiceType';
import { Tenant } from '../src/database/entities/Tenant';
import { logger } from '../src/utils/logger';
import {
  BOOKING_COPY_EN,
  fill,
  formatWhen,
  getBookingCopy,
  __resetBookingCopyCache,
} from '../src/booking/booking-copy';
import { customerLanguageFor, normalizeLanguageCode, resolveOwnerLanguage } from '../src/i18n/audience-language';
import { checkAvailability, createBooking } from '../src/booking/booking.service';
import { BookingError } from '../src/booking/booking-providers/types';
import { sendBookingEmail } from '../src/booking/booking-providers/booking-email';
import { CalendarCredential } from '../src/database/entities/CalendarCredential';
import { BookingReference } from '../src/database/entities/BookingReference';
import { providerFor } from '../src/scheduler/calendar-provider';
import { serviceNeedsCustomerAddress } from '../src/booking/service-location';
import { signBookingToken } from '../src/scheduler/booking-token';
import { getBotConfigForBotId } from '../src/services/bot-config.service';
import { initializeAutomations } from '../src/automations';
import { config } from '../src/config/environment';

const CUSTOMER_LANG = process.env.SMOKE_CUSTOMER_LANG || 'fr';
const CREATE_LANG = process.env.SMOKE_CREATE_LANG || 'nl-BE';
const API_BASE = process.env.SMOKE_API_BASE || `http://127.0.0.1:${config.server.port}`;

function pass(label: string, detail?: string): void {
  console.log(`✓ ${label}${detail ? ` — ${detail}` : ''}`);
}

function fail(label: string, detail?: string): never {
  console.error(`✗ ${label}${detail ? ` — ${detail}` : ''}`);
  process.exit(1);
}

function escHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function bodyContainsPhrase(html: string, phrase: string): boolean {
  return html.includes(phrase) || html.includes(escHtml(phrase));
}

function catalogHash(): string {
  return crypto.createHash('sha256').update(JSON.stringify(BOOKING_COPY_EN)).digest('hex').slice(0, 12);
}

async function assertLuxonFallback(): Promise<void> {
  console.log('\n--- Luxon invalid-locale fallback ---');
  try {
    const weekday = DateTime.now().setLocale('xx').toFormat('cccc');
    pass("setLocale('xx') does not throw", weekday);
  } catch (err) {
    fail("setLocale('xx') threw", err instanceof Error ? err.message : String(err));
  }
  try {
    const when = formatWhen(new Date('2026-06-10T14:00:00Z'), 'Europe/Brussels', 'xx');
    pass("formatWhen(..., 'xx') does not throw", when.slice(0, 48));
  } catch (err) {
    fail("formatWhen(..., 'xx') threw", err instanceof Error ? err.message : String(err));
  }
}

async function assertColumnExists(): Promise<void> {
  const rows: Array<{ column_name: string }> = await AppDataSource.query(
    `SELECT column_name FROM information_schema.columns WHERE table_name = 'chatbot_bookings' AND column_name = 'customer_language'`,
  );
  if (!rows.length) fail('customer_language column missing', 'npm run migration:run');
  pass('customer_language column exists');
}

/**
 * TypeORM synchronize builds chatbot_bookings from the entity, which intentionally
 * does not map `blocked_range` (tstzrange). On every connect synchronize drops the column.
 * Repair it before any availability/create path runs.
 */
async function ensureBlockedRangeColumn(): Promise<void> {
  const rows: Array<{ column_name: string }> = await AppDataSource.query(
    `SELECT column_name FROM information_schema.columns WHERE table_name = 'chatbot_bookings' AND column_name = 'blocked_range'`,
  );
  if (rows.length) return;
  await AppDataSource.query(`ALTER TABLE chatbot_bookings ADD COLUMN blocked_range tstzrange`);
  await AppDataSource.query(
    `UPDATE chatbot_bookings
     SET blocked_range = tstzrange(start_utc, end_utc, '[)')
     WHERE blocked_range IS NULL AND start_utc IS NOT NULL AND end_utc IS NOT NULL`,
  );
  pass('repaired blocked_range column (dropped by DB_SYNCHRONIZE)');
}

async function assertCopyCatalog(): Promise<void> {
  __resetBookingCopyCache();
  const en = await getBookingCopy('en');
  if (en['customer.lead_confirmed'] !== BOOKING_COPY_EN['customer.lead_confirmed']) fail('English copy mismatch');
  pass('getBookingCopy(en) returns catalog without LLM');
  if (process.env.SMOKE_SKIP_LLM === '1') return;
  const translated = await getBookingCopy(CUSTOMER_LANG);
  if (translated === BOOKING_COPY_EN) {
    console.warn(`⚠ getBookingCopy('${CUSTOMER_LANG}') fell back to English`);
  } else {
    pass(`getBookingCopy('${CUSTOMER_LANG}') translated`, translated['customer.lead_confirmed'].slice(0, 60));
  }
}

async function assertRedisCopyCache(lang: string): Promise<void> {
  console.log('\n--- Redis booking-copy cache ---');
  __resetBookingCopyCache();
  const copy = await getBookingCopy(lang);
  const redisKey = `booking-copy:${catalogHash()}:${lang}`;
  const redis = getRedisClient();
  if (!redis) fail('Redis client unavailable — check REDIS_URL in .env.local');
  const cached = await redis.get(redisKey);
  if (!cached) fail('Redis key missing after getBookingCopy', redisKey);
  const parsed = JSON.parse(cached) as Record<string, string>;
  if (parsed['manage.manage_title'] !== copy['manage.manage_title']) {
    fail('Redis cached copy mismatch', parsed['manage.manage_title']);
  }
  pass('Redis booking-copy key populated', redisKey);
}

async function pickTemplateBooking(): Promise<Booking> {
  if (process.env.SMOKE_BOOKING_ID) {
    const row = await AppDataSource.getRepository(Booking).findOne({ where: { id: process.env.SMOKE_BOOKING_ID } });
    if (!row) fail('SMOKE_BOOKING_ID not found');
    return row;
  }
  const row = await AppDataSource.getRepository(Booking).findOne({
    where: { status: 'confirmed' },
    order: { createdAt: 'DESC' },
  });
  if (!row) fail('No confirmed booking — create one via dev bot first');
  return row;
}

async function assertManagePageWithRestore(booking: Booking): Promise<void> {
  console.log('\n--- Manage page (existing booking, restored after) ---');
  const priorLanguage: string | null = booking.customerLanguage ?? null;
  try {
    await AppDataSource.query(`UPDATE chatbot_bookings SET customer_language = $1 WHERE id = $2`, [
      CUSTOMER_LANG,
      booking.id,
    ]);
    booking.customerLanguage = CUSTOMER_LANG;
    pass(`stamped customer_language='${CUSTOMER_LANG}'`, booking.id);

    const bot = await getBotConfigForBotId(booking.botId);
    if (customerLanguageFor(booking, bot.settings) !== CUSTOMER_LANG) fail('customerLanguageFor mismatch');
    pass('customerLanguageFor OK');

    const copy = await getBookingCopy(CUSTOMER_LANG);
    const url = `${API_BASE}/api/v1/bookings/manage?token=${encodeURIComponent(signBookingToken(booking.id))}`;
    try {
      const res = await fetch(url);
      const html = await res.text();
      if (!res.ok) {
        console.warn(`⚠ manage page HTTP ${res.status} — start dev API: cd api && ./scripts/dev-local.sh`);
        return;
      }
      if (!html.includes(`lang="${CUSTOMER_LANG}"`)) fail('manage page missing html lang', url);
      if (!html.includes(copy['manage.manage_title'])) fail('manage page missing localized title');
      pass('manage page HTTP', url);
    } catch {
      console.warn('⚠ manage page HTTP skipped — start: cd api && ./scripts/dev-local.sh');
      console.warn(`  then open: ${url}`);
    }
  } finally {
    await AppDataSource.query(`UPDATE chatbot_bookings SET customer_language = $1 WHERE id = $2`, [
      priorLanguage,
      booking.id,
    ]);
    pass('restored prior customer_language', priorLanguage ?? '(null)');
  }
}

async function findOfferedSlot(
  sessionId: string,
  serviceId: string,
  extras?: { customerAddress?: string; customerPhone?: string; locationChoice?: 'business' | 'customer' },
): Promise<{ start: string; serviceName: string }> {
  for (const dayOffset of [14, 21, 28]) {
    const startDate = DateTime.now().plus({ days: dayOffset }).toISODate()!;
    const endDate = DateTime.now().plus({ days: dayOffset + 1 }).toISODate()!;
    const avail = await checkAvailability(
      'agent',
      sessionId,
      startDate,
      endDate,
      serviceId,
      undefined,
      extras?.customerAddress,
      extras?.locationChoice,
      extras?.customerPhone,
    );
    const slot = avail.slots[0];
    if (slot) {
      return { start: slot.start, serviceName: avail.serviceName ?? 'Smoke service' };
    }
  }
  fail('No offered slot for E2E create — widen horizon or free calendar');
}


async function cleanupCalendarEvent(botId: string, bookingId: string): Promise<void> {
  const ref = await AppDataSource.getRepository(BookingReference).findOne({ where: { bookingId } });
  if (!ref) return;
  try {
    await providerFor(ref.providerType as 'google' | 'microsoft').deleteEvent(
      botId,
      ref.externalEventId,
      ref.externalCalendarId,
    );
    pass('deleted external calendar event', ref.externalEventId);
  } catch (err) {
    console.warn(
      '⚠ calendar event cleanup failed (non-fatal)',
      err instanceof Error ? err.message : String(err),
    );
  }
}

async function cleanupSmokeArtifacts(
  bookingId: string | null,
  sessionId: string | null,
  botId?: string,
): Promise<void> {
  let leadId: string | null = null;
  if (bookingId) {
    if (botId) await cleanupCalendarEvent(botId, bookingId);
    const rows: Array<{ lead_id: string | null }> = await AppDataSource.query(
      `SELECT lead_id FROM chatbot_bookings WHERE id = $1`,
      [bookingId],
    );
    leadId = rows[0]?.lead_id ?? null;
    await AppDataSource.query(`DELETE FROM email_deliveries WHERE related_id = $1`, [bookingId]);
    await AppDataSource.query(`DELETE FROM chatbot_booking_references WHERE booking_id = $1`, [bookingId]);
    await AppDataSource.query(`DELETE FROM chatbot_bookings WHERE id = $1`, [bookingId]);
  }
  if (leadId) {
    await AppDataSource.query(`DELETE FROM chatbot_leads WHERE id = $1`, [leadId]);
  } else if (sessionId) {
    await AppDataSource.query(`DELETE FROM chatbot_leads WHERE session_id = $1`, [sessionId]);
  }
  if (sessionId) {
    await AppDataSource.getRepository(ChatSession).delete({ id: sessionId });
  }
}

async function suspendActiveCalendarCredentials(botId: string): Promise<string[]> {
  const repo = AppDataSource.getRepository(CalendarCredential);
  const active = await repo.find({ where: { botId, status: 'active' } });
  const ids = active.map((row) => row.id);
  if (ids.length) await repo.update(ids, { status: 'revoked' });
  return ids;
}

async function restoreCalendarCredentials(ids: string[]): Promise<void> {
  if (!ids.length) return;
  await AppDataSource.getRepository(CalendarCredential).update(ids, { status: 'active' });
}

function futureStartIso(timezone: string): string {
  return DateTime.now().setZone(timezone).plus({ days: 14 }).set({ hour: 10, minute: 0, second: 0, millisecond: 0 }).toISO({
    suppressMilliseconds: true,
  })!;
}

async function verifyEmailDeliveries(input: {
  bookingId: string;
  attendeeEmail: string;
  ownerEmail: string;
  summary: string;
  normalizedCreateLang: string;
  ownerLang: string;
  tenantId: string;
}): Promise<void> {
  const [customerCopy, ownerCopy] = await Promise.all([
    getBookingCopy(input.normalizedCreateLang, input.tenantId),
    getBookingCopy(input.ownerLang, input.tenantId),
  ]);

  const deliveries = await AppDataSource.getRepository(EmailDelivery).find({
    where: { relatedId: input.bookingId },
    order: { createdAt: 'ASC' },
  });
  if (!deliveries.length) fail('No email_deliveries rows for booking', input.bookingId);

  const customerDelivery = deliveries.find(
    (d) => d.recipientEmail.toLowerCase() === input.attendeeEmail.toLowerCase(),
  );
  if (!customerDelivery) fail('Customer invite missing from email_deliveries');
  const expectedCustomerSubject = fill(customerCopy['customer.subject_confirmed'], { summary: input.summary });
  if (customerDelivery.subject !== expectedCustomerSubject) {
    fail('Customer email subject not localized', customerDelivery.subject);
  }
  const customerBody = customerDelivery.payload?.body ?? '';
  if (!customerBody) fail('Customer email payload.body missing — retainPayload should be true');
  if (!bodyContainsPhrase(customerBody, customerCopy['customer.lead_confirmed'])) {
    fail('Customer email body not localized', customerBody.slice(0, 160));
  }
  pass('Customer invite queued in email_deliveries', expectedCustomerSubject.slice(0, 64));

  const ownerDelivery = deliveries.find((d) => d.recipientEmail.toLowerCase() === input.ownerEmail.toLowerCase());
  if (!ownerDelivery) fail('Owner notification missing from email_deliveries', input.ownerEmail);
  const expectedOwnerSubject = fill(ownerCopy['owner.subject_new'], { summary: input.summary });
  if (ownerDelivery.subject !== expectedOwnerSubject) {
    fail('Owner email subject not in portal locale', ownerDelivery.subject);
  }
  if (
    input.normalizedCreateLang !== input.ownerLang &&
    ownerDelivery.subject === fill(BOOKING_COPY_EN['owner.subject_new'], { summary: input.summary }) &&
    ownerCopy['owner.subject_new'] !== BOOKING_COPY_EN['owner.subject_new']
  ) {
    fail('Owner subject looks English while portal locale differs');
  }
  pass('Owner notification subject in portal locale', expectedOwnerSubject.slice(0, 64));
}

async function assertCreateBookingE2E(template: Booking): Promise<void> {
  if (process.env.SMOKE_SKIP_E2E === '1') {
    console.warn('\n⚠ SMOKE_SKIP_E2E=1 — skipping create_booking path');
    return;
  }

  console.log('\n--- create_booking → customer_language → email_deliveries ---');
  initializeAutomations();

  const normalizedCreateLang = normalizeLanguageCode(CREATE_LANG);
  if (!normalizedCreateLang) fail('SMOKE_CREATE_LANG is not a valid language code', CREATE_LANG);

  const service = await AppDataSource.getRepository(ServiceType).findOne({
    where: { id: template.eventTypeId, botId: template.botId },
  });
  if (!service) fail('Template service not found for E2E', template.eventTypeId);

  const bot = await getBotConfigForBotId(template.botId);
  const ownerLang = await resolveOwnerLanguage(template.tenantId, bot.settings?.ai?.supportEmail);
  const ownerEmail = bot.settings?.ai?.supportEmail?.trim();
  if (!ownerEmail) fail('Bot supportEmail missing — owner notification cannot be verified');

  const session = await AppDataSource.getRepository(ChatSession).save(
    AppDataSource.getRepository(ChatSession).create({
      tenantId: template.tenantId,
      botId: template.botId,
      visitorId: `smoke-i18n-${crypto.randomBytes(6).toString('hex')}`,
      status: 'active',
      source: 'widget',
      channel: 'widget',
      messageCount: 0,
      unreadCount: 0,
      startedAt: new Date(),
      lastActivityAt: new Date(),
    }),
  );

  const needsAddress = serviceNeedsCustomerAddress(service, {
    locationChoice: template.customerAddress ? 'customer' : 'business',
    customerAddress: template.customerAddress ?? undefined,
  });
  const extras: {
    language: string;
    customerAddress?: string;
    customerPhone?: string;
    locationChoice?: 'business' | 'customer';
  } = { language: CREATE_LANG };
  if (needsAddress && template.customerAddress?.trim()) {
    extras.customerAddress = template.customerAddress.trim();
    extras.locationChoice = 'customer';
  }
  if (template.customerPhone?.trim()) extras.customerPhone = template.customerPhone.trim();

  const timezone = bot.businessTimezone || 'Europe/Brussels';
  let createdBookingId: string | null = null;
  const attendeeEmail = `smoke-i18n+${Date.now()}@example.test`;

  const run = async (mode: 'confirmed' | 'request'): Promise<void> => {
    const start =
      mode === 'confirmed'
        ? (await findOfferedSlot(session.id, service.id, extras)).start
        : futureStartIso(timezone);
    const serviceName = service.name;
    const idempotencyKey = `smoke-i18n:${crypto.randomUUID()}`;
    const result = await createBooking(
      'agent',
      session.id,
      idempotencyKey,
      start,
      { name: 'Smoke I18N', email: attendeeEmail },
      'local smoke — booking email language',
      service.id,
      undefined,
      extras,
    );

    if (mode === 'confirmed' && result.requested) {
      fail('create_booking captured a request instead of confirming — calendar/auto-confirm must be healthy for this smoke');
    }
    createdBookingId = result.booking?.id ?? null;
    if (!createdBookingId) fail('create_booking returned no booking id');

    const row = await AppDataSource.getRepository(Booking).findOneByOrFail({ id: createdBookingId });
    if (row.customerLanguage !== normalizedCreateLang) {
      fail('customer_language not stored on INSERT', `expected ${normalizedCreateLang}, got ${row.customerLanguage}`);
    }
    pass('INSERT stored customer_language', normalizedCreateLang);

    if (mode === 'request') {
      pass('create_booking captured request (calendar unavailable locally)');
      await sendBookingEmail({
        botId: template.botId,
        method: 'REQUEST',
        uid: row.icsUid,
        sequence: row.sequence ?? 0,
        start: row.startUtc,
        end: row.endUtc,
        summary: serviceName,
        timezone,
        attendeeName: 'Smoke I18N',
        attendeeEmail,
        tenantId: template.tenantId,
        bookingId: row.id,
        ownerEmail,
        organizerEmail: row.organizerEmail,
        customerLanguage: normalizedCreateLang,
        ownerLanguage: ownerLang,
      });
    }

    await verifyEmailDeliveries({
      bookingId: createdBookingId,
      attendeeEmail,
      ownerEmail,
      summary: result.serviceName ?? serviceName,
      normalizedCreateLang,
      ownerLang,
      tenantId: template.tenantId,
    });
  };

  try {
    try {
      await run('confirmed');
    } catch (err) {
      if (!(err instanceof BookingError) || err.code !== 'BOOKING_TEMPORARILY_UNAVAILABLE') throw err;
      console.warn(
        '⚠ Calendar free/busy unavailable — retrying on request path with hand-built sendBookingEmail (NOT mirrorCreatedBooking)',
      );
      const suspended = await suspendActiveCalendarCredentials(template.botId);
      try {
        await run('request');
      } finally {
        await restoreCalendarCredentials(suspended);
      }
    }
  } finally {
    await cleanupSmokeArtifacts(createdBookingId, session.id, template.botId);
    if (createdBookingId) pass('cleaned up throwaway booking, deliveries, lead, session', createdBookingId);
  }
}

async function main(): Promise<void> {
  console.log('\n=== Booking email language — local smoke ===\n');
  await initializeDatabase();
  await ensureBlockedRangeColumn();
  await assertLuxonFallback();
  await initializeRedis();
  await assertColumnExists();
  await assertCopyCatalog();
  await assertRedisCopyCache(CUSTOMER_LANG);

  const template = await pickTemplateBooking();
  await assertManagePageWithRestore(template);
  await assertCreateBookingE2E(template);

  const tenant = await AppDataSource.getRepository(Tenant).findOne({ where: { id: template.tenantId } });
  console.log(`\nDone. tenant=${tenant?.name ?? template.tenantId} template=${template.id}\n`);
}

main()
  .then(async () => {
    // Postgres and Redis handles keep the event loop alive; close them so the
    // script exits instead of hanging after the summary.
    await AppDataSource.destroy().catch(() => undefined);
    getRedisClient()?.disconnect();
    process.exit(0);
  })
  .catch(async (err) => {
    logger.error('[smoke-booking-email-language] failed', { err });
    await AppDataSource.destroy().catch(() => undefined);
    getRedisClient()?.disconnect();
    process.exit(1);
  });
