/**
 * Local smoke test for global booking-confirmation email extras.
 *
 * Usage:
 *   cd api && npm run smoke:confirmation-extras
 *
 * Env:
 *   SMOKE_BOOKING_ID=<uuid>      template booking; else latest confirmed
 *   SMOKE_SKIP_E2E=1             skip DB + email_deliveries path
 */
import 'reflect-metadata';
import crypto from 'crypto';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { initializeDatabase, AppDataSource } from '../src/database/data-source';
import { initializeRedis, getRedisClient } from '../src/config/redis';
import { Booking } from '../src/database/entities/Booking';
import { EmailDelivery } from '../src/database/entities/EmailDelivery';
import { logger } from '../src/utils/logger';
import { sendBookingEmail } from '../src/booking/booking-providers/booking-email';
import { createS3Client } from '../src/file-handling/s3-client';
import { resolveOwnerLanguage } from '../src/i18n/audience-language';
import { getBotConfigForBotId } from '../src/services/bot-config.service';

const INFO_TEXT = 'Smoke: arrive 10 minutes early. Parking behind the building.';
const PDF_NAME = 'smoke-info.pdf';

function pass(label: string, detail?: string): void {
  console.log(`✓ ${label}${detail ? ` — ${detail}` : ''}`);
}

function fail(label: string, detail?: string): never {
  console.error(`✗ ${label}${detail ? ` — ${detail}` : ''}`);
  process.exit(1);
}

async function pickTemplateBooking(): Promise<Booking> {
  const id = process.env.SMOKE_BOOKING_ID?.trim();
  if (id) {
    const row = await AppDataSource.getRepository(Booking).findOne({ where: { id } });
    if (!row) fail('SMOKE_BOOKING_ID not found', id);
    return row;
  }
  const rows = await AppDataSource.getRepository(Booking).find({
    where: { status: 'confirmed' as const },
    order: { createdAt: 'DESC' },
    take: 1,
  });
  if (!rows[0]) fail('No confirmed booking in DB');
  return rows[0];
}

async function main(): Promise<void> {
  console.log('\n=== Booking confirmation extras — local smoke ===\n');
  if (process.env.SMOKE_SKIP_E2E === '1') {
    console.warn('⚠ SMOKE_SKIP_E2E=1 — nothing to run');
    return;
  }

  await initializeDatabase();
  await initializeRedis();

  const template = await pickTemplateBooking();
  const bot = await getBotConfigForBotId(template.botId);
  const ownerLang = await resolveOwnerLanguage(template.tenantId, bot.settings?.ai?.supportEmail);
  const ownerEmail = bot.settings?.ai?.supportEmail?.trim();
  const attendeeEmail = template.attendeeEmail?.trim();
  if (!ownerEmail) fail('Bot supportEmail missing');
  if (!attendeeEmail) fail('Template booking has no attendee email');

  const prior = await AppDataSource.query(
    `SELECT confirmation_extra_info, confirmation_attachments FROM chatbot_booking_settings WHERE bot_id = $1`,
    [template.botId],
  );
  const priorInfo = prior[0]?.confirmation_extra_info ?? null;
  const priorAttachments = prior[0]?.confirmation_attachments ?? [];

  const attId = crypto.randomUUID();
  const fileKey = `booking-confirmation/${template.tenantId}/${template.botId}/${attId}/${PDF_NAME}`;
  const pdfBytes = Buffer.from('%PDF-1.4 smoke confirmation extras\n');

  await createS3Client().send(
    new PutObjectCommand({
      Bucket: process.env.AWS_S3_BUCKET,
      Key: fileKey,
      Body: pdfBytes,
      ContentType: 'application/pdf',
    }),
  );

  const attachmentEntry = {
    id: attId,
    fileName: PDF_NAME,
    mimeType: 'application/pdf',
    fileSize: pdfBytes.length,
    fileKey,
    uploadedAt: new Date().toISOString(),
  };

  await AppDataSource.query(
    `INSERT INTO chatbot_booking_settings (tenant_id, bot_id, confirmation_extra_info, confirmation_attachments)
     VALUES ($1, $2, $3, $4::jsonb)
     ON CONFLICT (bot_id) DO UPDATE SET
       confirmation_extra_info = EXCLUDED.confirmation_extra_info,
       confirmation_attachments = EXCLUDED.confirmation_attachments`,
    [template.tenantId, template.botId, INFO_TEXT, JSON.stringify([attachmentEntry])],
  );
  pass('Stored confirmation extras on booking settings');

  await sendBookingEmail({
    botId: template.botId,
    method: 'REQUEST',
    uid: template.icsUid,
    sequence: (template.sequence ?? 0) + 1,
    start: template.startUtc,
    end: template.endUtc,
    summary: 'Smoke confirmation extras',
    timezone: 'Europe/Brussels',
    attendeeName: template.attendeeName ?? 'Smoke',
    attendeeEmail,
    tenantId: template.tenantId,
    bookingId: template.id,
    ownerEmail,
    organizerEmail: template.organizerEmail,
    customerLanguage: template.customerLanguage ?? 'en',
    ownerLanguage: ownerLang,
  });

  const deliveries = await AppDataSource.getRepository(EmailDelivery).find({
    where: { relatedId: template.id },
    order: { createdAt: 'DESC' },
    take: 5,
  });
  const customer = deliveries.find((d) => d.recipientEmail.toLowerCase() === attendeeEmail.toLowerCase());
  if (!customer?.payload?.body?.includes(INFO_TEXT)) {
    fail('Customer email body missing information text');
  }
  pass('Customer email body contains information text');

  const names = (customer?.payload?.attachments ?? []).map((a: { filename?: string }) => a.filename);
  if (!names.includes('invite.ics')) fail('Customer email missing invite.ics');
  if (!names.includes(PDF_NAME)) fail('Customer email missing configured PDF', names.join(', '));
  pass('Customer email attachments include ICS and PDF');

  await AppDataSource.query(
    `UPDATE chatbot_booking_settings SET confirmation_extra_info = $2, confirmation_attachments = $3::jsonb WHERE bot_id = $1`,
    [template.botId, priorInfo, JSON.stringify(priorAttachments)],
  );
  pass('Restored prior booking settings');

  console.log(`\nDone. template=${template.id}\n`);
}

main()
  .then(async () => {
    await AppDataSource.destroy().catch(() => undefined);
    getRedisClient()?.disconnect();
    process.exit(0);
  })
  .catch(async (err) => {
    logger.error('[smoke-booking-confirmation-extras] failed', { err });
    await AppDataSource.destroy().catch(() => undefined);
    getRedisClient()?.disconnect();
    process.exit(1);
  });
