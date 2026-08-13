import { beforeEach, describe, expect, it, vi } from 'vitest';

const resolvePlaceId = vi.hoisted(() => vi.fn());
vi.mock('../../booking/travel/geocoding.service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../booking/travel/geocoding.service')>()),
  resolvePlaceId: (...args: unknown[]) => resolvePlaceId(...args),
}));

import { AppDataSource } from '../../database/data-source';
import { Message } from '../../database/entities/Message';
import { Participant } from '../../database/entities/Participant';
import {
  applyChannelAddressControl,
  addressConfirmPayload,
  addressOptionId,
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
    AppDataSource.getRepository(Participant).create({
      sessionId,
      type: 'bot',
      name: 'bot',
      joinedAt: new Date(),
    }),
  );
  botParticipantId = participant.id;
});

async function persistAffordance(affordance: Record<string, unknown>): Promise<Message> {
  return AppDataSource.getRepository(Message).save(
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
}

describe('server-observed Meta address actions', () => {
  it('binds a resolved place only when that option appeared in a persisted bot reply', async () => {
    const id = addressOptionId(PICKED.placeId);
    await persistAffordance({
      kind: 'address_picker',
      options: [{ id, placeId: PICKED.placeId, text: PICKED.formattedAddress }],
    });
    resolvePlaceId.mockResolvedValue({ status: 'placed', place: PICKED });

    const result = await applyChannelAddressControl(
      { type: 'postback', payload: addressPickerPayload(id) },
      { sessionId, tenantId, channel: 'messenger' },
    );

    expect(result).toEqual({ handled: true, content: PICKED.formattedAddress });
    expect(await getBoundAddress(sessionId)).toEqual(PICKED);
  });

  it('refuses a forged picker payload with no persisted server evidence', async () => {
    const result = await applyChannelAddressControl(
      { type: 'postback', payload: addressPickerPayload(addressOptionId('ChIJ_forged')) },
      { sessionId, tenantId, channel: 'messenger' },
    );

    expect(result).toEqual({ handled: true });
    expect(resolvePlaceId).not.toHaveBeenCalled();
    expect(await getBoundAddress(sessionId)).toBeNull();
  });

  it('settles an ASKED Meta correction and returns the address actually committed', async () => {
    await bindAddress(sessionId, PICKED);
    await proposeCorrection(sessionId, {
      proposalId: 'proposal-1',
      formattedAddress: PROPOSED,
      expectedActivePlaceId: PICKED.placeId,
      expectedActiveAddress: PICKED.formattedAddress,
    });
    const question = await persistAffordance({
      kind: 'address_confirm',
      proposalId: 'proposal-1',
      bound: PICKED.formattedAddress,
      proposed: PROPOSED,
    });
    expect(await markQuestionAsked(
      sessionId,
      'proposal-1',
      { messageId: question.id, channel: 'messenger' },
    )).toBe(true);

    const result = await applyChannelAddressControl(
      { type: 'postback', payload: addressConfirmPayload('proposal-1', 'proposed') },
      { sessionId, tenantId, channel: 'messenger' },
    );

    expect(result).toEqual({ handled: true, content: PROPOSED });
    expect((await getBoundAddress(sessionId))?.formattedAddress).toBe(PROPOSED);
  });
});
