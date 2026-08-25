/**
 * A guardrail pause is announced once and then reminded up to three times. That
 * ladder is driven by the age of the pause, and the age used to come from
 * `chat_sessions.updated_at` — which is not the pause. Both the pause itself and
 * the inbound message counter are raw UPDATEs that never touch that column, so it
 * still held whenever the row was last saved through the ORM, often hours before.
 * An inflated age jumps straight to the final re-alert bucket, so the owner heard
 * about a paused conversation once and was never reminded.
 *
 * The journal row that disabled auto-reply is the real moment of the pause.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AppDataSource } from '../../database/data-source';
import { SpamScamLog } from '../../database/entities/SpamScamLog';
import { createTestTenant, createTestSession } from '../helpers/factories';

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

const minAgo = (m: number) => new Date(Date.now() - m * 60_000);

/** A paused session whose row was last ORM-saved `staleMin` ago. */
async function pausedSession(tenantId: string, staleMin: number): Promise<string> {
  const session = await createTestSession(tenantId, {
    status: 'bot',
    aiAutoReplyEnabled: false,
    guardrailStatus: 'phishing',
  });
  await AppDataSource.query('UPDATE chat_sessions SET updated_at = $1 WHERE id = $2', [
    minAgo(staleMin),
    session.id,
  ]);
  return session.id;
}

/** The journal row a block writes, aged to when the pause really happened. */
async function blockRow(tenantId: string, sessionId: string, agoMin: number): Promise<void> {
  const repo = AppDataSource.getRepository(SpamScamLog);
  const row = await repo.save(repo.create({
    tenantId,
    conversationId: sessionId,
    sourceChannel: 'whatsapp',
    detectedCategory: 'phishing',
    aiAutoReplyDisabled: true,
    enforced: true,
    action: 'blocked',
  }));
  await AppDataSource.query('UPDATE guardrail_spam_logs SET created_at = $1 WHERE id = $2', [
    minAgo(agoMin),
    row.id,
  ]);
}

async function alertFor(sessionId: string): Promise<CapturedAlert | undefined> {
  created.length = 0;
  await sweepOverdueHandoffsAndPauses();
  return created.find((c) => c.type === 'guardrail.overdue' && c.data.sessionId === sessionId);
}

describe('SLA sweep · a pause is aged from the block that caused it', () => {
  beforeEach(() => {
    created.length = 0;
  });

  it('reports the age of the pause, not the age of the session row', async () => {
    const tenant = await createTestTenant();
    const sid = await pausedSession(tenant.id, 180); // row untouched for 3 hours
    await blockRow(tenant.id, sid, 20); // but paused 20 minutes ago

    const alert = await alertFor(sid);
    expect(alert?.data.ageMinutes).toBeGreaterThanOrEqual(20);
    expect(alert?.data.ageMinutes).toBeLessThan(30);
    // Bucket 0 keeps the reminder ladder intact. The stale clock produced bucket
    // 2, the cap, so the owner was told once and never reminded.
    expect(alert?.dedupeBase).toBe(`guardrail_overdue:${sid}:0`);
  });

  it('still alerts when the pause has no journal row', async () => {
    const tenant = await createTestTenant();
    const sid = await pausedSession(tenant.id, 45);

    const alert = await alertFor(sid);
    expect(alert?.data.ageMinutes).toBeGreaterThanOrEqual(45);
  });

  it('stays quiet on a pause younger than the SLA', async () => {
    const tenant = await createTestTenant();
    const sid = await pausedSession(tenant.id, 180);
    await blockRow(tenant.id, sid, 2); // paused two minutes ago

    expect(await alertFor(sid)).toBeUndefined();
  });

  it('ignores a journal row that did not pause anything', async () => {
    const tenant = await createTestTenant();
    const sid = await pausedSession(tenant.id, 45);
    // A shadow-mode observation, or a routing drop: logged, but it paused nothing.
    const repo = AppDataSource.getRepository(SpamScamLog);
    const row = await repo.save(repo.create({
      tenantId: tenant.id,
      conversationId: sid,
      sourceChannel: 'whatsapp',
      detectedCategory: 'spam',
      aiAutoReplyDisabled: false,
      enforced: false,
      action: 'log_only',
    }));
    await AppDataSource.query('UPDATE guardrail_spam_logs SET created_at = $1 WHERE id = $2', [
      minAgo(1),
      row.id,
    ]);

    // The 1-minute log row must not make a 45-minute pause look fresh.
    const alert = await alertFor(sid);
    expect(alert?.data.ageMinutes).toBeGreaterThanOrEqual(45);
  });
});
