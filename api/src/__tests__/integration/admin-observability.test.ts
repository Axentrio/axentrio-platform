import { describe, it, expect, beforeEach, vi } from 'vitest';
import crypto from 'crypto';
import { createAuthMocks, configureMockAuth } from '../helpers/auth';

const { auth } = createAuthMocks();

vi.mock('@clerk/express', () => ({
  clerkMiddleware: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('../../websocket/socket.handler', () => ({
  emitToSession: vi.fn(),
  emitToTenantAgents: vi.fn(),
}));
vi.mock('../../utils/audit', () => ({ logAudit: vi.fn().mockResolvedValue(undefined) }));

import request from 'supertest';
import { app } from '../../server';
import { AppDataSource } from '../../database/data-source';
import { SpamScamLog } from '../../database/entities/SpamScamLog';
import { AgentTrace } from '../../database/entities/AgentTrace';
import { GuardrailOutputLog } from '../../database/entities/GuardrailOutputLog';
import { ChannelConnection } from '../../database/entities/ChannelConnection';
import { MessageDelivery } from '../../database/entities/MessageDelivery';
import {
  createTestTenant,
  createTestUser,
  createTestSession,
  createTestParticipant,
  createTestMessage,
  createTestHandoffRequest,
} from '../helpers/factories';

const BASE = '/api/v1/admin/observability/overview';

describe('admin observability (Rollout Health snapshot)', () => {
  let tenantId: string;

  beforeEach(async () => {
    const tenant = await createTestTenant({ name: 'Acme Co', tier: 'pro' });
    tenantId = tenant.id;
    const admin = await createTestUser(tenantId, { role: 'super_admin' });
    configureMockAuth(auth, { userId: admin.id, tenantId, role: 'super_admin' });
  });

  async function seedActivity() {
    const session = await createTestSession(tenantId);
    const participant = await createTestParticipant(session.id, { type: 'user' });
    await createTestMessage(session.id, tenantId, participant.id);
    await createTestHandoffRequest(session.id, tenantId, { status: 'requested' });
    const spam = AppDataSource.getRepository(SpamScamLog);
    await spam.save(
      spam.create({
        tenantId,
        conversationId: crypto.randomUUID(),
        sourceChannel: 'widget',
        detectedCategory: 'phishing',
        reasons: ['fake alert'],
        enforced: false, // shadow
      }),
    );
    const out = AppDataSource.getRepository(GuardrailOutputLog);
    await out.save(
      out.create({
        tenantId,
        conversationId: crypto.randomUUID(),
        sourceChannel: 'widget',
        generationPath: 'coalescer',
        families: ['plan_leakage'],
        reasons: ['plan_leakage'],
        enforced: true, // enforced
      }),
    );
  }

  it('aggregates platform totals + per-tenant rows from seeded activity', async () => {
    await seedActivity();
    const res = await request(app).get(`${BASE}?days=7`);
    expect(res.status).toBe(200);
    const { windowDays, totals, byTenant, channelsDown } = res.body.data;

    expect(windowDays).toBe(7);
    expect(totals.sessions).toBe(1);
    expect(totals.messages).toBe(1);
    expect(totals.guardrailInbound).toEqual({ enforced: 0, shadow: 1 });
    expect(totals.guardrailOutput).toEqual({ enforced: 1, shadow: 0 });
    expect(totals.handoffs).toBe(1);
    expect(totals.openHandoffs).toBe(1);
    expect(totals.handoffRate).toBe(1); // 1 handoff / 1 session
    expect(totals.enforcedBlocks).toBe(1); // output enforced (inbound was shadow)
    expect(totals.impliedInboundFp).toEqual({ enforcedResumed: 0, ofEnforcedInbound: 0 });
    expect(totals.channelsDown).toBe(0);
    expect(totals.enforceOnTenants).toBe(0);
    expect(channelsDown).toEqual([]);

    // Per-tenant merge (separate aggregates merged in app code → no join multiplication).
    expect(byTenant).toHaveLength(1);
    expect(byTenant[0]).toMatchObject({
      tenantId,
      name: 'Acme Co',
      tier: 'pro',
      sessions: 1,
      messages: 1,
      guardrailBlocks: 2, // inbound shadow + output enforced
      handoffs: 1,
    });
  });

  it('counts channel-error connections + failed deliveries (camelCase tables)', async () => {
    const ch = AppDataSource.getRepository(ChannelConnection);
    await ch.save(ch.create({ tenantId, channel: 'telegram', status: 'error', label: 'Bot A', lastError: 'token expired' }));
    await ch.save(ch.create({ tenantId, channel: 'messenger', status: 'error', label: 'Page B', lastError: '401' }));
    await ch.save(ch.create({ tenantId, channel: 'whatsapp', status: 'active' })); // healthy → not counted
    const md = AppDataSource.getRepository(MessageDelivery);
    await md.save(md.create({ internalMessageId: crypto.randomUUID(), channelConnectionId: crypto.randomUUID(), channel: 'telegram', status: 'failed' }));
    await md.save(md.create({ internalMessageId: crypto.randomUUID(), channelConnectionId: crypto.randomUUID(), channel: 'telegram', status: 'sent' })); // not counted

    const res = await request(app).get(`${BASE}?days=7`);
    expect(res.status).toBe(200);
    expect(res.body.data.totals.channelsDown).toBe(2);
    expect(res.body.data.totals.deliveryFailures).toBe(1);
    expect(res.body.data.channelsDown).toHaveLength(2);
    expect(res.body.data.channelsDown.map((c: { channel: string }) => c.channel).sort()).toEqual(['messenger', 'telegram']);
  });

  it('counts an enforced inbound block whose session was resumed as implied-FP', async () => {
    const session = await createTestSession(tenantId); // defaults: guardrail_status='normal', ai_auto_reply_enabled=true
    const spam = AppDataSource.getRepository(SpamScamLog);
    await spam.save(
      spam.create({
        tenantId,
        conversationId: session.id,
        sourceChannel: 'widget',
        detectedCategory: 'spam',
        reasons: ['x'],
        enforced: true, // enforced, and the session is now resumed → implied FP
      }),
    );
    const res = await request(app).get(`${BASE}?days=7`);
    expect(res.body.data.totals.impliedInboundFp.enforcedResumed).toBe(1);
    expect(res.body.data.totals.impliedInboundFp.ofEnforcedInbound).toBe(1);
  });

  it('counts a tenant with guardrails.enforce=true in enforceOnTenants', async () => {
    await request(app).put(`/api/v1/admin/tenants/${tenantId}/guardrails`).send({ enforce: true });
    const res = await request(app).get(`${BASE}?days=7`);
    expect(res.body.data.totals.enforceOnTenants).toBe(1);
  });

  it('excludes events older than the window', async () => {
    const spam = AppDataSource.getRepository(SpamScamLog);
    await spam.save(
      spam.create({
        tenantId,
        conversationId: crypto.randomUUID(),
        sourceChannel: 'widget',
        detectedCategory: 'spam',
        reasons: ['old'],
        enforced: false,
      }),
    );
    await AppDataSource.query(
      `UPDATE guardrail_spam_logs SET created_at = now() - interval '30 days' WHERE tenant_id = $1`,
      [tenantId],
    );
    const res = await request(app).get(`${BASE}?days=7`);
    expect(res.body.data.totals.guardrailInbound.shadow).toBe(0);
  });

  it('clamps days (default 7, max 90, non-numeric → 7)', async () => {
    const big = await request(app).get(`${BASE}?days=999`);
    expect(big.body.data.windowDays).toBe(90);
    const zero = await request(app).get(`${BASE}?days=0`);
    expect(zero.body.data.windowDays).toBe(1);
    const bad = await request(app).get(`${BASE}?days=abc`);
    expect(bad.body.data.windowDays).toBe(7);
  });

  it('rejects non-super-admin', async () => {
    configureMockAuth(auth, { userId: crypto.randomUUID(), tenantId, role: 'admin' });
    const res = await request(app).get(`${BASE}?days=7`);
    expect(res.status).toBe(403);
  });

  /**
   * #68 §5c. `no_route` and `budget_spent` never send mail, so if they are not on this response
   * they are recorded nowhere a person looks and the counting is pure ceremony. The probe state
   * rides along for the same reason: an operator should be able to ask whether routing works
   * rather than wait to be told it doesn't.
   */
  it('reports travel-routing health and the rates that are never mailed', async () => {
    const res = await request(app).get(`${BASE}?days=7`);
    expect(res.status).toBe(200);
    expect(res.body.data.travel).toMatchObject({
      incidents: { probe: expect.any(Boolean), observed: expect.any(Boolean) },
      observedPlatformFailures: expect.any(Number),
    });
    // Never probes on request - that would put a billed Google call behind a page load.
    expect(res.body.data.travel.lastProbe).toBeNull();
    // `unknown` here, and that is the right answer rather than a gap: this process has no Redis,
    // so the monitor cannot see. Reporting zeros would say "quiet" where the truth is "blind".
    expect(res.body.data.travel.monitoring).toBe('unknown');
  });
});

/**
 * The trace endpoints exist because diagnosing "why did the bot say that" meant
 * querying production by hand. They return the SHAPE of a turn — which prompt
 * blocks composed it, whether a tool ran — never tool payloads: the stored trace
 * masks only a few top-level arg fields, and tool RESULTS are raw, so a kb_search
 * or list_bookings result can carry a customer's own content.
 */
describe('admin observability — agent traces', () => {
  const LIST = '/api/v1/admin/observability/traces';
  let tenantId: string;

  /** A turn shaped exactly like production: a prompt ledger, and a tool call
   *  whose args AND result carry customer data. */
  const seedTrace = async (over: Partial<AgentTrace> = {}): Promise<AgentTrace> => {
    const repo = AppDataSource.getRepository(AgentTrace);
    return repo.save(
      repo.create({
        tenantId,
        finishReason: 'completed',
        totalTokens: 120,
        totalLatencyMs: 900,
        trace: {
          prompt: {
            includedBlocks: ['TEMPLATE_BODY', 'KNOWLEDGE'],
            excludedBlocks: [{ key: 'KB_CONTEXT', reason: 'empty' }],
          },
          iterations: [
            {
              llmCall: { model: 'gpt-4.1-mini', latencyMs: 800, promptTokens: 100, completionTokens: 20 },
              toolCalls: [
                {
                  name: 'capture_lead',
                  latencyMs: 40,
                  args: { email: 'CUSTOMER-SECRET@example.com', note: 'ARGS-SHOULD-NOT-LEAK' },
                  result: { success: true, data: { transcript: 'RESULT-SHOULD-NOT-LEAK' } },
                },
              ],
            },
          ],
        },
        ...over,
      }),
    );
  };

  beforeEach(async () => {
    const tenant = await createTestTenant({ name: 'Trace Co', tier: 'pro' });
    tenantId = tenant.id;
    const admin = await createTestUser(tenantId, { role: 'super_admin' });
    configureMockAuth(auth, { userId: admin.id, tenantId, role: 'super_admin' });
  });

  it('lists turns with the counts that make a bad turn obvious', async () => {
    await seedTrace();
    const res = await request(app).get(`${LIST}?tenantId=${tenantId}`);

    expect(res.status).toBe(200);
    expect(res.body.data.traces).toHaveLength(1);
    expect(res.body.data.traces[0]).toMatchObject({
      finishReason: 'completed',
      iterationCount: 1,
      toolCallCount: 1,
      model: 'gpt-4.1-mini',
    });
  });

  it('filters to failures, which is why anyone opens this', async () => {
    await seedTrace();
    await seedTrace({ finishReason: 'error' });

    const res = await request(app).get(`${LIST}?tenantId=${tenantId}&finishReason=error`);
    expect(res.body.data.traces).toHaveLength(1);
    expect(res.body.data.traces[0].finishReason).toBe('error');
  });

  it('returns the prompt ledger — how a misbehaving prompt gets diagnosed', async () => {
    const t = await seedTrace();
    const res = await request(app).get(`${LIST}/${t.id}`);

    expect(res.status).toBe(200);
    expect(res.body.data.trace.prompt.includedBlocks).toContain('KNOWLEDGE');
    expect(res.body.data.trace.prompt.excludedBlocks[0]).toMatchObject({ key: 'KB_CONTEXT', reason: 'empty' });
  });

  it('reports tool names and outcomes, so "answered without retrieving" is visible', async () => {
    const t = await seedTrace();
    const res = await request(app).get(`${LIST}/${t.id}`);

    expect(res.body.data.trace.iterations[0].toolCalls).toEqual([
      { name: 'capture_lead', ok: true, latencyMs: 40 },
    ]);
  });

  it('surfaces a failed tool call’s DOMAIN error code, never its message or args', async () => {
    // The gap this closes: a create_booking that threw SERVICE_NOT_FOUND showed only ok:false,
    // so a customer told "the service is unavailable" had no visible cause in the trace. The
    // leading UPPER_SNAKE code is safe (enum-like); the message after the colon and the args are
    // not, and must not appear.
    const repo = AppDataSource.getRepository(AgentTrace);
    const t = await repo.save(
      repo.create({
        tenantId,
        finishReason: 'completed',
        trace: {
          iterations: [
            {
              llmCall: { model: 'gpt-4.1-mini', latencyMs: 10, promptTokens: 1, completionTokens: 1 },
              toolCalls: [
                {
                  name: 'create_booking',
                  latencyMs: 5,
                  args: { serviceId: 'svc-SECRET', attendeeName: 'LEAK-NAME' },
                  result: { success: false, error: 'SERVICE_NOT_FOUND: That serviceId is not bookable LEAK-MESSAGE' },
                },
              ],
            },
          ],
        },
      }),
    );

    const res = await request(app).get(`${LIST}/${t.id}`);
    expect(res.body.data.trace.iterations[0].toolCalls).toEqual([
      { name: 'create_booking', ok: false, errorCode: 'SERVICE_NOT_FOUND', latencyMs: 5 },
    ]);
    const body = JSON.stringify(res.body);
    expect(body).not.toContain('LEAK-MESSAGE');
    expect(body).not.toContain('LEAK-NAME');
    expect(body).not.toContain('svc-SECRET');
  });

  it('NEVER returns tool args or results, even to a super admin', async () => {
    const t = await seedTrace();
    const detail = JSON.stringify((await request(app).get(`${LIST}/${t.id}`)).body);
    const list = JSON.stringify((await request(app).get(`${LIST}?tenantId=${tenantId}`)).body);

    for (const body of [detail, list]) {
      expect(body).not.toContain('ARGS-SHOULD-NOT-LEAK');
      expect(body).not.toContain('RESULT-SHOULD-NOT-LEAK');
      expect(body).not.toContain('CUSTOMER-SECRET@example.com');
    }
  });

  it('404s on an unknown trace', async () => {
    const res = await request(app).get(`${LIST}/11111111-1111-4111-8111-111111111111`);
    expect(res.status).toBe(404);
  });

  /**
   * WHICH GUARDS HAD TO STEP IN.
   *
   * Three in-loop guards rewrite or re-run a turn, and each recorded that with nothing but a
   * `logger.warn`. So "is that guard firing in production, and how often" meant grepping a log
   * nobody greps. It matters most for the newest one - a dated closure the model never checked -
   * whose trigger is a model misbehaviour that cannot be reproduced on demand, so the only
   * honest evidence it works in the wild is a counter that goes up.
   */
  const withCorrections = (corrections: string[]) =>
    seedTrace({ trace: { corrections, iterations: [] } as never });

  it('reports which guards corrected the turn, on the LIST', async () => {
    await withCorrections(['availability_unchecked_claim']);
    const res = await request(app).get(`${LIST}?tenantId=${tenantId}`);
    // One row in a tenant of its own, so `traces[0]` is this row and not whichever of several
    // same-timestamp seeds the sort happened to pick. Asserted, not assumed.
    expect(res.body.data.traces).toHaveLength(1);
    expect(res.body.data.traces[0].corrections).toEqual(['availability_unchecked_claim']);
  });

  it('reports an empty list for a clean turn, never undefined', async () => {
    // A caller counting firings must be able to read the field on every row.
    await seedTrace();
    const res = await request(app).get(`${LIST}?tenantId=${tenantId}`);
    expect(res.body.data.traces).toHaveLength(1);
    expect(res.body.data.traces[0].corrections).toEqual([]);
  });

  it('filters by guard, so "is it firing at all" is one request', async () => {
    await seedTrace();
    await withCorrections(['unrecorded_booking_claim']);
    await withCorrections(['availability_unchecked_claim']);

    const res = await request(app).get(`${LIST}?tenantId=${tenantId}&correction=availability_unchecked_claim`);
    expect(res.body.data.traces).toHaveLength(1);
    expect(res.body.data.traces[0].corrections).toEqual(['availability_unchecked_claim']);
  });

  it('records EVERY guard that fired, in order, not just the first', async () => {
    // Named for what it checks. It was called "keeps repeats" and asserted two DIFFERENT names,
    // which a deduplicating field would also have passed - and repeats cannot happen at all:
    // each guard sits behind its own single-shot flag, so one name never appears twice. Two
    // different guards in one run is the real case, and losing the second would hide it.
    await withCorrections(['booking_address_mismatch', 'availability_unchecked_claim']);
    const res = await request(app).get(`${LIST}?tenantId=${tenantId}&correction=availability_unchecked_claim`);
    expect(res.body.data.traces).toHaveLength(1);
    expect(res.body.data.traces[0].corrections).toEqual([
      'booking_address_mismatch',
      'availability_unchecked_claim',
    ]);
  });

  it('is super-admin only', async () => {
    await seedTrace();
    configureMockAuth(auth, { userId: crypto.randomUUID(), tenantId, role: 'admin' });
    const res = await request(app).get(`${LIST}?tenantId=${tenantId}`);
    expect(res.status).toBe(403);
  });
});
