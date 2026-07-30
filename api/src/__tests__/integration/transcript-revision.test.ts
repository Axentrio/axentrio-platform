/**
 * The transcript-revision trigger — R3's foundation.
 *
 * Enrichment's compare-and-swap is only as good as this counter. These tests prove
 * the counter moves on the three mutations a forward-only `(created_at, id)`
 * high-water mark cannot see: an EDIT and a DELETE, not just an insert.
 *
 * They also prove it holds for a RAW SQL writer, which is the reason it is a trigger
 * rather than application code — there are nine distinct message-writing call sites
 * and a TS-side bump would eventually be forgotten by one of them, silently.
 */
import { describe, it, expect } from 'vitest';
import { AppDataSource } from '../../database/data-source';
import { Message } from '../../database/entities/Message';
import { createTestTenant, createTestSession, createTestParticipant } from '../helpers/factories';

async function revision(sessionId: string): Promise<number> {
  const [row] = await AppDataSource.query(
    `SELECT transcript_revision AS r FROM chat_sessions WHERE id = $1`,
    [sessionId],
  );
  return Number(row.r);
}

async function seed() {
  const tenant = await createTestTenant({ tier: 'pro' });
  const session = await createTestSession(tenant.id);
  const participant = await createTestParticipant(session.id, { type: 'user' });
  return { tenant, session, participant };
}

describe('transcript_revision trigger', () => {
  it('starts at 0 and increments on INSERT', async () => {
    const { tenant, session, participant } = await seed();
    expect(await revision(session.id)).toBe(0);

    const repo = AppDataSource.getRepository(Message);
    await repo.save(
      repo.create({ sessionId: session.id, tenantId: tenant.id, participantId: participant.id, content: 'hello' }),
    );
    expect(await revision(session.id)).toBe(1);
  });

  it('increments on UPDATE — an EDITED message changes what the model would read', async () => {
    const { tenant, session, participant } = await seed();
    const repo = AppDataSource.getRepository(Message);
    const msg = await repo.save(
      repo.create({ sessionId: session.id, tenantId: tenant.id, participantId: participant.id, content: 'first' }),
    );
    const afterInsert = await revision(session.id);

    await repo.update(msg.id, { content: 'edited' });
    // This is the case a forward-only high-water mark is blind to.
    expect(await revision(session.id)).toBe(afterInsert + 1);
  });

  it('increments on DELETE — a removed message also changes the transcript', async () => {
    const { tenant, session, participant } = await seed();
    const repo = AppDataSource.getRepository(Message);
    const msg = await repo.save(
      repo.create({ sessionId: session.id, tenantId: tenant.id, participantId: participant.id, content: 'gone' }),
    );
    const afterInsert = await revision(session.id);

    await repo.delete(msg.id);
    expect(await revision(session.id)).toBe(afterInsert + 1);
  });

  it('fires for a RAW SQL writer too — the reason this is a trigger, not app code', async () => {
    const { tenant, session, participant } = await seed();
    const before = await revision(session.id);

    await AppDataSource.query(
      `INSERT INTO messages (session_id, tenant_id, participant_id, type, content, content_encrypted)
       VALUES ($1, $2, $3, 'text', 'raw insert', false)`,
      [session.id, tenant.id, participant.id],
    );
    expect(await revision(session.id)).toBe(before + 1);
  });

  it('is monotonic across many mutations and scoped to ONE session', async () => {
    const { tenant, session, participant } = await seed();
    const other = await createTestSession(tenant.id);
    const otherParticipant = await createTestParticipant(other.id, { type: 'user' });

    const repo = AppDataSource.getRepository(Message);
    for (let i = 0; i < 5; i++) {
      await repo.save(
        repo.create({ sessionId: session.id, tenantId: tenant.id, participantId: participant.id, content: `m${i}` }),
      );
    }
    await repo.save(
      repo.create({ sessionId: other.id, tenantId: tenant.id, participantId: otherParticipant.id, content: 'x' }),
    );

    expect(await revision(session.id)).toBe(5);
    expect(await revision(other.id)).toBe(1); // one session's churn never bumps another
  });

  it('leaves no phantom bump when the inserting transaction rolls back', async () => {
    // AFTER-trigger semantics: the bump is part of the same transaction, so a
    // rollback must undo it. Otherwise a failed write would invalidate a perfectly
    // good enrichment.
    const { tenant, session, participant } = await seed();
    const before = await revision(session.id);

    await expect(
      AppDataSource.transaction(async (manager) => {
        await manager.query(
          `INSERT INTO messages (session_id, tenant_id, participant_id, type, content, content_encrypted)
           VALUES ($1, $2, $3, 'text', 'doomed', false)`,
          [session.id, tenant.id, participant.id],
        );
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');

    expect(await revision(session.id)).toBe(before);
  });
});
