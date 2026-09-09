/**
 * Conversation retention sweep.
 *
 * This is the second feature on the platform that DELETES customer data
 * automatically (lead retention is the first), so the tests are weighted towards
 * what it must refuse to do: the default-keep behaviour and the fail-towards-
 * keeping handling of a malformed period get as much coverage as the deletion.
 *
 * The `chatbot_judgments` case is the one that would silently rot: that table has
 * no foreign key to `chat_sessions`, so nothing cascades and an unexercised sweep
 * would leave the visitor id and the model's verbatim reasoning behind.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const hooks = vi.hoisted(() => ({ notifications: [] as unknown[] }));
vi.mock('../../services/notification.service', () => ({
  notificationService: {
    createForTenant: vi.fn(async (n: unknown) => {
      hooks.notifications.push(n);
    }),
  },
}));
vi.mock('../../utils/audit', () => ({ logAudit: vi.fn().mockResolvedValue(undefined) }));

import { AppDataSource } from '../../database/data-source';
import {
  sweepConversationRetention,
  readConversationRetentionDays,
  MIN_CONVERSATION_RETENTION_DAYS,
  MAX_CONVERSATION_RETENTION_DAYS,
} from '../../conversations/conversation-retention.service';
import {
  createTestTenant,
  createTestSession,
  createTestParticipant,
  createTestMessage,
} from '../helpers/factories';

const uniq = () => Math.random().toString(36).slice(2, 10);

async function tenantWithRetention(days: number | null) {
  const tenant = await createTestTenant({ tier: 'pro' });
  if (days !== null) {
    await AppDataSource.query(
      `UPDATE tenants SET settings = COALESCE(settings,'{}'::jsonb) || jsonb_build_object('conversationRetentionDays', $2::int) WHERE id = $1`,
      [tenant.id, days],
    );
  }
  return tenant;
}

/** A conversation whose last activity is `ageDays` ago, with one message in it. */
async function seedConversation(tenantId: string, ageDays: number) {
  const session = await createTestSession(tenantId);
  const participant = await createTestParticipant(session.id, { type: 'user' });
  const message = await createTestMessage(session.id, tenantId, participant.id, {
    content: 'My name is Achraf, call me on 0470 12 34 56',
  });
  await AppDataSource.query(
    `UPDATE chat_sessions SET last_activity_at = now() - ($2 || ' days')::interval WHERE id = $1`,
    [session.id, String(ageDays)],
  );
  return { session, participant, message };
}

async function seedJudgment(tenantId: string, sessionId: string): Promise<string> {
  const [row] = await AppDataSource.query(
    `INSERT INTO chatbot_judgments
       (tenant_id, session_id, visitor_id, session_started_at, had_question, reasoning)
     VALUES ($1, $2, $3, now(), true, 'the customer asked about pricing')
     RETURNING id`,
    [tenantId, sessionId, `visitor-${uniq()}`],
  );
  return row.id as string;
}

const exists = async (table: string, id: string): Promise<boolean> => {
  const rows = await AppDataSource.query(`SELECT 1 FROM ${table} WHERE id = $1`, [id]);
  return rows.length > 0;
};

beforeEach(() => {
  hooks.notifications.length = 0;
});

describe('readConversationRetentionDays', () => {
  it('returns null when the tenant has not chosen a period', () => {
    expect(readConversationRetentionDays({})).toBeNull();
    expect(readConversationRetentionDays(null)).toBeNull();
  });

  it('fails towards KEEPING data on a malformed or out-of-range value', () => {
    expect(readConversationRetentionDays({ conversationRetentionDays: '365' })).toBeNull();
    expect(readConversationRetentionDays({ conversationRetentionDays: NaN })).toBeNull();
    expect(
      readConversationRetentionDays({ conversationRetentionDays: MIN_CONVERSATION_RETENTION_DAYS - 1 }),
    ).toBeNull();
    expect(
      readConversationRetentionDays({ conversationRetentionDays: MAX_CONVERSATION_RETENTION_DAYS + 1 }),
    ).toBeNull();
  });

  it('accepts a period inside the guard rails', () => {
    expect(readConversationRetentionDays({ conversationRetentionDays: 365 })).toBe(365);
    expect(
      readConversationRetentionDays({ conversationRetentionDays: MIN_CONVERSATION_RETENTION_DAYS }),
    ).toBe(MIN_CONVERSATION_RETENTION_DAYS);
  });
});

describe('sweepConversationRetention', () => {
  it('deletes nothing when the tenant has not chosen a period', async () => {
    const tenant = await tenantWithRetention(null);
    const { session, message } = await seedConversation(tenant.id, 4000);

    const result = await sweepConversationRetention();

    expect(result.tenantsConsidered).toBe(0);
    expect(await exists('chat_sessions', session.id)).toBe(true);
    expect(await exists('messages', message.id)).toBe(true);
  });

  it('deletes a conversation idle past the period, with its messages and participants', async () => {
    const tenant = await tenantWithRetention(365);
    const { session, participant, message } = await seedConversation(tenant.id, 400);

    const result = await sweepConversationRetention();

    expect(result.sessionsDeleted).toBe(1);
    expect(result.messagesDeleted).toBe(1);
    expect(await exists('chat_sessions', session.id)).toBe(false);
    expect(await exists('messages', message.id)).toBe(false);
    expect(await exists('participants', participant.id)).toBe(false);
  });

  it('keeps a conversation inside the period', async () => {
    const tenant = await tenantWithRetention(365);
    const { session, message } = await seedConversation(tenant.id, 10);

    const result = await sweepConversationRetention();

    expect(result.sessionsDeleted).toBe(0);
    expect(await exists('chat_sessions', session.id)).toBe(true);
    expect(await exists('messages', message.id)).toBe(true);
  });

  it('deletes the judgment too — nothing cascades from chat_sessions to it', async () => {
    const tenant = await tenantWithRetention(365);
    const { session } = await seedConversation(tenant.id, 400);
    const judgmentId = await seedJudgment(tenant.id, session.id);

    const result = await sweepConversationRetention();

    expect(result.judgmentsDeleted).toBe(1);
    expect(await exists('chatbot_judgments', judgmentId)).toBe(false);
  });

  it('ignores an out-of-range stored period instead of deleting', async () => {
    const tenant = await tenantWithRetention(MIN_CONVERSATION_RETENTION_DAYS - 1);
    const { session } = await seedConversation(tenant.id, 4000);

    const result = await sweepConversationRetention();

    expect(result.tenantsConsidered).toBe(0);
    expect(await exists('chat_sessions', session.id)).toBe(true);
  });

  it('only sweeps the tenant that chose a period', async () => {
    const configured = await tenantWithRetention(365);
    const untouched = await tenantWithRetention(null);
    const old = await seedConversation(configured.id, 400);
    const other = await seedConversation(untouched.id, 400);

    await sweepConversationRetention();

    expect(await exists('chat_sessions', old.session.id)).toBe(false);
    expect(await exists('chat_sessions', other.session.id)).toBe(true);
  });

  it('caps the work per tenant per run and takes the OLDEST first', async () => {
    const tenant = await tenantWithRetention(365);
    const newest = await seedConversation(tenant.id, 400);
    const middle = await seedConversation(tenant.id, 500);
    const oldest = await seedConversation(tenant.id, 600);

    const result = await sweepConversationRetention({ batchLimit: 2 });

    expect(result.sessionsDeleted).toBe(2);
    expect(await exists('chat_sessions', oldest.session.id)).toBe(false);
    expect(await exists('chat_sessions', middle.session.id)).toBe(false);
    expect(await exists('chat_sessions', newest.session.id)).toBe(true);
  });

  it('tells the tenant once, with the counts', async () => {
    const tenant = await tenantWithRetention(365);
    await seedConversation(tenant.id, 400);
    await seedConversation(tenant.id, 500);

    await sweepConversationRetention();

    const forTenant = hooks.notifications.filter(
      (n) => (n as { tenantId: string }).tenantId === tenant.id,
    );
    expect(forTenant).toHaveLength(1);
    expect(forTenant[0]).toMatchObject({
      type: 'conversations_retention_applied',
      data: { sessionsDeleted: 2, retentionDays: 365 },
    });
  });
});
