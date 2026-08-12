/**
 * "Was the question asked?" must mean a BOT reply, not any row that mentions it.
 *
 * The guard asked whether a message carrying this proposalId existed. `POST /widget/message`
 * accepts customer-supplied `metadata` and stores it verbatim (`widget.ts:453`), so a customer
 * could post `{affordance:{proposalId}}` and manufacture the evidence that they had already been
 * asked. `create_booking` would then proceed without asking - silently ignoring the correction
 * this whole feature exists to collect.
 *
 * The fourth guard in one session to name something ADJACENT to the real thing: proposals, then
 * claims, then agent runs, then "a message" where "a bot reply" was meant.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { AppDataSource } from '../../database/data-source';
import { questionWasAsked } from '../../booking/travel/question-delivery';
import { createTestTenant, createTestAnchorBot, createTestSession } from '../helpers/factories';
import { Participant } from '../../database/entities/Participant';
import { Message } from '../../database/entities/Message';

const PROPOSAL = 'deadbeefcafe0001';
let sessionId: string;
let tenantId: string;

async function addMessage(type: 'user' | 'bot', metadata: unknown) {
  const participant = await AppDataSource.getRepository(Participant).save(
    AppDataSource.getRepository(Participant).create({ sessionId, type, name: type, joinedAt: new Date() })
  );
  await AppDataSource.getRepository(Message).save(
    AppDataSource.getRepository(Message).create({
      sessionId, tenantId, participantId: participant.id,
      type: 'text', content: 'x', status: 'sent', sentAt: new Date(),
      metadata: metadata as never,
    })
  );
}

beforeEach(async () => {
  const tenant = await createTestTenant({ tier: 'pro' });
  const bot = await createTestAnchorBot(tenant);
  const session = await createTestSession(tenant.id, { botId: bot.id });
  sessionId = session.id;
  tenantId = tenant.id;
});

describe('questionWasAsked', () => {
  it('is false before anything has been said', async () => {
    expect(await questionWasAsked(AppDataSource, sessionId, PROPOSAL)).toBe(false);
  });

  it('is true once the BOT reply carrying the control exists', async () => {
    await addMessage('bot', { affordance: { kind: 'address_confirm', proposalId: PROPOSAL } });
    expect(await questionWasAsked(AppDataSource, sessionId, PROPOSAL)).toBe(true);
  });

  it('is NOT satisfied by a customer message claiming the same id', async () => {
    // The forgeable path. `/widget/message` stores whatever metadata the body carries.
    await addMessage('user', { affordance: { kind: 'address_confirm', proposalId: PROPOSAL } });
    expect(await questionWasAsked(AppDataSource, sessionId, PROPOSAL)).toBe(false);
  });

  it('does not confuse one proposal for another', async () => {
    await addMessage('bot', { affordance: { kind: 'address_confirm', proposalId: 'other' } });
    expect(await questionWasAsked(AppDataSource, sessionId, PROPOSAL)).toBe(false);
  });
});
