/**
 * Lead erasure (GDPR Art 17) against the real DB.
 *
 * Integration rather than unit because the interesting behaviour is SQL: the identity
 * CHECK that forbids a fully-blank row, the tombstone that stops the erased identity
 * being upserted back to life, and the jsonb predicates that find derived PII in
 * notifications and webhook delivery logs.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

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
import { LeadConversation } from '../../database/entities/LeadConversation';
import { eraseLead, isErasedDedupeKey, ERASED_PREFIX } from '../../leads/lead-erasure.service';
import { upsertLead } from '../../leads/lead-capture.service';
import { createTestTenant, createTestSession } from '../helpers/factories';

async function seedLead(tenantId: string, over: Partial<Lead> = {}) {
  const repo = AppDataSource.getRepository(Lead);
  return repo.save(
    repo.create({
      tenantId,
      name: 'Achraf Peeters',
      email: 'achraf@example.com',
      phone: '32475464421',
      channel: 'whatsapp',
      externalUserId: '32475464421',
      dedupeKey: 'whatsapp:32475464421',
      source: 'channel',
      notes: 'Burst pipe, Kerkstraat 12 Antwerp',
      ...over,
    }),
  );
}

beforeEach(() => {
  hooks.emitted = [];
});

describe('eraseLead', () => {
  it('strips every personal field but keeps an auditable husk', async () => {
    const tenant = await createTestTenant({ tier: 'pro' });
    const lead = await seedLead(tenant.id);

    const res = await eraseLead(AppDataSource, tenant.id, lead.id);
    expect(res).not.toBeNull();

    const [row] = await AppDataSource.query(
      `SELECT name, email, phone, notes, metadata, external_user_id, dedupe_key, status, deleted_at, source, created_at
         FROM chatbot_leads WHERE id = $1`,
      [lead.id],
    );
    // No personal data survives…
    expect(row.name).toBeNull();
    expect(row.email).toBeNull();
    expect(row.phone).toBeNull();
    expect(row.notes).toBeNull();
    expect(row.metadata).toEqual({});
    // …but the row remains, so "this lead was erased" is itself auditable.
    expect(row.status).toBe('erased');
    expect(row.deleted_at).not.toBeNull();
    expect(row.source).toBe('channel');
    expect(row.created_at).not.toBeNull();
  });

  it('satisfies the identity CHECK by writing a tombstone rather than nulling all three ids', async () => {
    // chk_chatbot_leads_identity requires email OR phone OR external_user_id to be
    // non-null. Nulling all three throws, which is why erasure writes `erased:<id>`.
    const tenant = await createTestTenant({ tier: 'pro' });
    const lead = await seedLead(tenant.id);
    await eraseLead(AppDataSource, tenant.id, lead.id);

    const [row] = await AppDataSource.query(
      `SELECT external_user_id, dedupe_key FROM chatbot_leads WHERE id = $1`,
      [lead.id],
    );
    expect(row.external_user_id).toBe(`${ERASED_PREFIX}${lead.id}`);
    expect(row.dedupe_key).toBe(`${ERASED_PREFIX}${lead.id}`);
    expect(isErasedDedupeKey(row.dedupe_key)).toBe(true);
  });

  it('cannot be resurrected: the SAME contact messaging again gets a fresh lead, not the old data back', async () => {
    const tenant = await createTestTenant({ tier: 'pro' });
    const lead = await seedLead(tenant.id);
    await eraseLead(AppDataSource, tenant.id, lead.id);

    // The customer messages again on the same WhatsApp number.
    const again = await upsertLead({
      dataSource: AppDataSource,
      tenantId: tenant.id,
      source: 'channel',
      channel: 'whatsapp',
      externalUserId: '32475464421',
      name: 'Achraf Peeters',
    });
    expect(again).not.toBeNull();
    // A NEW row — the erased husk was not revived.
    expect(again!.leadId).not.toBe(lead.id);
    expect(again!.inserted).toBe(true);

    const [old] = await AppDataSource.query(`SELECT name, status FROM chatbot_leads WHERE id = $1`, [lead.id]);
    expect(old.name).toBeNull();
    expect(old.status).toBe('erased');
  });

  it('refuses to mint a dedupe key inside the reserved tombstone namespace', async () => {
    const tenant = await createTestTenant({ tier: 'pro' });
    const lead = await seedLead(tenant.id);
    await eraseLead(AppDataSource, tenant.id, lead.id);

    // A crafted external id aimed at another lead's tombstone must be refused
    // outright rather than resolving to that row.
    const res = await upsertLead({
      dataSource: AppDataSource,
      tenantId: tenant.id,
      source: 'channel',
      channel: 'whatsapp',
      externalUserId: `${ERASED_PREFIX}${lead.id}`,
      name: 'Attacker',
    });
    expect(res).toBeNull();

    const [row] = await AppDataSource.query(`SELECT name FROM chatbot_leads WHERE id = $1`, [lead.id]);
    expect(row.name).toBeNull(); // still erased
  });

  it('scrubs per-conversation extracted PII and makes the row terminal for enrichment', async () => {
    const tenant = await createTestTenant({ tier: 'pro' });
    const lead = await seedLead(tenant.id);
    const convRepo = AppDataSource.getRepository(LeadConversation);
    await convRepo.save(
      convRepo.create({
        tenantId: tenant.id,
        leadId: lead.id,
        request: 'Burst pipe in the basement',
        address: 'Kerkstraat 12, Antwerp',
        urgency: 'emergency',
        intent: 'booking',
        tags: ['plumbing', 'leak'],
        enrichment: { problemType: 'burst_pipe' },
        evidence: [{ field: 'address', evidenceMessageId: 'm1', span: 'Kerkstraat 12', source: 'extractor' }],
        enrichState: 'enriched',
      }),
    );

    const res = await eraseLead(AppDataSource, tenant.id, lead.id);
    expect(res!.scrubbed.conversations).toBe(1);

    const [conv] = await AppDataSource.query(
      `SELECT request, address, urgency, intent, tags, enrichment, evidence, enrich_state
         FROM chatbot_lead_conversations WHERE lead_id = $1`,
      [lead.id],
    );
    expect(conv.request).toBeNull();
    expect(conv.address).toBeNull();
    expect(conv.urgency).toBeNull();
    expect(conv.intent).toBeNull();
    expect(conv.tags).toBeNull();
    expect(conv.enrichment).toEqual({});
    expect(conv.evidence).toEqual([]);
    // Terminal: the sweep must never re-derive what was just erased.
    expect(conv.enrich_state).toBe('erased');
  });

  it('emits exactly one lead.deleted carrying the PRIOR dedupe key and NO personal data', async () => {
    const tenant = await createTestTenant({ tier: 'pro' });
    const lead = await seedLead(tenant.id);

    await eraseLead(AppDataSource, tenant.id, lead.id);

    const deleted = hooks.emitted.filter((e) => (e as { type: string }).type === 'lead.deleted');
    expect(deleted).toHaveLength(1);
    const event = deleted[0] as { lead: Record<string, unknown> };
    // The prior key is how a downstream CRM locates its own copy.
    expect(event.lead.leadId).toBe(lead.id);
    expect(event.lead.dedupeKey).toBe('whatsapp:32475464421');
    // A "delete this person" message must not restate the person.
    expect(event.lead).not.toHaveProperty('name');
    expect(event.lead).not.toHaveProperty('email');
    expect(event.lead).not.toHaveProperty('phone');
    expect(event.lead).not.toHaveProperty('notes');
  });

  it('scrubs the operator notification that copied the contact and request into its body', async () => {
    // The jsonb predicate (`data->>'leadId'`) is load-bearing: if it matched nothing
    // the erasure would report success while the customer's name and request stayed
    // readable in the portal and in already-delivered push payloads.
    const tenant = await createTestTenant({ tier: 'pro' });
    const lead = await seedLead(tenant.id);
    await AppDataSource.query(
      `INSERT INTO notifications (tenant_id, recipient_user_id, type, title, message, data, dedupe_key)
       VALUES ($1, $2, 'lead_created', 'New lead captured',
               'Achraf Peeters — Burst pipe, Kerkstraat 12 Antwerp',
               jsonb_build_object('leadId', $3::text, 'notes', 'Burst pipe, Kerkstraat 12 Antwerp'),
               $4)`,
      [tenant.id, lead.id, lead.id, `lead:${lead.id}:test`],
    );

    const res = await eraseLead(AppDataSource, tenant.id, lead.id);
    expect(res!.scrubbed.notifications).toBe(1);

    const [n] = await AppDataSource.query(
      `SELECT message, data FROM notifications WHERE data->>'leadId' = $1`,
      [lead.id],
    );
    expect(n.message).not.toContain('Achraf');
    expect(n.message).not.toContain('Kerkstraat');
    expect(n.data.notes).toBeUndefined();
    expect(n.data.erased).toBe(true);
  });

  it('redacts the outbound webhook body that already shipped the lead downstream', async () => {
    const tenant = await createTestTenant({ tier: 'pro' });
    const lead = await seedLead(tenant.id);
    await AppDataSource.query(
      `INSERT INTO webhook_delivery_logs (tenant_id, event, direction, url, status, request_body)
       VALUES ($1, 'lead.created', 'outbound', 'https://hooks.example.com/x', 'success',
               jsonb_build_object('lead', jsonb_build_object(
                 'leadId', $2::text, 'name', 'Achraf Peeters', 'phone', '32475464421')))`,
      [tenant.id, lead.id],
    );

    const res = await eraseLead(AppDataSource, tenant.id, lead.id);
    expect(res!.scrubbed.webhookLogs).toBe(1);

    const [log] = await AppDataSource.query(
      `SELECT event, status, request_body FROM webhook_delivery_logs WHERE tenant_id = $1`,
      [tenant.id],
    );
    // Delivery history survives for debugging; the personal data does not.
    expect(log.event).toBe('lead.created');
    expect(log.status).toBe('success');
    expect(JSON.stringify(log.request_body)).not.toContain('Achraf');
    expect(JSON.stringify(log.request_body)).not.toContain('32475464421');
    expect(log.request_body.redacted).toBe(true);
  });

  it('scrubs agent traces, which record capture_lead arguments verbatim', async () => {
    // A trace holds the tool call that CREATED the lead — name, phone and request in
    // jsonb. Erasing the lead while leaving that readable would defeat the erasure for
    // anyone opening the trace viewer.
    const tenant = await createTestTenant({ tier: 'pro' });
    const session = await createTestSession(tenant.id);
    const lead = await seedLead(tenant.id, { sessionId: session.id });

    await AppDataSource.query(
      `INSERT INTO agent_traces ("tenantId", "sessionId", trace) VALUES ($1, $2, $3::jsonb)`,
      [
        tenant.id,
        session.id,
        JSON.stringify({
          iterations: [
            { toolCalls: [{ name: 'capture_lead', args: { name: 'Achraf Peeters', phone: '32475464421' } }] },
          ],
        }),
      ],
    );

    const res = await eraseLead(AppDataSource, tenant.id, lead.id);
    expect(res!.scrubbed.agentTraces).toBe(1);

    const [row] = await AppDataSource.query(`SELECT trace FROM agent_traces WHERE "tenantId" = $1`, [tenant.id]);
    expect(JSON.stringify(row.trace)).not.toContain('Achraf');
    expect(JSON.stringify(row.trace)).not.toContain('32475464421');
    expect(row.trace.erased).toBe(true);
  });

  it('does not touch agent traces belonging to OTHER conversations', async () => {
    const tenant = await createTestTenant({ tier: 'pro' });
    const mine = await createTestSession(tenant.id);
    const theirs = await createTestSession(tenant.id);
    const lead = await seedLead(tenant.id, { sessionId: mine.id });

    await AppDataSource.query(
      `INSERT INTO agent_traces ("tenantId", "sessionId", trace) VALUES ($1, $2, '{"keep":"me"}'::jsonb)`,
      [tenant.id, theirs.id],
    );

    await eraseLead(AppDataSource, tenant.id, lead.id);
    const [row] = await AppDataSource.query(`SELECT trace FROM agent_traces WHERE "sessionId" = $1`, [theirs.id]);
    expect(row.trace.keep).toBe('me');
  });

  it('is idempotent — a second erase is a no-op and emits no second event', async () => {
    const tenant = await createTestTenant({ tier: 'pro' });
    const lead = await seedLead(tenant.id);

    expect(await eraseLead(AppDataSource, tenant.id, lead.id)).not.toBeNull();
    hooks.emitted = [];
    expect(await eraseLead(AppDataSource, tenant.id, lead.id)).toBeNull();
    expect(hooks.emitted).toHaveLength(0);
  });

  it('is tenant-scoped — another tenant cannot erase your lead', async () => {
    const owner = await createTestTenant({ tier: 'pro' });
    const other = await createTestTenant({ tier: 'pro' });
    const lead = await seedLead(owner.id);

    expect(await eraseLead(AppDataSource, other.id, lead.id)).toBeNull();

    const [row] = await AppDataSource.query(`SELECT name FROM chatbot_leads WHERE id = $1`, [lead.id]);
    expect(row.name).toBe('Achraf Peeters'); // untouched
  });
});
