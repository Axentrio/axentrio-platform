/**
 * Boot-safety + correctness guard for RedactPickerOptionText (#98).
 *
 * Integration tests build their schema from synchronize(), not from migrations, so this is the only
 * place this migration's SQL runs against a real Postgres before it runs against prod on boot. It
 * pins the two properties that matter: the Google suggestion text is gone, and the {id, placeId}
 * evidence `offeredPlaceId` depends on survives. up() runs twice to prove boot-time idempotence.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { AppDataSource } from '../../database/data-source';
import { Message } from '../../database/entities/Message';
import { Participant } from '../../database/entities/Participant';
import { RedactPickerOptionText1790800000000 } from '../../database/migrations/1790800000000-RedactPickerOptionText';
import { createTestAnchorBot, createTestSession, createTestTenant } from '../helpers/factories';

describe('RedactPickerOptionText migration', () => {
  let sessionId: string;
  let tenantId: string;
  let botParticipantId: string;

  beforeEach(async () => {
    const tenant = await createTestTenant({ tier: 'pro' });
    tenantId = tenant.id;
    const bot = await createTestAnchorBot(tenant);
    const session = await createTestSession(tenant.id, { botId: bot.id, channel: 'messenger' });
    sessionId = session.id;
    const participant = await AppDataSource.getRepository(Participant).save(
      AppDataSource.getRepository(Participant).create({
        sessionId,
        type: 'bot',
        name: 'bot',
        joinedAt: new Date(),
      }),
    );
    botParticipantId = participant.id;
  });

  async function persistMetadata(affordance: Record<string, unknown>): Promise<string> {
    const saved = await AppDataSource.getRepository(Message).save(
      AppDataSource.getRepository(Message).create({
        sessionId,
        tenantId,
        participantId: botParticipantId,
        type: 'text',
        content: 'choose',
        status: 'sent',
        sentAt: new Date(),
        metadata: { affordance } as never,
      }),
    );
    return saved.id;
  }

  async function metadataOf(id: string): Promise<Record<string, any>> {
    const [row] = await AppDataSource.query(`SELECT metadata FROM messages WHERE id = $1`, [id]);
    return row.metadata;
  }

  async function runUp(): Promise<void> {
    const m = new RedactPickerOptionText1790800000000();
    const qr = AppDataSource.createQueryRunner();
    try {
      await qr.connect();
      await m.up(qr);
      await m.up(qr); // a second boot-time run must be a no-op (idempotent EXISTS guard).
    } finally {
      await qr.release();
    }
  }

  it('drops the suggestion text but keeps the {id, placeId} evidence, idempotently', async () => {
    const id = await persistMetadata({
      kind: 'address_picker',
      reason: 'unverified',
      query: 'Turnhoutsebaan',
      options: [
        { id: 'a1b2', placeId: 'ChIJ_one', text: 'Turnhoutsebaan 100, 2140 Antwerpen' },
        { id: 'c3d4', placeId: 'ChIJ_two', text: 'Turnhoutsebaan 101, 2140 Antwerpen' },
      ],
    });

    await runUp();

    const meta = await metadataOf(id);
    expect(meta.affordance.options).toEqual([
      { id: 'a1b2', placeId: 'ChIJ_one' },
      { id: 'c3d4', placeId: 'ChIJ_two' },
    ]);
    // No unselected Google address string survives anywhere in the row's metadata.
    expect(JSON.stringify(meta)).not.toContain('Turnhoutsebaan 100');
    // The rest of the affordance (kind, reason, the customer's own query) is untouched.
    expect(meta.affordance.kind).toBe('address_picker');
    expect(meta.affordance.reason).toBe('unverified');
  });

  it('leaves an address_confirm affordance untouched', async () => {
    const id = await persistMetadata({ kind: 'address_confirm', proposalId: 'p1', bound: 'A', proposed: 'B' });

    await runUp();

    expect((await metadataOf(id)).affordance).toEqual({
      kind: 'address_confirm',
      proposalId: 'p1',
      bound: 'A',
      proposed: 'B',
    });
  });

  it('down() refuses to run: deleted Google Content cannot be restored', async () => {
    const m = new RedactPickerOptionText1790800000000();
    await expect(m.down()).rejects.toThrow(/irreversible/i);
  });
});
