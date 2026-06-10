/**
 * DB-backed integration test for the real `INSERT … ON CONFLICT` upsert in
 * lead-capture.service. Unit mocks can't exercise the partial-index conflict
 * target or the COALESCE/source-rank UPDATE — and that exact blind spot is why
 * the old silent email upsert went unnoticed. This hits a real Postgres.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// Keep the test about the upsert: stub the fire-and-forget fan-out.
vi.mock('../../webhooks/webhook.emitter', () => ({
  emitWebhookEvent: vi.fn(),
  buildEventBase: () => ({ id: 'e', tenantId: 't', sessionId: 's', timestamp: 'now', session: {} }),
}));
vi.mock('../../services/notification.service', () => ({
  notificationService: { createForTenant: vi.fn().mockResolvedValue(undefined) },
}));

import { AppDataSource } from '../../database/data-source';
import { createTestTenant } from '../helpers/factories';
import { upsertLead } from '../../leads/lead-capture.service';

async function leadByKey(tenantId: string, dedupeKey: string) {
  const rows = await AppDataSource.query(
    `SELECT id, name, email, phone, channel, external_user_id, source, status
       FROM chatbot_leads WHERE tenant_id = $1 AND dedupe_key = $2 AND deleted_at IS NULL`,
    [tenantId, dedupeKey],
  );
  return rows;
}

describe('lead-capture upsert (real ON CONFLICT)', () => {
  let tenantId: string;

  beforeEach(async () => {
    const tenant = await createTestTenant({ tier: 'pro' }); // pro ⇒ leadCapture on
    tenantId = tenant.id;
  });

  it('inserts a channel lead, then dedups a second inbound to the SAME row', async () => {
    const a = await upsertLead({
      dataSource: AppDataSource, tenantId, source: 'channel',
      channel: 'whatsapp', externalUserId: '32475464421', name: 'Achraf',
    });
    expect(a?.inserted).toBe(true);

    const b = await upsertLead({
      dataSource: AppDataSource, tenantId, source: 'channel',
      channel: 'whatsapp', externalUserId: '32475464421', name: 'Achraf',
    });
    expect(b?.inserted).toBe(false);
    expect(b?.leadId).toBe(a?.leadId);

    const rows = await leadByKey(tenantId, 'whatsapp:32475464421');
    expect(rows).toHaveLength(1); // never a duplicate
    expect(rows[0].phone).toBe('32475464421'); // wa_id stored as phone
  });

  it('fill-not-overwrite + source upgrade: a channel lead that later books', async () => {
    await upsertLead({
      dataSource: AppDataSource, tenantId, source: 'channel',
      channel: 'whatsapp', externalUserId: '32475464421', name: 'Achraf',
    });
    // Booking on the same WhatsApp session → same key, brings an email, upgrades source.
    const booked = await upsertLead({
      dataSource: AppDataSource, tenantId, source: 'booking',
      channel: 'whatsapp', externalUserId: '32475464421',
      name: null /* later null must NOT blank the name */, email: 'achraf@example.com',
    });
    expect(booked?.inserted).toBe(false);

    const [row] = await leadByKey(tenantId, 'whatsapp:32475464421');
    expect(row.name).toBe('Achraf');               // preserved (COALESCE)
    expect(row.email).toBe('achraf@example.com');   // filled
    expect(row.source).toBe('booking');             // upgraded channel→booking
  });

  it('does NOT downgrade source (booking stays booking after a later channel touch)', async () => {
    await upsertLead({
      dataSource: AppDataSource, tenantId, source: 'booking',
      channel: 'whatsapp', externalUserId: '999', name: 'X', email: 'x@y.com',
    });
    await upsertLead({
      dataSource: AppDataSource, tenantId, source: 'channel',
      channel: 'whatsapp', externalUserId: '999',
    });
    const [row] = await leadByKey(tenantId, 'whatsapp:999');
    expect(row.source).toBe('booking');
  });

  it('a soft-deleted lead frees its key — re-engaging creates a fresh row', async () => {
    const first = await upsertLead({
      dataSource: AppDataSource, tenantId, source: 'channel', channel: 'telegram', externalUserId: '555',
    });
    await AppDataSource.query(`UPDATE chatbot_leads SET deleted_at = now() WHERE id = $1`, [first?.leadId]);

    const second = await upsertLead({
      dataSource: AppDataSource, tenantId, source: 'channel', channel: 'telegram', externalUserId: '555',
    });
    expect(second?.inserted).toBe(true);
    expect(second?.leadId).not.toBe(first?.leadId);
  });

  it('widget email-keyed lead; a phone-only widget lead keys on phone', async () => {
    const e = await upsertLead({
      dataSource: AppDataSource, tenantId, source: 'tool', channel: 'widget', name: 'W', email: 'W@X.com',
    });
    expect(e?.inserted).toBe(true);
    expect(await leadByKey(tenantId, 'email:w@x.com')).toHaveLength(1);

    const p = await upsertLead({
      dataSource: AppDataSource, tenantId, source: 'tool', channel: 'widget', phone: '+32 475 99 88 77',
    });
    expect(p?.inserted).toBe(true);
    expect(await leadByKey(tenantId, 'phone:32475998877')).toHaveLength(1);
  });

  it('the at-least-one-identifier CHECK rejects a hand-rolled identifier-less insert', async () => {
    await expect(
      AppDataSource.query(
        `INSERT INTO chatbot_leads (tenant_id, dedupe_key, source, status, metadata)
         VALUES ($1, 'bad:1', 'channel', 'new', '{}'::jsonb)`,
        [tenantId],
      ),
    ).rejects.toThrow();
  });
});
