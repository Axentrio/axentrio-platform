/**
 * The OTHER places a person's data lives.
 *
 * Erasing the lead row and the transcript was never the whole promise: the channel
 * binding holds their WhatsApp number, the judgment holds the model's verbatim
 * reasoning, the booking holds the address they typed, the handoff holds a copy of
 * the transcript, the sent emails hold their address, and the guardrail logs hold
 * the message that tripped them. Each case below pins one of those, and pins the
 * row that must SURVIVE (a booking's time, a judgment's aggregate).
 */
import { describe, it, expect, vi } from 'vitest';

const hooks = vi.hoisted(() => ({ emitted: [] as unknown[] }));
vi.mock('../../webhooks/webhook.emitter', async () => {
  const actual = await vi.importActual<typeof import('../../webhooks/webhook.emitter')>(
    '../../webhooks/webhook.emitter',
  );
  return {
    ...actual,
    emitWebhookEvent: (e: unknown) => {
      hooks.emitted.push(e);
    },
  };
});
vi.mock('../../services/notification.service', () => ({
  notificationService: { createForTenant: vi.fn().mockResolvedValue(undefined) },
}));

import { AppDataSource } from '../../database/data-source';
import { Lead } from '../../database/entities/Lead';
import { eraseLead } from '../../leads/lead-erasure.service';
import { createTestSession, createTestTenant, createTestAnchorBot } from '../helpers/factories';

async function seedLead(tenantId: string, sessionId: string, email: string) {
  const repo = AppDataSource.getRepository(Lead);
  return repo.save(
    repo.create({
      tenantId,
      name: 'Achraf Peeters',
      email,
      phone: '32475464421',
      dedupeKey: `email:${email}`,
      source: 'channel',
      sessionId,
    }),
  );
}

async function seedChannelConnection(tenantId: string): Promise<string> {
  const [row] = await AppDataSource.query(
    `INSERT INTO channel_connections ("tenantId", channel) VALUES ($1, 'whatsapp') RETURNING id`,
    [tenantId],
  );
  return row.id as string;
}

const one = async (sql: string, params: unknown[]) => (await AppDataSource.query(sql, params))[0];

describe('eraseLead — the holders outside the lead row and the transcript', () => {
  it('tombstones the channel binding so a later message cannot resurrect it', async () => {
    const tenant = await createTestTenant({ tier: 'pro' });
    await createTestAnchorBot(tenant);
    const session = await createTestSession(tenant.id);
    const lead = await seedLead(tenant.id, session.id, 'binding@example.com');
    const connectionId = await seedChannelConnection(tenant.id);
    const [binding] = await AppDataSource.query(
      `INSERT INTO conversation_bindings
         ("sessionId", "channelConnectionId", "externalUserId", "externalThreadId",
          "externalUserName", "externalAvatarUrl", "platformUserData")
       VALUES ($1, $2, '32475464421', '32475464421', 'Achraf', 'https://x/a.png', '{"a":1}'::jsonb)
       RETURNING id`,
      [session.id, connectionId],
    );

    const res = await eraseLead(AppDataSource, tenant.id, lead.id);

    expect(res!.scrubbed.conversationBindings).toBe(1);
    const row = await one(
      `SELECT "externalUserId", "externalThreadId", "externalUserName", "externalAvatarUrl", "platformUserData"
         FROM conversation_bindings WHERE id = $1`,
      [binding.id],
    );
    expect(row.externalUserId).toBe(`erased:${binding.id}`);
    expect(row.externalThreadId).toBe(`erased:${binding.id}`);
    expect(row.externalUserName).toBeNull();
    expect(row.externalAvatarUrl).toBeNull();
    expect(row.platformUserData).toEqual({});
  });

  it('strips the judgment but keeps the row its aggregate depends on', async () => {
    const tenant = await createTestTenant({ tier: 'pro' });
    await createTestAnchorBot(tenant);
    const session = await createTestSession(tenant.id);
    const lead = await seedLead(tenant.id, session.id, 'judgment@example.com');
    const [judgment] = await AppDataSource.query(
      `INSERT INTO chatbot_judgments
         (tenant_id, session_id, visitor_id, session_started_at, had_question, reasoning, topic_phrase, evidence_message_ids)
       VALUES ($1, $2, 'visitor-1', now(), true, 'they asked about a leak in the kitchen', 'leaking pipe', '["m1"]'::jsonb)
       RETURNING id`,
      [tenant.id, session.id],
    );

    const res = await eraseLead(AppDataSource, tenant.id, lead.id);

    expect(res!.scrubbed.judgments).toBe(1);
    const row = await one(
      `SELECT visitor_id, reasoning, topic_phrase, evidence_message_ids FROM chatbot_judgments WHERE id = $1`,
      [judgment.id],
    );
    expect(row.visitor_id).toBe(`erased:${session.id}`);
    expect(row.reasoning).toBeNull();
    expect(row.topic_phrase).toBeNull();
    expect(row.evidence_message_ids).toEqual([]);
  });

  it('removes the booking contact details and keeps the appointment', async () => {
    const tenant = await createTestTenant({ tier: 'pro' });
    const bot = await createTestAnchorBot(tenant);
    const session = await createTestSession(tenant.id, { botId: bot.id });
    const lead = await seedLead(tenant.id, session.id, 'booking@example.com');
    const [booking] = await AppDataSource.query(
      `INSERT INTO chatbot_bookings
         (tenant_id, bot_id, lead_id, session_id, start_utc, end_utc, calendar_key, ics_uid,
          attendee_name, attendee_email, customer_phone, customer_address, intake_answers, notes)
       VALUES ($1, $2, $3, $4, now() + interval '1 day', now() + interval '1 day 1 hour', 'cal', 'ics-1',
               'Achraf Peeters', 'booking@example.com', '32475464421', 'Kerkstraat 12', '{"q":"a"}'::jsonb, 'gate code 1234')
       RETURNING id`,
      [tenant.id, bot.id, lead.id, session.id],
    );

    const res = await eraseLead(AppDataSource, tenant.id, lead.id);

    expect(res!.scrubbed.bookings).toBe(1);
    const row = await one(
      `SELECT attendee_name, attendee_email, customer_phone, customer_address, intake_answers, notes, start_utc
         FROM chatbot_bookings WHERE id = $1`,
      [booking.id],
    );
    expect(row.attendee_name).toBeNull();
    expect(row.attendee_email).toBeNull();
    expect(row.customer_phone).toBeNull();
    expect(row.customer_address).toBeNull();
    expect(row.intake_answers).toBeNull();
    expect(row.notes).toBeNull();
    expect(row.start_utc).not.toBeNull(); // the diary still has the appointment
  });

  it('removes the transcript copy embedded in a handoff', async () => {
    const tenant = await createTestTenant({ tier: 'pro' });
    await createTestAnchorBot(tenant);
    const session = await createTestSession(tenant.id);
    const lead = await seedLead(tenant.id, session.id, 'handoff@example.com');
    const [handoff] = await AppDataSource.query(
      `INSERT INTO handoff_requests (tenant_id, session_id, requested_by, requested_at, status, reason, priority, context, notes)
       VALUES ($1, $2, gen_random_uuid(), now(), 'requested', 'user_request', 'medium',
               '{"messageHistory":[{"id":"m1","content":"my name is Achraf","sender":"user"}],"botConfidence":0.2}'::jsonb,
               'call him back on 0470 12 34 56')
       RETURNING id`,
      [tenant.id, session.id],
    );

    const res = await eraseLead(AppDataSource, tenant.id, lead.id);

    expect(res!.scrubbed.handoffContexts).toBe(1);
    const row = await one(`SELECT context, notes FROM handoff_requests WHERE id = $1`, [handoff.id]);
    expect(row.context.messageHistory).toBeUndefined();
    expect(row.context.botConfidence).toBe(0.2); // routing metadata survives
    expect(row.notes).toBeNull();
  });

  it('scrubs emails sent to the address they had at erasure time', async () => {
    const tenant = await createTestTenant({ tier: 'pro' });
    await createTestAnchorBot(tenant);
    const session = await createTestSession(tenant.id);
    const lead = await seedLead(tenant.id, session.id, 'mail@example.com');
    const [delivery] = await AppDataSource.query(
      `INSERT INTO email_deliveries (tenant_id, recipient_email, subject, kind, related_id, idempotency_key, payload)
       VALUES ($1, 'mail@example.com', 'Your booking', 'booking_confirmation', $2, 'idem-1', '{"name":"Achraf"}'::jsonb)
       RETURNING id`,
      [tenant.id, session.id],
    );

    const res = await eraseLead(AppDataSource, tenant.id, lead.id);

    expect(res!.scrubbed.emailDeliveries).toBe(1);
    const row = await one(
      `SELECT recipient_email, subject, payload FROM email_deliveries WHERE id = $1`,
      [delivery.id],
    );
    expect(row.recipient_email).toBe(`erased:${delivery.id}`);
    expect(row.subject).toBe('Erased');
    expect(row.payload).toBeNull();
  });

  it('clears the raw text held by the guardrail logs', async () => {
    const tenant = await createTestTenant({ tier: 'pro' });
    await createTestAnchorBot(tenant);
    const session = await createTestSession(tenant.id);
    const lead = await seedLead(tenant.id, session.id, 'guardrail@example.com');
    const [spam] = await AppDataSource.query(
      `INSERT INTO guardrail_spam_logs (tenant_id, conversation_id, source_channel, detected_category, reasons)
       VALUES ($1, $2, 'whatsapp', 'scam', '["send me your bank details"]'::jsonb)
       RETURNING id`,
      [tenant.id, session.id],
    );
    const [output] = await AppDataSource.query(
      `INSERT INTO guardrail_output_logs (tenant_id, conversation_id, source_channel, generation_path, families, reasons)
       VALUES ($1, $2, 'whatsapp', 'rag', '["pii"]'::jsonb, '["my number is 0470 12 34 56"]'::jsonb)
       RETURNING id`,
      [tenant.id, session.id],
    );

    const res = await eraseLead(AppDataSource, tenant.id, lead.id);

    expect(res!.scrubbed.guardrailLogs).toBe(2);
    const spamRow = await one(
      `SELECT reasons, suspicious_message_id FROM guardrail_spam_logs WHERE id = $1`,
      [spam.id],
    );
    const outputRow = await one(
      `SELECT reasons, families, outbound_message_id FROM guardrail_output_logs WHERE id = $1`,
      [output.id],
    );
    expect(spamRow.reasons).toBeNull();
    expect(spamRow.suspicious_message_id).toBeNull();
    expect(outputRow.reasons).toBeNull();
    expect(outputRow.families).toEqual([]);
    expect(outputRow.outbound_message_id).toBeNull();
  });
});
