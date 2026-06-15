import { describe, it, expect, beforeEach, vi } from 'vitest';

const { h } = vi.hoisted(() => ({
  h: {
    claimQueue: [] as Array<Record<string, unknown> | null>,
    updates: [] as Array<{ id: string; patch: Record<string, unknown> }>,
    sendResult: { success: true, messageId: 'msg_1' } as { success: boolean; messageId?: string; error?: string },
    sendCalls: [] as Array<Record<string, unknown>>,
    resolveEmail: async (_t: string) => 'owner@acme.test',
  },
}));

vi.mock('../../database/data-source', () => ({
  AppDataSource: {
    // claimOne does AppDataSource.query(...).then(...) — return next queued row (or []).
    query: async () => {
      const next = h.claimQueue.shift();
      return next ? [next] : [];
    },
    getRepository: () => ({
      update: async (id: string, patch: Record<string, unknown>) => { h.updates.push({ id, patch }); },
    }),
  },
}));

vi.mock('../../automations/email.service', () => ({
  EmailService: class {
    async send(opts: Record<string, unknown>) { h.sendCalls.push(opts); return h.sendResult; }
  },
}));

vi.mock('../../billing/service', () => ({ resolveBillingEmail: (t: string) => h.resolveEmail(t) }));
vi.mock('../../utils/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { sendDueDigests, __resetDigestEmailService } from '../../insights/digest-send.service';

const NOW = new Date('2026-06-15T02:00:00Z');
function claim(attempts: number) {
  return {
    id: `d-${attempts}`, tenant_id: 't1', week_start: '2026-06-08',
    summary_md: 'summary', send_attempts: attempts,
    metrics: { conversations: { current: 1, previous: 0 }, bookings: { current: 0, previous: 0 }, leads: { current: 0, previous: 0 }, gapsOpened: 0, gapsWon: 0 },
  };
}

beforeEach(() => {
  h.claimQueue = [];
  h.updates = [];
  h.sendCalls = [];
  h.sendResult = { success: true, messageId: 'msg_1' };
  h.resolveEmail = async () => 'owner@acme.test';
  __resetDigestEmailService();
});

describe('insights · digest send reconciler (P3 D6)', () => {
  it('sends a claimed digest and marks it sent (terminal, no next attempt)', async () => {
    h.claimQueue = [claim(1), null];
    const out = await sendDueDigests(NOW);
    expect(out).toEqual({ sent: 1, failed: 0 });
    expect(h.updates[0].patch).toMatchObject({ sendState: 'sent', providerMessageId: 'msg_1', sendNextAttemptAt: null });
  });

  it('attaches one-click List-Unsubscribe headers + a stable idempotency key', async () => {
    h.claimQueue = [claim(1), null];
    await sendDueDigests(NOW);
    const sent = h.sendCalls[0];
    expect(sent.idempotencyKey).toBe('digest:t1:2026-06-08');
    expect((sent.headers as Record<string, string>)['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
    expect((sent.headers as Record<string, string>)['List-Unsubscribe']).toMatch(/^<.*\/unsubscribe\/digest\?token=.+>$/);
  });

  it('uses the plain YYYY-MM-DD week in the subject (claim returns week_start::text)', async () => {
    // Live-caught: a bare `date` column comes back from pg as a JS Date and
    // stringifies to "Mon Jun 08 2026 …" — claimOne casts to text to keep it clean.
    h.claimQueue = [claim(1), null];
    await sendDueDigests(NOW);
    expect(h.sendCalls[0].subject).toBe('Your weekly business summary — week of 2026-06-08');
  });

  it('backs off a failed send while attempts remain', async () => {
    h.sendResult = { success: false, error: 'provider 500' };
    h.claimQueue = [claim(2), null];
    const out = await sendDueDigests(NOW);
    expect(out).toEqual({ sent: 0, failed: 1 });
    expect(h.updates[0].patch.sendState).toBe('failed');
    expect(h.updates[0].patch.sendNextAttemptAt).toBeInstanceOf(Date); // retryable
    expect(h.updates[0].patch.lastSendError).toContain('provider 500');
  });

  it('makes the send terminal after the max attempt (null next attempt)', async () => {
    h.sendResult = { success: false, error: 'still failing' };
    h.claimQueue = [claim(5), null]; // 5 = MAX_ATTEMPTS
    await sendDueDigests(NOW);
    expect(h.updates[0].patch.sendState).toBe('failed');
    expect(h.updates[0].patch.sendNextAttemptAt).toBeNull(); // never reclaimed
  });

  it('treats an unresolvable recipient as a (retryable) failure, not a crash', async () => {
    h.resolveEmail = async () => { throw new Error('billing_email_unresolvable'); };
    h.claimQueue = [claim(1), null];
    const out = await sendDueDigests(NOW);
    expect(out).toEqual({ sent: 0, failed: 1 });
    expect(h.updates[0].patch.lastSendError).toContain('billing_email_unresolvable');
    expect(h.sendCalls).toHaveLength(0); // never reached the mailer
  });
});
