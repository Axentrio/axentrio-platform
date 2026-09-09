/**
 * Single-subject export (GDPR Art 15), against a real DB.
 *
 * The cases are about COMPLETENESS and BOUNDARIES: one human owns several lead
 * rows, and an export that returns one row answers half the request; an export
 * that returns a neighbour's messages answers a different person's request.
 */
import { describe, it, expect } from 'vitest';
import { AppDataSource } from '../../database/data-source';
import { Lead } from '../../database/entities/Lead';
import { exportSubject } from '../../leads/subject-export.service';
import { encrypt } from '../../utils/encryption';
import {
  createTestMessage,
  createTestParticipant,
  createTestSession,
  createTestTenant,
  createTestAnchorBot,
} from '../helpers/factories';

async function seedLead(tenantId: string, over: Partial<Lead> = {}) {
  const repo = AppDataSource.getRepository(Lead);
  const stamp = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
  return repo.save(
    repo.create({
      tenantId,
      name: 'Achraf Peeters',
      email: `s${stamp}@example.com`,
      phone: '32475464421',
      dedupeKey: `email:s${stamp}@example.com`,
      personKey: `email:s${stamp}@example.com`,
      source: 'channel',
      ...over,
    }),
  );
}

describe('exportSubject', () => {
  it('gathers every holder for the person, decrypted', async () => {
    const tenant = await createTestTenant({ tier: 'pro' });
    const bot = await createTestAnchorBot(tenant);
    const session = await createTestSession(tenant.id, { botId: bot.id });
    const lead = await seedLead(tenant.id, { sessionId: session.id });
    const visitor = await createTestParticipant(session.id, { type: 'user', name: 'Achraf' });
    await createTestMessage(session.id, tenant.id, visitor.id, { content: 'plain hello' });
    const encrypted = await createTestMessage(session.id, tenant.id, visitor.id, {
      content: encrypt('secret hello'),
    });
    await AppDataSource.query(
      `UPDATE messages SET content_encrypted = true WHERE id = $1`,
      [encrypted.id],
    );
    await AppDataSource.query(
      `INSERT INTO chatbot_bookings
         (tenant_id, bot_id, lead_id, session_id, start_utc, end_utc, calendar_key, ics_uid, attendee_email)
       VALUES ($1, $2, $3, $4, now() + interval '1 day', now() + interval '1 day 1 hour', 'cal', 'ics-x', $5)`,
      [tenant.id, bot.id, lead.id, session.id, lead.email],
    );

    const bundle = await exportSubject(AppDataSource, tenant.id, lead.id);

    expect(bundle).not.toBeNull();
    expect((bundle!.leads as Array<{ id: string }>).map((l) => l.id)).toContain(lead.id);
    expect((bundle!.sessions as Array<{ id: string }>).map((s) => s.id)).toContain(session.id);
    expect(bundle!.participants).toHaveLength(1);
    expect(bundle!.messages).toHaveLength(2);
    // The encrypted row is returned as text, not ciphertext.
    expect(bundle!.messages.map((m) => m.content).sort()).toEqual(['plain hello', 'secret hello']);
    expect(bundle!.bookings).toHaveLength(1);
  });

  it('follows person_key, so the other channel row is included', async () => {
    const tenant = await createTestTenant({ tier: 'pro' });
    await createTestAnchorBot(tenant);
    const personKey = `phone:32475464421-${Date.now()}`;
    const onWhatsapp = await seedLead(tenant.id, { personKey, channel: 'whatsapp' });
    const onWidget = await seedLead(tenant.id, { personKey, channel: 'widget' });

    const bundle = await exportSubject(AppDataSource, tenant.id, onWhatsapp.id);

    const ids = (bundle!.leads as Array<{ id: string }>).map((l) => l.id);
    expect(ids).toContain(onWhatsapp.id);
    expect(ids).toContain(onWidget.id);
  });

  it("does not return another person's messages", async () => {
    const tenant = await createTestTenant({ tier: 'pro' });
    await createTestAnchorBot(tenant);
    const mine = await createTestSession(tenant.id);
    const theirs = await createTestSession(tenant.id);
    const lead = await seedLead(tenant.id, { sessionId: mine.id });
    const myVisitor = await createTestParticipant(mine.id, { type: 'user' });
    const theirVisitor = await createTestParticipant(theirs.id, { type: 'user' });
    await createTestMessage(mine.id, tenant.id, myVisitor.id, { content: 'mine' });
    await createTestMessage(theirs.id, tenant.id, theirVisitor.id, { content: 'theirs' });

    const bundle = await exportSubject(AppDataSource, tenant.id, lead.id);

    expect(bundle!.messages.map((m) => m.content)).toEqual(['mine']);
  });

  it('is tenant-scoped and returns null for an unknown lead', async () => {
    const owner = await createTestTenant({ tier: 'pro' });
    const other = await createTestTenant({ tier: 'pro' });
    const lead = await seedLead(owner.id);

    expect(await exportSubject(AppDataSource, other.id, lead.id)).toBeNull();
    expect(
      await exportSubject(AppDataSource, owner.id, '00000000-0000-4000-8000-000000000000'),
    ).toBeNull();
  });
});
