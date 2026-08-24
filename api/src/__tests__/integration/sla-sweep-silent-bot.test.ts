/**
 * Silent-bot watchdog (source 4 of the SLA sweep), against a real database.
 *
 * This is the alarm that did not exist when a guardrails freeze left a live
 * WhatsApp conversation dead for 40 minutes. Every other overdue source needs a
 * handoff row or a pause flag; a frozen bot session has neither. The query is
 * the whole feature, so it is tested against real rows rather than a mock.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AppDataSource } from '../../database/data-source';
import { ChatSession } from '../../database/entities/ChatSession';
import { Message } from '../../database/entities/Message';
import {
  createTestTenant,
  createTestSession,
  createTestParticipant,
  createTestMessage,
} from '../helpers/factories';

/** The fields of a createForTenant call this test asserts on. */
interface CapturedAlert {
  type: string;
  dedupeBase: string;
  data: { sessionId: string; ageMinutes: number };
}

const created = vi.hoisted(() => [] as CapturedAlert[]);
vi.mock('../../services/notification.service', () => ({
  notificationService: {
    createForTenant: async (args: CapturedAlert) => {
      created.push(args);
    },
  },
}));
vi.mock('../../services/handoff-notification.service', () => ({
  notifyOverdueHandoff: vi.fn().mockResolvedValue(undefined),
}));

import { sweepOverdueHandoffsAndPauses } from '../../notifications/sla-sweep';

const messageRepo = () => AppDataSource.getRepository(Message);

/** A session whose customer spoke `askedMin` ago, with an optional later reply. */
async function conversation(opts: {
  tenantId: string;
  askedMin: number;
  session?: Partial<ChatSession>;
  replyMin?: number;
  flagAsk?: boolean;
}): Promise<string> {
  const session = await createTestSession(opts.tenantId, { status: 'bot', ...opts.session });
  const user = await createTestParticipant(session.id, { type: 'user' });
  const ask = await createTestMessage(session.id, opts.tenantId, user.id, {
    content: 'is donderdag vrij?',
    ...(opts.flagAsk ? { guardrailFlagged: true } : {}),
  });
  await messageRepo().update(ask.id, { createdAt: new Date(Date.now() - opts.askedMin * 60_000) });
  if (opts.replyMin !== undefined) {
    const bot = await createTestParticipant(session.id, { type: 'bot', name: 'Bot' });
    const reply = await createTestMessage(session.id, opts.tenantId, bot.id, { content: 'ja hoor' });
    await messageRepo().update(reply.id, { createdAt: new Date(Date.now() - opts.replyMin * 60_000) });
  }
  return session.id;
}

async function silentAlerts(): Promise<string[]> {
  created.length = 0;
  await sweepOverdueHandoffsAndPauses();
  return created.filter((c) => c.type === 'bot.silent').map((c) => c.data.sessionId);
}

describe('SLA sweep · silent-bot watchdog', () => {
  beforeEach(() => {
    created.length = 0;
  });

  it('alerts on a live bot session whose customer never got an answer', async () => {
    const tenant = await createTestTenant();
    const stuck = await conversation({ tenantId: tenant.id, askedMin: 20 });

    expect(await silentAlerts()).toContain(stuck);
  });

  it('carries the waiting time and a bucketed dedupe key', async () => {
    const tenant = await createTestTenant();
    const stuck = await conversation({ tenantId: tenant.id, askedMin: 45 });

    created.length = 0;
    await sweepOverdueHandoffsAndPauses();
    const alert = created.find((c) => c.type === 'bot.silent' && c.data.sessionId === stuck);
    expect(alert?.data.ageMinutes).toBeGreaterThanOrEqual(45);
    expect(alert?.dedupeBase).toBe(`silent_overdue:${stuck}:1`);
  });

  it.each([
    ['a reply arrived after the question', { askedMin: 20, replyMin: 19 }],
    ['the question is still fresh', { askedMin: 2 }],
    ['the message was blocked on purpose', { askedMin: 20, flagAsk: true }],
  ])('stays quiet when %s', async (_name, opts) => {
    const tenant = await createTestTenant();
    const sid = await conversation({ tenantId: tenant.id, ...opts });

    expect(await silentAlerts()).not.toContain(sid);
  });

  it.each([
    ['a human owns it', { status: 'handoff' as const }],
    ['it is closed', { status: 'closed' as const }],
    ['a human holds ownership', { ownership: 'human_owned' as const }],
    ['the guardrails paused it', { aiAutoReplyEnabled: false, guardrailStatus: 'spam' }],
  ])('leaves %s to the other sources', async (_name, session) => {
    const tenant = await createTestTenant();
    const sid = await conversation({ tenantId: tenant.id, askedMin: 20, session });

    expect(await silentAlerts()).not.toContain(sid);
  });

  it('re-alerts a still-stuck session under the same dedupe key', async () => {
    const tenant = await createTestTenant();
    const stuck = await conversation({ tenantId: tenant.id, askedMin: 20 });

    const first = await silentAlerts();
    const second = await silentAlerts();
    // The sweep itself is not idempotent; createForTenant's dedupeBase is what
    // bounds the noise, so both passes must produce the SAME key.
    expect(first).toContain(stuck);
    expect(second).toContain(stuck);
    expect(new Set(created.map((c) => c.dedupeBase)).size).toBe(1);
  });

  it('separates a silent session from a paused one in the same tenant', async () => {
    const tenant = await createTestTenant();
    const paused = await conversation({
      tenantId: tenant.id, askedMin: 30,
      session: { aiAutoReplyEnabled: false, guardrailStatus: 'bot_loop' },
    });
    // Source 3 keys off updated_at, not off the message, and @UpdateDateColumn
    // overwrites any value set through the repository. Age it with the same JS
    // clock the sweep's cutoff uses, or the pause looks fresh and never alerts.
    await AppDataSource.query('UPDATE chat_sessions SET updated_at = $1 WHERE id = $2', [
      new Date(Date.now() - 30 * 60_000),
      paused,
    ]);
    const stuck = await conversation({ tenantId: tenant.id, askedMin: 30 });

    created.length = 0;
    await sweepOverdueHandoffsAndPauses();
    const byType = created.reduce<Record<string, string[]>>((acc, c) => {
      (acc[c.type] ??= []).push(c.data.sessionId);
      return acc;
    }, {});
    // Disjoint by construction: the paused one is source 3's, never source 4's.
    expect(byType['bot.silent']).toContain(stuck);
    expect(byType['bot.silent']).not.toContain(paused);
    expect(byType['guardrail.overdue']).toContain(paused);
  });
});
