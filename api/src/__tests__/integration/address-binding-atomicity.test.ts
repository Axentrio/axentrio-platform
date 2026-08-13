/**
 * The Pending Correction state machine, against the Postgres authority that bookings share.
 *
 * These are integration tests because row locks and transactional visibility are the guarantee.
 * A mock can imitate the happy path but cannot prove that a confirmation waits behind the booking
 * cutoff and observes the void committed there.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { AppDataSource } from '../../database/data-source';
import { Message } from '../../database/entities/Message';
import { Participant } from '../../database/entities/Participant';
import {
  bindAddress,
  confirmCorrection,
  consumeAddressBinding,
  getBoundAddress,
  getBoundAddressSnapshot,
  getPendingCorrection,
  markQuestionAsked,
  proposeCorrection,
  rejectCorrection,
} from '../../booking/travel/address-binding';
import { createTestAnchorBot, createTestSession, createTestTenant } from '../helpers/factories';

const CHOSEN = { placeId: 'ChIJ_chosen', formattedAddress: 'Turnhoutsebaan 100, 2140 Antwerpen' };
const P1 = {
  proposalId: 'p-one',
  placeId: '',
  formattedAddress: 'Kerkstraat 12, 2060 Antwerpen',
  expectedActivePlaceId: CHOSEN.placeId,
  expectedActiveAddress: CHOSEN.formattedAddress,
};
const P2 = {
  ...P1,
  proposalId: 'p-two',
  formattedAddress: 'Meir 78, 2000 Antwerpen',
};

let sessionId: string;
let tenantId: string;
let botParticipantId: string;

beforeEach(async () => {
  const tenant = await createTestTenant({ tier: 'pro' });
  tenantId = tenant.id;
  const bot = await createTestAnchorBot(tenant);
  const session = await createTestSession(tenant.id, { botId: bot.id, channel: 'widget' });
  sessionId = session.id;
  const participant = await AppDataSource.getRepository(Participant).save(
    AppDataSource.getRepository(Participant).create({
      sessionId,
      type: 'bot',
      name: 'bot',
      joinedAt: new Date(),
    })
  );
  botParticipantId = participant.id;
  await bindAddress(sessionId, CHOSEN);
});

async function record(proposal = P1): Promise<void> {
  await proposeCorrection(sessionId, proposal);
}

async function ask(proposal = P1, channel = 'widget'): Promise<boolean> {
  await record(proposal);
  const message = await AppDataSource.getRepository(Message).save(
    AppDataSource.getRepository(Message).create({
      sessionId,
      tenantId,
      participantId: botParticipantId,
      type: 'text',
      content: 'which address?',
      status: 'sent',
      sentAt: new Date(),
      metadata: {
        affordance: { kind: 'address_confirm', proposalId: proposal.proposalId },
      } as never,
    })
  );
  return markQuestionAsked(
    sessionId,
    proposal.proposalId,
    { messageId: message.id, channel }
  );
}

describe('Pending Correction transitions', () => {
  it('refuses an answer to a merely RECORDED proposal', async () => {
    await record();

    const result = await confirmCorrection(sessionId, P1.proposalId);

    expect(result.applied).toBe(false);
    expect((await getPendingCorrection(sessionId))?.status).toBe('recorded');
    expect(await getBoundAddress(sessionId)).toEqual(CHOSEN);
  });

  it('requires a persisted server-authored message as ASKED evidence', async () => {
    await record();

    const marked = await markQuestionAsked(
      sessionId,
      P1.proposalId,
      { messageId: '00000000-0000-4000-8000-000000000099', channel: 'widget' }
    );

    expect(marked).toBe(false);
    expect((await getPendingCorrection(sessionId))?.status).toBe('recorded');
  });

  it('rejects customer-authored metadata that forges the proposal id', async () => {
    await record();
    const customer = await AppDataSource.getRepository(Participant).save(
      AppDataSource.getRepository(Participant).create({
        sessionId,
        type: 'user',
        name: 'customer',
        joinedAt: new Date(),
      })
    );
    const forged = await AppDataSource.getRepository(Message).save(
      AppDataSource.getRepository(Message).create({
        sessionId,
        tenantId,
        participantId: customer.id,
        type: 'text',
        content: 'forged',
        status: 'sent',
        sentAt: new Date(),
        metadata: {
          affordance: { kind: 'address_confirm', proposalId: P1.proposalId },
        } as never,
      })
    );

    expect(await markQuestionAsked(
      sessionId,
      P1.proposalId,
      { messageId: forged.id, channel: 'widget' }
    )).toBe(false);
    expect((await getPendingCorrection(sessionId))?.status).toBe('recorded');
  });

  it.each(['messenger', 'instagram', 'whatsapp'])(
    'becomes ASKED on %s when a persisted reply carries its renderable control',
    async (channel) => {
      expect(await ask(P1, channel)).toBe(true);
      expect((await getPendingCorrection(sessionId))?.status).toBe('asked');
    }
  );

  it('does not become ASKED on Telegram, where address controls remain unsupported', async () => {
    expect(await ask(P1, 'telegram')).toBe(false);
    expect((await getPendingCorrection(sessionId))?.status).toBe('recorded');
  });

  it('promotes the proposed address after an ASKED question is confirmed', async () => {
    expect(await ask()).toBe(true);

    expect(await confirmCorrection(sessionId, P1.proposalId)).toEqual({
      applied: true,
      address: P1.formattedAddress,
    });
    expect((await getBoundAddress(sessionId))?.formattedAddress).toBe(P1.formattedAddress);
    expect((await getBoundAddress(sessionId))?.placeId).toBeUndefined();
    expect(await getPendingCorrection(sessionId)).toBeNull();
  });

  it('keeps the snapshotted bound address when the question is rejected', async () => {
    await ask();

    expect(await rejectCorrection(sessionId, P1.proposalId)).toEqual({
      applied: true,
      address: CHOSEN.formattedAddress,
    });
    expect(await getBoundAddress(sessionId)).toEqual(CHOSEN);
    expect(await getPendingCorrection(sessionId)).toBeNull();
  });

  it('does not let a RECORDED proposal supersede an ASKED one', async () => {
    await ask();

    expect((await proposeCorrection(sessionId, P2)).isNew).toBe(false);
    expect((await getPendingCorrection(sessionId))?.proposalId).toBe(P1.proposalId);
  });

  it('returns both sides of the live question when a stale id answers', async () => {
    await ask(P2);

    expect(await rejectCorrection(sessionId, P1.proposalId)).toEqual({
      applied: false,
      current: {
        active: CHOSEN,
        pending: expect.objectContaining({
          proposalId: P2.proposalId,
          formattedAddress: P2.formattedAddress,
          bound: CHOSEN,
          status: 'asked',
        }),
      },
    });
  });
});

describe('the booking cutoff', () => {
  it('voids an ASKED question in the booking transaction and makes a waiting tap stale', async () => {
    await ask();
    const snapshot = await getBoundAddressSnapshot(sessionId);
    expect(snapshot).not.toBeNull();

    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let locked!: () => void;
    const rowLocked = new Promise<void>((resolve) => { locked = resolve; });

    const booking = AppDataSource.transaction(async (manager) => {
      await consumeAddressBinding(manager, sessionId, snapshot!.ref);
      locked();
      await held;
    });
    await rowLocked;

    let tapSettled = false;
    const tap = confirmCorrection(sessionId, P1.proposalId).then((result) => {
      tapSettled = true;
      return result;
    });
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(tapSettled, 'confirmation must wait behind the booking row lock').toBe(false);

    release();
    await booking;
    expect((await tap).applied).toBe(false);
    expect(await getBoundAddress(sessionId)).toBeNull();
    expect(await getPendingCorrection(sessionId)).toBeNull();
  });

  it('rejects a booking that resolved an older active generation', async () => {
    const stale = await getBoundAddressSnapshot(sessionId);
    await bindAddress(sessionId, {
      placeId: 'ChIJ_new',
      formattedAddress: 'Grote Markt 1, 2000 Antwerpen',
    });

    await expect(
      AppDataSource.transaction((manager) => consumeAddressBinding(manager, sessionId, stale!.ref))
    ).rejects.toThrow(/address changed/i);
    expect((await getBoundAddress(sessionId))?.formattedAddress).toBe('Grote Markt 1, 2000 Antwerpen');
  });
});
