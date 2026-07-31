/**
 * The enrichment sweep against the real DB — claim-lease, quiescence, and the
 * compare-and-swap commit.
 *
 * The CAS is the load-bearing claim of Release B: if the transcript changes while the
 * model is running, the write MUST be refused rather than persisting a reading of a
 * conversation that no longer exists. Proving that needs a real Postgres, because the
 * revision is maintained by a trigger and the swap happens inside the UPDATE.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const llm = vi.hoisted(() => ({
  response: {} as Record<string, unknown>,
  calls: 0,
  /** Fires while the model is "thinking", to mutate the transcript mid-extraction. */
  onCall: null as null | (() => Promise<void>),
}));

vi.mock('../../llm/provider-factory', () => ({
  getProvider: () => ({
    chat: async () => {
      llm.calls += 1;
      if (llm.onCall) await llm.onCall();
      return {
        content: JSON.stringify(llm.response),
        usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 },
      };
    },
  }),
}));

import { AppDataSource } from '../../database/data-source';
import { Lead } from '../../database/entities/Lead';
import { Message } from '../../database/entities/Message';
import { LeadConversation } from '../../database/entities/LeadConversation';
import { runLeadEnrichmentSweep } from '../../leads/enrichment/enrich-lead.job';
import { createTestTenant, createTestSession, createTestParticipant } from '../helpers/factories';

/** Backdate every message so the conversation reads as quiet (>20m). */
async function makeQuiet(sessionId: string, minutes = 40) {
  await AppDataSource.query(
    `UPDATE messages SET created_at = now() - ($2 || ' minutes')::interval WHERE session_id = $1`,
    [sessionId, String(minutes)],
  );
}

async function scenario(opts: { quiet?: boolean; content?: string } = {}) {
  const tenant = await createTestTenant({ tier: 'pro' });
  const session = await createTestSession(tenant.id);
  const participant = await createTestParticipant(session.id, { type: 'user' });

  const msgRepo = AppDataSource.getRepository(Message);
  await msgRepo.save(
    msgRepo.create({
      sessionId: session.id,
      tenantId: tenant.id,
      participantId: participant.id,
      content: opts.content ?? 'My kitchen sink is completely blocked, can someone come tomorrow?',
    }),
  );

  const leadRepo = AppDataSource.getRepository(Lead);
  const lead = await leadRepo.save(
    leadRepo.create({
      tenantId: tenant.id,
      email: `x${Math.random().toString(36).slice(2, 8)}@example.com`,
      dedupeKey: `email:x${Math.random().toString(36).slice(2, 8)}@example.com`,
      source: 'tool',
    }),
  );
  const convRepo = AppDataSource.getRepository(LeadConversation);
  const conv = await convRepo.save(
    convRepo.create({
      tenantId: tenant.id,
      leadId: lead.id,
      sessionId: session.id,
      enrichState: 'pending',
    }),
  );

  if (opts.quiet !== false) await makeQuiet(session.id);
  return { tenant, session, participant, lead, conv };
}

async function reload(id: string) {
  return AppDataSource.getRepository(LeadConversation).findOneOrFail({ where: { id } });
}

beforeEach(() => {
  llm.calls = 0;
  llm.onCall = null;
  llm.response = {};
});

describe('enrichment sweep — eligibility', () => {
  it('skips a conversation that is still active (not quiet yet)', async () => {
    const { conv } = await scenario({ quiet: false });
    const res = await runLeadEnrichmentSweep();
    expect(res.processed).toBe(0);
    expect(llm.calls).toBe(0);
    expect((await reload(conv.id)).enrichState).toBe('pending');
  });

  it('processes a quiet conversation regardless of session status (agent-held sessions stay `active` forever)', async () => {
    const { conv, session } = await scenario();
    await AppDataSource.query(`UPDATE chat_sessions SET status = 'active' WHERE id = $1`, [session.id]);

    llm.response = {
      request: {
        value: 'My kitchen sink is completely blocked',
        evidenceMessageId: (await AppDataSource.query(
          `SELECT id FROM messages WHERE session_id = $1 LIMIT 1`,
          [session.id],
        ))[0].id,
        span: 'kitchen sink is completely blocked',
      },
    };

    const res = await runLeadEnrichmentSweep();
    expect(res.processed).toBe(1);
    const after = await reload(conv.id);
    expect(after.enrichState).toBe('enriched');
    expect(after.request).toBe('My kitchen sink is completely blocked');
  });
});

describe('enrichment sweep — compare-and-swap on the transcript revision', () => {
  it('REFUSES the write when a message arrives mid-extraction, and requeues', async () => {
    const { conv, session, tenant, participant } = await scenario();
    const msgId = (
      await AppDataSource.query(`SELECT id FROM messages WHERE session_id = $1 LIMIT 1`, [session.id])
    )[0].id;
    llm.response = {
      request: { value: 'My kitchen sink is completely blocked', evidenceMessageId: msgId, span: 'kitchen sink' },
    };

    // While the "model" is running, the customer sends another message. The trigger
    // bumps transcript_revision, so the reading we are about to commit is stale.
    llm.onCall = async () => {
      const repo = AppDataSource.getRepository(Message);
      await repo.save(
        repo.create({
          sessionId: session.id,
          tenantId: tenant.id,
          participantId: participant.id,
          content: 'Actually the bathroom is flooding too — this is an emergency!',
        }),
      );
    };

    await runLeadEnrichmentSweep();

    const after = await reload(conv.id);
    // Nothing persisted…
    expect(after.request).toBeNull();
    expect(after.enrichedRevision).toBeNull();
    // …and it is queued to run again against the NEW transcript.
    expect(after.enrichState).toBe('failed');
    expect(after.enrichAttempts).toBe(1);
    expect(after.enrichNextAttemptAt).not.toBeNull();
    expect(after.enrichLastError).toMatch(/revision changed/i);
  });

  it('REFUSES the write when a message is EDITED mid-extraction (a high-water mark misses this)', async () => {
    const { conv, session } = await scenario();
    const msgId = (
      await AppDataSource.query(`SELECT id FROM messages WHERE session_id = $1 LIMIT 1`, [session.id])
    )[0].id;
    llm.response = {
      request: { value: 'My kitchen sink is completely blocked', evidenceMessageId: msgId, span: 'kitchen sink' },
    };
    llm.onCall = async () => {
      await AppDataSource.query(`UPDATE messages SET content = 'edited content' WHERE id = $1`, [msgId]);
    };

    await runLeadEnrichmentSweep();
    const after = await reload(conv.id);
    expect(after.request).toBeNull();
    expect(after.enrichState).toBe('failed');
  });

  it('records the revision it enriched against on a clean run', async () => {
    const { conv, session } = await scenario();
    const msgId = (
      await AppDataSource.query(`SELECT id FROM messages WHERE session_id = $1 LIMIT 1`, [session.id])
    )[0].id;
    llm.response = {
      request: { value: 'My kitchen sink is completely blocked', evidenceMessageId: msgId, span: 'kitchen sink' },
    };

    await runLeadEnrichmentSweep();
    const after = await reload(conv.id);
    const [{ r }] = await AppDataSource.query(
      `SELECT transcript_revision AS r FROM chat_sessions WHERE id = $1`,
      [session.id],
    );
    expect(after.enrichedRevision).toBe(Number(r));
  });
});

describe('enrichment sweep — abstention and grounding are enforced end to end', () => {
  it('marks a conversation ABSTAINED rather than storing an ungrounded value', async () => {
    const { conv } = await scenario();
    // A confident, entirely invented address with a fabricated citation.
    llm.response = {
      address: { value: 'Veldstraat 4, Ghent', evidenceMessageId: 'not-a-real-id', span: 'Veldstraat 4' },
    };

    await runLeadEnrichmentSweep();
    const after = await reload(conv.id);
    expect(after.enrichState).toBe('abstained');
    expect(after.address).toBeNull();
    expect(after.evidence).toEqual([]);
  });

  it('does not persist special-category data even when grounded', async () => {
    const { conv, session } = await scenario({
      content: 'I am diabetic so I need an early morning slot please',
    });
    const msgId = (
      await AppDataSource.query(`SELECT id FROM messages WHERE session_id = $1 LIMIT 1`, [session.id])
    )[0].id;
    llm.response = {
      request: { value: 'I am diabetic so I need an early morning slot', evidenceMessageId: msgId, span: 'I am diabetic' },
    };

    await runLeadEnrichmentSweep();
    const after = await reload(conv.id);
    expect(after.request).toBeNull();
    expect(after.enrichState).toBe('abstained');
  });

  it('does not claim the same row twice (lease) and never re-enriches a finished one', async () => {
    const { conv, session } = await scenario();
    const msgId = (
      await AppDataSource.query(`SELECT id FROM messages WHERE session_id = $1 LIMIT 1`, [session.id])
    )[0].id;
    llm.response = {
      request: { value: 'My kitchen sink is completely blocked', evidenceMessageId: msgId, span: 'kitchen sink' },
    };

    await runLeadEnrichmentSweep();
    expect((await reload(conv.id)).enrichState).toBe('enriched');

    const callsAfterFirst = llm.calls;
    await runLeadEnrichmentSweep(); // second tick
    expect(llm.calls).toBe(callsAfterFirst); // no repeat spend
  });

  it('never picks up an ERASED conversation — erasure is terminal', async () => {
    const { conv } = await scenario();
    await AppDataSource.query(
      `UPDATE chatbot_lead_conversations SET enrich_state = 'erased' WHERE id = $1`,
      [conv.id],
    );
    await runLeadEnrichmentSweep();
    expect(llm.calls).toBe(0);
    expect((await reload(conv.id)).enrichState).toBe('erased');
  });
});
