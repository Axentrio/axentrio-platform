/**
 * Backfill of `chatbot_bookings.lead_id`.
 *
 * The interesting behaviour is what it REFUSES to do. Attaching a real appointment to
 * the wrong person is worse than leaving the column blank, so a session that resolves to
 * more than one lead is skipped rather than guessed at.
 */
import { describe, it, expect } from 'vitest';
import { AppDataSource } from '../../database/data-source';
import { Lead } from '../../database/entities/Lead';
import { Booking } from '../../database/entities/Booking';
import { BackfillBookingLeadIds1788000000000 } from '../../database/migrations/1788000000000-BackfillBookingLeadIds';
import { createTestTenant, createTestAnchorBot, createTestSession } from '../helpers/factories';
import type { Tenant } from '../../database/entities/Tenant';

const uniq = () => Math.random().toString(36).slice(2, 10);

async function seedLead(tenantId: string, sessionId: string | null) {
  const repo = AppDataSource.getRepository(Lead);
  const s = uniq();
  return repo.save(
    repo.create({
      tenantId,
      sessionId,
      email: `bf${s}@example.com`,
      dedupeKey: `email:bf${s}@example.com`,
      source: 'tool',
    }),
  );
}

async function seedBooking(tenantId: string, botId: string, sessionId: string | null) {
  const repo = AppDataSource.getRepository(Booking);
  return repo.save(
    repo.create({
      tenantId,
      botId,
      sessionId,
      // Deliberately NOT set — this is the pre-migration state.
      leadId: null,
      status: 'confirmed',
      startUtc: new Date(),
      endUtc: new Date(Date.now() + 3600_000),
      calendarKey: 'cal',
      icsUid: `ics-${uniq()}`,
    }),
  );
}

async function leadIdOf(bookingId: string): Promise<string | null> {
  const [row] = await AppDataSource.query(`SELECT lead_id FROM chatbot_bookings WHERE id = $1`, [bookingId]);
  return row?.lead_id ?? null;
}

async function runBackfill() {
  const m = new BackfillBookingLeadIds1788000000000();
  const qr = AppDataSource.createQueryRunner();
  try {
    await qr.connect();
    await m.up(qr);
  } finally {
    await qr.release();
  }
}

describe('BackfillBookingLeadIds', () => {
  it('links a booking to the lead captured in the SAME conversation', async () => {
    const tenant = await createTestTenant({ tier: 'pro' });
    const bot = await createTestAnchorBot(tenant as Tenant);
    const session = await createTestSession(tenant.id, { botId: bot.id });
    const lead = await seedLead(tenant.id, session.id);
    const booking = await seedBooking(tenant.id, bot.id, session.id);

    expect(await leadIdOf(booking.id)).toBeNull(); // pre-migration state
    await runBackfill();
    expect(await leadIdOf(booking.id)).toBe(lead.id);
  });

  it('SKIPS a session that resolves to more than one lead rather than guessing', async () => {
    // A visitor who gives two different emails in one chat produces two identity rows.
    // Picking one arbitrarily would put a real appointment against the wrong person.
    const tenant = await createTestTenant({ tier: 'pro' });
    const bot = await createTestAnchorBot(tenant as Tenant);
    const session = await createTestSession(tenant.id, { botId: bot.id });
    await seedLead(tenant.id, session.id);
    await seedLead(tenant.id, session.id);
    const booking = await seedBooking(tenant.id, bot.id, session.id);

    await runBackfill();
    // Still blank — the same as before the migration, which is the safe outcome.
    expect(await leadIdOf(booking.id)).toBeNull();
  });

  it('ignores an ERASED lead when resolving the session', async () => {
    // A soft-deleted lead must not be resurrected as a booking's owner.
    const tenant = await createTestTenant({ tier: 'pro' });
    const bot = await createTestAnchorBot(tenant as Tenant);
    const session = await createTestSession(tenant.id, { botId: bot.id });
    const erased = await seedLead(tenant.id, session.id);
    await AppDataSource.query(`UPDATE chatbot_leads SET deleted_at = now() WHERE id = $1`, [erased.id]);
    const live = await seedLead(tenant.id, session.id);
    const booking = await seedBooking(tenant.id, bot.id, session.id);

    await runBackfill();
    // The erased one is invisible, so the session is UNambiguous and links to the live one.
    expect(await leadIdOf(booking.id)).toBe(live.id);
  });

  it('never overwrites a lead_id the booking hook already set', async () => {
    const tenant = await createTestTenant({ tier: 'pro' });
    const bot = await createTestAnchorBot(tenant as Tenant);
    const session = await createTestSession(tenant.id, { botId: bot.id });
    await seedLead(tenant.id, session.id);
    const other = await seedLead(tenant.id, null);

    const repo = AppDataSource.getRepository(Booking);
    const booking = await repo.save(
      repo.create({
        tenantId: tenant.id, botId: bot.id, sessionId: session.id,
        leadId: other.id, // already linked
        status: 'confirmed', startUtc: new Date(), endUtc: new Date(Date.now() + 3600_000),
        calendarKey: 'cal', icsUid: `ics-${uniq()}`,
      }),
    );

    await runBackfill();
    expect(await leadIdOf(booking.id)).toBe(other.id); // untouched
  });

  it('does not cross tenants', async () => {
    const a = await createTestTenant({ tier: 'pro' });
    const b = await createTestTenant({ tier: 'pro' });
    const botA = await createTestAnchorBot(a as Tenant);
    const botB = await createTestAnchorBot(b as Tenant);
    const session = await createTestSession(a.id, { botId: botA.id });
    await seedLead(a.id, session.id);
    // Tenant B booking that (pathologically) references tenant A's session id.
    const booking = await seedBooking(b.id, botB.id, session.id);

    await runBackfill();
    expect(await leadIdOf(booking.id)).toBeNull();
  });

  it('is idempotent', async () => {
    const tenant = await createTestTenant({ tier: 'pro' });
    const bot = await createTestAnchorBot(tenant as Tenant);
    const session = await createTestSession(tenant.id, { botId: bot.id });
    const lead = await seedLead(tenant.id, session.id);
    const booking = await seedBooking(tenant.id, bot.id, session.id);

    await runBackfill();
    await runBackfill();
    expect(await leadIdOf(booking.id)).toBe(lead.id);
  });
});
