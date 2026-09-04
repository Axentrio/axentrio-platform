/**
 * Prod-safe smoke: create booking → post-confirm notes + file → verify Google
 * calendar body updates via updateBooking → refreshCalendarMirror (items 4 & 6).
 *
 * Usage:
 *   cd api && PROD_SSH_HOST=deploy@<prod-ip> scripts/prod-env.sh npx tsx scripts/smoke-calendar-mirror-update.ts
 */
import 'reflect-metadata';
import crypto from 'crypto';
import axios from 'axios';
import { DateTime } from 'luxon';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { initializeDatabase, AppDataSource } from '../src/database/data-source';
import { initializeRedis, getRedisClient } from '../src/config/redis';
import { Booking } from '../src/database/entities/Booking';
import { BookingReference } from '../src/database/entities/BookingReference';
import { ChatSession } from '../src/database/entities/ChatSession';
import { ServiceType } from '../src/database/entities/ServiceType';
import { UploadSession } from '../src/database/entities/UploadSession';
import { CalendarCredential } from '../src/database/entities/CalendarCredential';
import { logger } from '../src/utils/logger';
import { checkAvailability, createBooking, updateBooking } from '../src/booking/booking.service';
import { BookingError } from '../src/booking/booking-providers/types';
import { providerFor } from '../src/scheduler/calendar-provider';
import { getValidAccessToken } from '../src/integrations/google/google-calendar.service';
import { createS3Client } from '../src/config/s3.config';
import { serviceNeedsCustomerAddress } from '../src/booking/service-location';

const DEFAULT_BOT_ID = '48bbac99-f550-462a-80e0-b2fd90062c95';
const SMOKE_FILE = 'smoke-mirror-update.jpeg';

function pass(label: string, detail?: string): void {
  console.log(`✓ ${label}${detail ? ` — ${detail}` : ''}`);
}

function fail(label: string, detail?: string): never {
  console.error(`✗ ${label}${detail ? ` — ${detail}` : ''}`);
  process.exit(1);
}

function googleEventId(bookingId: string): string {
  return bookingId.replace(/-/g, '');
}

async function findOfferedSlot(
  sessionId: string,
  serviceId: string,
  extras?: { customerAddress?: string; customerPhone?: string; locationChoice?: 'business' | 'customer' },
): Promise<string> {
  for (const dayOffset of [14, 21, 28, 35]) {
    const startDate = DateTime.now().plus({ days: dayOffset }).toISODate()!;
    const endDate = DateTime.now().plus({ days: dayOffset + 3 }).toISODate()!;
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
    if (avail.slots[0]?.start) return avail.slots[0].start;
  }
  fail('No offered slot — free calendar or widen horizon');
}

async function fetchGoogleEvent(
  botId: string,
  calendarId: string,
  eventId: string,
): Promise<{ description: string; summary: string; htmlLink?: string }> {
  const cred = await AppDataSource.getRepository(CalendarCredential).findOne({
    where: { botId, provider: 'google', status: 'active' },
  });
  if (!cred) fail('No active Google calendar credential for bot', botId);
  const token = await getValidAccessToken(cred);
  const { data } = await axios.get(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
    { headers: { Authorization: `Bearer ${token}` }, timeout: 20000 },
  );
  return {
    description: data.description ?? '',
    summary: data.summary ?? '',
    htmlLink: data.htmlLink,
  };
}

async function seedReadyUpload(
  tenantId: string,
  chatSessionId: string,
  visitorId: string,
): Promise<string> {
  const sessionId = crypto.randomUUID();
  const fileKey = `uploads/${tenantId}/${DateTime.now().toFormat('yyyy/MM/dd')}/${sessionId}-${SMOKE_FILE}`;
  const jpegBytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);
  await createS3Client().send(
    new PutObjectCommand({
      Bucket: process.env.AWS_S3_BUCKET,
      Key: fileKey,
      Body: jpegBytes,
      ContentType: 'image/jpeg',
    }),
  );
  const expiresAt = DateTime.now().plus({ days: 7 }).toJSDate();
  await AppDataSource.getRepository(UploadSession).save(
    AppDataSource.getRepository(UploadSession).create({
      sessionId,
      tenantId,
      chatSessionId,
      userId: visitorId,
      fileKey,
      fileHash: crypto.createHash('sha256').update(jpegBytes).digest('hex'),
      originalName: SMOKE_FILE,
      fileSize: jpegBytes.length,
      mimeType: 'image/jpeg',
      uploadUrl: `https://smoke.local/${sessionId}`,
      publicUrl: `https://smoke.local/public/${sessionId}`,
      status: 'ready',
      scanResult: { clean: true, scannedAt: new Date().toISOString() },
      expiresAt,
    }),
  );
  pass('seeded ready upload session', sessionId);
  return sessionId;
}

async function cleanup(
  bookingId: string | null,
  sessionId: string | null,
  botId: string,
  uploadSessionId: string | null,
): Promise<void> {
  if (process.env.SMOKE_SKIP_CLEANUP === '1') {
    console.warn('⚠ SMOKE_SKIP_CLEANUP=1 — leaving artifacts', { bookingId, sessionId });
    return;
  }
  if (bookingId) {
    const ref = await AppDataSource.getRepository(BookingReference).findOne({ where: { bookingId } });
    if (ref) {
      try {
        await providerFor(ref.providerType as 'google' | 'microsoft').deleteEvent(
          botId,
          ref.externalEventId,
          ref.externalCalendarId,
        );
        pass('deleted Google event', ref.externalEventId);
      } catch (err) {
        console.warn('⚠ calendar delete failed', err instanceof Error ? err.message : String(err));
      }
    }
    await AppDataSource.query(`DELETE FROM email_deliveries WHERE related_id = $1`, [bookingId]);
    await AppDataSource.query(`DELETE FROM chatbot_booking_references WHERE booking_id = $1`, [bookingId]);
    await AppDataSource.query(`DELETE FROM chatbot_bookings WHERE id = $1`, [bookingId]);
  }
  if (uploadSessionId) {
    await AppDataSource.getRepository(UploadSession).delete({ sessionId: uploadSessionId });
  }
  if (sessionId) {
    await AppDataSource.getRepository(ChatSession).delete({ id: sessionId });
  }
}

async function main(): Promise<void> {
  console.log('\n=== Calendar mirror update smoke (create → update → read Google) ===\n');
  await initializeDatabase();
  await initializeRedis();

  const botId = process.env.SMOKE_BOT_ID?.trim() || DEFAULT_BOT_ID;
  const template = await AppDataSource.getRepository(Booking).findOne({
    where: { botId, status: 'confirmed' },
    order: { createdAt: 'DESC' },
  });
  if (!template?.eventTypeId) fail('No confirmed booking template for bot', botId);

  const service = await AppDataSource.getRepository(ServiceType).findOne({
    where: { id: template.eventTypeId, botId },
  });
  if (!service) fail('Service not found', template.eventTypeId);

  const cred = await AppDataSource.getRepository(CalendarCredential).findOne({
    where: { botId, provider: 'google', status: 'active' },
  });
  if (!cred) fail('No active Google calendar for bot', botId);
  pass('calendar account', cred.accountEmail ?? cred.calendarId);

  const stamp = Date.now();
  const attendeeEmail = `smoke-mirror+${stamp}@example.test`;
  const noteNeedle = `SMOKE-MIRROR-UPDATE-${stamp} achter poort, leidingen onder wastafel`;
  const session = await AppDataSource.getRepository(ChatSession).save(
    AppDataSource.getRepository(ChatSession).create({
      tenantId: template.tenantId,
      botId,
      visitorId: `smoke-mirror-${crypto.randomBytes(6).toString('hex')}`,
      status: 'active',
      source: 'widget',
      channel: 'widget',
      messageCount: 0,
      unreadCount: 0,
      startedAt: new Date(),
      lastActivityAt: new Date(),
    }),
  );

  const extras: {
    customerAddress?: string;
    customerPhone?: string;
    locationChoice?: 'business' | 'customer';
  } = {};
  if (
    serviceNeedsCustomerAddress(service, {
      locationChoice: template.customerAddress ? 'customer' : 'business',
      customerAddress: template.customerAddress ?? undefined,
    }) &&
    template.customerAddress?.trim()
  ) {
    extras.customerAddress = template.customerAddress.trim();
    extras.locationChoice = 'customer';
  }
  if (template.customerPhone?.trim()) extras.customerPhone = template.customerPhone.trim();

  let bookingId: string | null = null;
  let uploadSessionId: string | null = null;

  try {
    const start = await findOfferedSlot(session.id, service.id, extras);
    pass('offered slot', start);

    const created = await createBooking(
      'agent',
      session.id,
      `smoke-mirror:${crypto.randomUUID()}`,
      start,
      { name: 'Smoke Mirror', email: attendeeEmail },
      undefined,
      service.id,
      undefined,
      extras,
    );
    if (created.requested) fail('Expected confirmed booking, got request');
    bookingId = created.booking?.id ?? null;
    if (!bookingId) fail('createBooking returned no id');

    const ref = await AppDataSource.getRepository(BookingReference).findOne({ where: { bookingId } });
    if (!ref) fail('No BookingReference after create — calendar mirror create failed');
    pass('BookingReference', `${ref.externalCalendarId}/${ref.externalEventId}`);

    const eventId = ref.externalEventId || googleEventId(bookingId);
    const before = await fetchGoogleEvent(botId, ref.externalCalendarId, eventId);
    pass('Google event readable (before update)', before.summary.slice(0, 60));
    if (!before.description.includes(attendeeEmail)) {
      fail('Before update: attendee email missing from description', before.description.slice(0, 400));
    }
    if (before.description.includes(noteNeedle)) fail('Before update: smoke notes already present');
    if (before.description.includes(SMOKE_FILE)) fail('Before update: smoke file already present');
    pass('baseline: email present, notes/file absent');

    uploadSessionId = await seedReadyUpload(template.tenantId, session.id, session.visitorId);

    const updated = await updateBooking('agent', session.id, {
      bookingId,
      notes: noteNeedle,
    });
    if (!updated.success) fail('updateBooking failed');
    pass('updateBooking', `files=${updated.booking.uploadedFileCount ?? 0}`);

    await new Promise((r) => setTimeout(r, 4000));

    const after = await fetchGoogleEvent(botId, ref.externalCalendarId, eventId);
    console.log('\n--- Google description (after update) ---\n');
    console.log(after.description);
    console.log('\n--- end ---\n');

    if (!after.description.toLowerCase().includes(attendeeEmail.toLowerCase())) {
      fail('After update: email missing', after.description.slice(0, 500));
    }
    if (!after.description.includes(noteNeedle)) {
      fail('After update: notes missing', after.description.slice(0, 500));
    }
    if (!after.description.includes(SMOKE_FILE)) {
      fail('After update: file ref missing', after.description.slice(0, 500));
    }

    pass('After update: email line present');
    pass('After update: post-confirm notes mirrored');
    pass('After update: uploaded file name mirrored');
    pass('calendar mirror update path verified', bookingId);
  } finally {
    await cleanup(bookingId, session.id, botId, uploadSessionId);
    if (bookingId && process.env.SMOKE_SKIP_CLEANUP !== '1') {
      pass('cleaned up smoke booking + session + upload', bookingId);
    }
  }
}

main()
  .then(async () => {
    await AppDataSource.destroy().catch(() => undefined);
    getRedisClient()?.disconnect();

[Showing lines 1-300 of 313. Use :301 to continue]