import { beforeEach, describe, expect, it, vi } from 'vitest';

const resolvePlaceId = vi.hoisted(() => vi.fn());
vi.mock('../../booking/travel/geocoding.service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../booking/travel/geocoding.service')>()),
  resolvePlaceId: (...args: unknown[]) => resolvePlaceId(...args),
}));

import { randomUUID } from 'crypto';
import { AppDataSource } from '../../database/data-source';
import { AddressOffer } from '../../database/entities/AddressOffer';
import { Message } from '../../database/entities/Message';
import { Participant } from '../../database/entities/Participant';
import {
  applyChannelAddressControl,
  addressConfirmPayload,
  addressPickerPayload,
} from '../../channels/address-controls';
import {
  bindAddress,
  getBoundAddress,
  markQuestionAsked,
  proposeCorrection,
} from '../../booking/travel/address-binding';
import { createTestAnchorBot, createTestSession, createTestTenant } from '../helpers/factories';

const PICKED = { placeId: 'ChIJ_picked', formattedAddress: 'Turnhoutsebaan 100, 2140 Antwerpen' };
const PROPOSED = 'Turnhoutsebaan 101, 2140 Antwerpen';
let sessionId: string;
let tenantId: string;
let botParticipantId: string;

beforeEach(async () => {
  vi.clearAllMocks();
  const tenant = await createTestTenant({ tier: 'pro' });
  tenantId = tenant.id;
  const bot = await createTestAnchorBot(tenant);
  const session = await createTestSession(tenant.id, { botId: bot.id, channel: 'messenger' });
  sessionId = session.id;
  const participant = await AppDataSource.getRepository(Participant).save(
    AppDataSource.getRepository(Participant).create({ sessionId, type: 'bot', name: 'bot', joinedAt: new Date() }),
  );
  botParticipantId = participant.id;
});

/** Seed one offer row, as the reply-persist transaction does in production. */
async function seedOffer(opts: { id: string; setId: string; placeId: string; expiresAt?: Date }): Promise<void> {
  await AppDataSource.getRepository(AddressOffer).insert({
    id: opts.id,
    setId: opts.setId,
    sessionId,
    channel: 'messenger',
    placeId: opts.placeId,
    expiresAt: opts.expiresAt ?? new Date(Date.now() + 35 * 60 * 1000),
    consumedAt: null,
  });
}

const tap = (token: string) =>
  applyChannelAddressControl(
    { type: 'postback', payload: addressPickerPayload(token) },
    { sessionId, tenantId, channel: 'messenger' },
  );

describe('server-observed Meta address actions', () => {
  describe('#97 D3 single-use offer', () => {
    it('binds a resolved place when the tapped token names a live offer', async () => {
      const token = randomUUID();
      await seedOffer({ id: token, setId: randomUUID(), placeId: PICKED.placeId });
      resolvePlaceId.mockResolvedValue({ status: 'placed', place: PICKED });

      expect(await tap(token)).toEqual({ handled: true, content: PICKED.formattedAddress });
      expect(await getBoundAddress(sessionId)).toEqual(PICKED);
    });

    it('consumes the whole set, so a second tap on a sibling does not move the binding', async () => {
      const setId = randomUUID();
      const tokenA = randomUUID();
      const tokenB = randomUUID();
      await seedOffer({ id: tokenA, setId, placeId: PICKED.placeId });
      await seedOffer({ id: tokenB, setId, placeId: 'ChIJ_sibling' });
      resolvePlaceId.mockResolvedValue({ status: 'placed', place: PICKED });

      expect(await tap(tokenA)).toEqual({ handled: true, content: PICKED.formattedAddress });
      expect(await getBoundAddress(sessionId)).toEqual(PICKED);

      // The sibling was consumed with the set; tapping it moves nothing.
      expect(await tap(tokenB)).toEqual({ handled: true });
      expect(await getBoundAddress(sessionId)).toEqual(PICKED);
    });

    it('a stale render token cannot consume a newer render of the same place', async () => {
      const set1 = randomUUID();
      const oldToken = randomUUID();
      const set2 = randomUUID();
      const newToken = randomUUID();
      await seedOffer({ id: oldToken, setId: set1, placeId: PICKED.placeId });
      await seedOffer({ id: newToken, setId: set2, placeId: PICKED.placeId });
      resolvePlaceId.mockResolvedValue({ status: 'placed', place: PICKED });

      expect(await tap(oldToken)).toEqual({ handled: true, content: PICKED.formattedAddress });
      // Re-tapping the old token is refused; the newer render's set is untouched.
      expect(await tap(oldToken)).toEqual({ handled: true });
      const set2Rows = await AppDataSource.getRepository(AddressOffer).find({ where: { setId: set2 } });
      expect(set2Rows.every((r) => r.consumedAt === null)).toBe(true);
    });

    it('refuses a malformed, unknown, or expired token and binds nothing', async () => {
      expect(await tap('not-a-uuid')).toEqual({ handled: true });
      expect(await tap(randomUUID())).toEqual({ handled: true });

      const expired = randomUUID();
      await seedOffer({ id: expired, setId: randomUUID(), placeId: PICKED.placeId, expiresAt: new Date(Date.now() - 1000) });
      expect(await tap(expired)).toEqual({ handled: true });

      expect(resolvePlaceId).not.toHaveBeenCalled();
      expect(await getBoundAddress(sessionId)).toBeNull();
    });
  });

  it('settles an ASKED Meta correction and returns the address actually committed', async () => {
    // address_confirm is the Pending Correction, not the picker, so the offer table does not touch it.
    await bindAddress(sessionId, PICKED);
    await proposeCorrection(sessionId, {
      proposalId: 'proposal-1',
      formattedAddress: PROPOSED,
      expectedActivePlaceId: PICKED.placeId,
      expectedActiveAddress: PICKED.formattedAddress,
    });
    const question = await AppDataSource.getRepository(Message).save(
      AppDataSource.getRepository(Message).create({
        sessionId,
        tenantId,
        participantId: botParticipantId,
        type: 'text',
        content: 'choose',
        status: 'sent',
        sentAt: new Date(),
        metadata: {
          affordance: { kind: 'address_confirm', proposalId: 'proposal-1', bound: PICKED.formattedAddress, proposed: PROPOSED },
        } as never,
      }),
    );
    expect(await markQuestionAsked(sessionId, 'proposal-1', { messageId: question.id, channel: 'messenger' })).toBe(true);

    const result = await applyChannelAddressControl(
      { type: 'postback', payload: addressConfirmPayload('proposal-1', 'proposed') },
      { sessionId, tenantId, channel: 'messenger' },
    );

    expect(result).toEqual({ handled: true, content: PROPOSED });
    expect((await getBoundAddress(sessionId))?.formattedAddress).toBe(PROPOSED);
  });
});
