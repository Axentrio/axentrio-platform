/**
 * #97 D1: a Meta address question becomes ASKED only after the provider accepts the reply.
 *
 * On the widget the persisted reply IS the delivery, so ASKED flips inside the persist transaction.
 * On Messenger/Instagram/WhatsApp a failed Send used to leave the question ASKED with nothing on the
 * customer's screen, and `create_booking` then booked the stale binding - #95 through a different
 * door. The flip now waits for a durable `MessageDelivery(status='sent')` row for the exact reply,
 * which is why the router's widget fallback (a Meta session with a null connection id, returning
 * success but writing no delivery row) leaves the question RECORDED.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { AppDataSource } from '../../database/data-source';
import { ChatSession } from '../../database/entities/ChatSession';
import type { ChannelType } from '../../database/entities/ChannelConnection';
import { Message } from '../../database/entities/Message';
import { MessageDelivery } from '../../database/entities/MessageDelivery';
import { Participant } from '../../database/entities/Participant';
import {
  deliveryIsPersistence,
  markAddressQuestionAskedAfterDelivery,
} from '../../services/message-forwarding.service';
import { bindAddress, getPendingCorrection, proposeCorrection } from '../../booking/travel/address-binding';
import { createTestAnchorBot, createTestSession, createTestTenant } from '../helpers/factories';

const CHOSEN = { placeId: 'ChIJ_chosen', formattedAddress: 'Turnhoutsebaan 100, 2140 Antwerpen' };
const PROPOSED = 'Kerkstraat 12, 2060 Antwerpen';
const PROPOSAL = 'proposal-d1';
const CONFIRM_EXTRAS = { affordance: { kind: 'address_confirm' as const, proposalId: PROPOSAL, bound: CHOSEN.formattedAddress, proposed: PROPOSED } };

let sessionId: string;
let tenantId: string;
let botParticipantId: string;

/** Create the session row + a RECORDED question about the CHOSEN binding on the given channel. */
async function setup(channel: ChannelType): Promise<ChatSession> {
  const tenant = await createTestTenant({ tier: 'pro' });
  tenantId = tenant.id;
  const bot = await createTestAnchorBot(tenant);
  const session = await createTestSession(tenant.id, { botId: bot.id, channel });
  sessionId = session.id;
  const participant = await AppDataSource.getRepository(Participant).save(
    AppDataSource.getRepository(Participant).create({ sessionId, type: 'bot', name: 'bot', joinedAt: new Date() }),
  );
  botParticipantId = participant.id;
  await bindAddress(sessionId, CHOSEN);
  await proposeCorrection(sessionId, {
    proposalId: PROPOSAL,
    formattedAddress: PROPOSED,
    expectedActivePlaceId: CHOSEN.placeId,
    expectedActiveAddress: CHOSEN.formattedAddress,
  });
  // markAddressQuestionAskedAfterDelivery only reads session.id and session.channel.
  return { id: sessionId, channel } as unknown as ChatSession;
}

/** Persist the bot reply that carries the confirm control, as the reply path does. */
async function persistConfirmReply(): Promise<string> {
  const msg = await AppDataSource.getRepository(Message).save(
    AppDataSource.getRepository(Message).create({
      sessionId,
      tenantId,
      participantId: botParticipantId,
      type: 'text',
      content: 'which address?',
      status: 'sent',
      sentAt: new Date(),
      metadata: { affordance: { kind: 'address_confirm', proposalId: PROPOSAL } } as never,
    }),
  );
  return msg.id;
}

async function recordDelivery(messageId: string, status: 'sent' | 'failed'): Promise<void> {
  await AppDataSource.getRepository(MessageDelivery).save(
    AppDataSource.getRepository(MessageDelivery).create({
      internalMessageId: messageId,
      channelConnectionId: '00000000-0000-4000-8000-000000000000',
      channel: 'messenger',
      status,
      attempts: 1,
    }),
  );
}

const statusOf = async () => (await getPendingCorrection(sessionId))?.status;

beforeEach(() => {
  // Each test builds its own session on its own channel.
});

describe('#97 D1 deliver-then-ask', () => {
  it('flips a Meta question to ASKED once a delivery row proves the provider accepted the reply', async () => {
    const session = await setup('messenger');
    const msgId = await persistConfirmReply();
    await recordDelivery(msgId, 'sent');
    expect(await statusOf()).toBe('recorded');

    await markAddressQuestionAskedAfterDelivery(session, msgId, CONFIRM_EXTRAS);

    expect(await statusOf()).toBe('asked');
  });

  it('leaves a Meta question RECORDED when no delivery row exists (a failed Send)', async () => {
    const session = await setup('messenger');
    const msgId = await persistConfirmReply();
    // No MessageDelivery row: the Send failed, or the router's widget fallback wrote none.

    await markAddressQuestionAskedAfterDelivery(session, msgId, CONFIRM_EXTRAS);

    expect(await statusOf()).toBe('recorded');
  });

  it('leaves a Meta question RECORDED when the delivery row is failed', async () => {
    const session = await setup('instagram');
    const msgId = await persistConfirmReply();
    await recordDelivery(msgId, 'failed');

    await markAddressQuestionAskedAfterDelivery(session, msgId, CONFIRM_EXTRAS);

    expect(await statusOf()).toBe('recorded');
  });

  it('is a no-op on the widget, whose ASKED flip happens at persist time instead', async () => {
    const session = await setup('widget');
    const msgId = await persistConfirmReply();
    await recordDelivery(msgId, 'sent'); // even with a row present

    await markAddressQuestionAskedAfterDelivery(session, msgId, CONFIRM_EXTRAS);

    expect(await statusOf()).toBe('recorded');
  });

  describe('deliveryIsPersistence', () => {
    it('is true only for the explicit widget channel', () => {
      expect(deliveryIsPersistence({ channel: 'widget' })).toBe(true);
      for (const c of ['messenger', 'instagram', 'whatsapp', 'telegram']) {
        expect(deliveryIsPersistence({ channel: c })).toBe(false);
      }
      expect(deliveryIsPersistence({ channel: null })).toBe(false);
      expect(deliveryIsPersistence({})).toBe(false);
    });
  });
});
