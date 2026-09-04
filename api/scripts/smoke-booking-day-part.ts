/**
 * Local smoke test for day-part availability filtering.
 *
 * Usage:
 *   cd api && npm run smoke:day-part
 *
 * Env:
 *   SMOKE_BOOKING_ID=<uuid>   template booking; else latest confirmed
 *   SMOKE_SKIP_E2E=1          skip live checkAvailability against the diary
 */
import 'reflect-metadata';
import { DateTime } from 'luxon';
import { initializeDatabase, AppDataSource } from '../src/database/data-source';
import { initializeRedis, getRedisClient } from '../src/config/redis';
import { Booking } from '../src/database/entities/Booking';
import { ChatSession } from '../src/database/entities/ChatSession';
import { logger } from '../src/utils/logger';
import { dayPartWindow, inferDayPartWindow } from '../src/agent/day-part';
import { checkAvailability } from '../src/booking/booking.service';

function pass(label: string, detail?: string): void {
  console.log(`✓ ${label}${detail ? ` — ${detail}` : ''}`);
}

function fail(label: string, detail?: string): never {
  console.error(`✗ ${label}${detail ? ` — ${detail}` : ''}`);
  process.exit(1);
}

function assertDayPartUnit(): void {
  console.log('\n--- day-part vocabulary ---');
  const afternoon = dayPartWindow('ergens in de namiddag');
  if (!afternoon || afternoon.from !== '12:00' || afternoon.to !== '18:00') {
    fail('dayPartWindow("ergens in de namiddag")', JSON.stringify(afternoon));
  }
  pass('dayPartWindow("ergens in de namiddag")', '12:00–18:00');

  const inferred = inferDayPartWindow([
    'Passtraat 248B, 9100 Sint-Niklaas',
    'maandag, ergens in de namiddag',
  ]);
  if (!inferred || inferred.from !== '12:00' || inferred.to !== '18:00') {
    fail('inferDayPartWindow after address retry', JSON.stringify(inferred));
  }
  pass('inferDayPartWindow keeps afternoon across address retry');
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
  if (!rows[0]) fail('No confirmed booking in DB — create one or set SMOKE_BOOKING_ID');
  return rows[0];
}

function slotLocalHour(iso: string, timezone: string): number {
  return DateTime.fromISO(iso, { zone: timezone }).hour;
}

async function assertAvailabilityE2E(template: Booking): Promise<void> {
  if (process.env.SMOKE_SKIP_E2E === '1') {
    console.warn('\n⚠ SMOKE_SKIP_E2E=1 — skipping checkAvailability path');
    return;
  }

  console.log('\n--- checkAvailability day-part ---');
  const session = await AppDataSource.getRepository(ChatSession).findOne({
    where: { id: template.sessionId },
  });
  if (!session) fail('Template session missing', template.sessionId);

  const timezone = 'Europe/Brussels';
  let openDay: string | null = null;

  for (const offset of [7, 8, 9, 10, 11, 12, 13, 14]) {
    const day = DateTime.now().setZone(timezone).plus({ days: offset }).toISODate()!;
    const end = DateTime.fromISO(day, { zone: timezone }).plus({ days: 1 }).toISODate()!;
    const result = await checkAvailability(
      'agent',
      session.id,
      day,
      end,
      template.eventTypeId,
    );
    if (result.slots.some((s) => slotLocalHour(s.start, timezone) < 12)) {
      openDay = day;
      break;
    }
  }

  if (!openDay) {
    console.warn('⚠ No morning slot found in horizon — skipping morning-first assertion');
    openDay = DateTime.now().setZone(timezone).plus({ days: 14 }).toISODate()!;
  } else {
    pass('Unfiltered day offers at least one morning slot', openDay);
  }

  const afternoonWindow = { from: '12:00', to: '18:00' };
  const end = DateTime.fromISO(openDay, { zone: timezone }).plus({ days: 1 }).toISODate()!;
  const filtered = await checkAvailability(
    'agent',
    session.id,
    openDay,
    end,
    template.eventTypeId,
    undefined,
    undefined,
    undefined,
    undefined,
    afternoonWindow,
  );

  if (filtered.clockWindow?.matched === false) {
    pass('Afternoon window unmatched — no chips expected', filtered.clockWindow.from);
    return;
  }

  if (!filtered.slots.length) {
    pass('Afternoon window returned zero slots (treated as unmatched behaviour)');
    return;
  }

  const bad = filtered.slots.find((s) => {
    const dt = DateTime.fromISO(s.start, { zone: timezone });
    const mins = dt.hour * 60 + dt.minute;
    return mins < 12 * 60 || mins >= 18 * 60;
  });
  if (bad) fail('Afternoon-filtered slot outside 12:00–18:00', bad.start);
  pass('Afternoon-filtered slots stay inside 12:00–18:00', `${filtered.slots.length} slot(s)`);
}

async function main(): Promise<void> {
  console.log('\n=== Booking day-part — local smoke ===\n');
  assertDayPartUnit();
  await initializeDatabase();
  await initializeRedis();
  const template = await pickTemplateBooking();
  await assertAvailabilityE2E(template);
  console.log(`\nDone. template booking=${template.id}\n`);
}

main()
  .then(async () => {
    await AppDataSource.destroy().catch(() => undefined);
    getRedisClient()?.disconnect();
    process.exit(0);
  })
  .catch(async (err) => {
    logger.error('[smoke-booking-day-part] failed', { err });
    await AppDataSource.destroy().catch(() => undefined);
    getRedisClient()?.disconnect();
    process.exit(1);
  });
