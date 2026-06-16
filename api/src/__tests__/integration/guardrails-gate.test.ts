import { describe, it, expect } from 'vitest';
import { AppDataSource } from '../../database/data-source';
import { ChatSession } from '../../database/entities/ChatSession';
import { Message } from '../../database/entities/Message';
import { SpamScamLog } from '../../database/entities/SpamScamLog';
import { runInboundGate } from '../../guardrails/inbound-guardrails.service';
import { createTestTenant, createTestSession, createTestParticipant, createTestMessage } from '../helpers/factories';

async function setup(enforce: boolean) {
  const tenant = await createTestTenant({ settings: enforce ? { guardrails: { enforce: true } } : {} });
  const session = await createTestSession(tenant.id, { status: 'bot' });
  const participant = await createTestParticipant(session.id, { type: 'user' });
  // Reload so DB defaults (ai_auto_reply_enabled=true, guardrail_status='normal') are populated.
  const reloaded = await AppDataSource.getRepository(ChatSession).findOneOrFail({ where: { id: session.id } });
  return { tenant, session: reloaded, participant };
}

const msgRepo = () => AppDataSource.getRepository(Message);
const sessionRepo = () => AppDataSource.getRepository(ChatSession);
const logRepo = () => AppDataSource.getRepository(SpamScamLog);

describe('guardrails · runInboundGate (integration)', () => {
  it('ENFORCE: blocks a phishing message — flags it, disables auto-reply, logs', async () => {
    const { tenant, session, participant } = await setup(true);
    const msg = await createTestMessage(session.id, tenant.id, participant.id, {
      content: 'Your account will be deleted. Verify your account here https://bit.ly/x',
    });

    const r = await runInboundGate({ session, tenantId: tenant.id, message: msg, content: msg.content, channel: 'messenger' });
    expect(r.proceed).toBe(false);

    const reloadedMsg = await msgRepo().findOneOrFail({ where: { id: msg.id } });
    expect(reloadedMsg.guardrailFlagged).toBe(true);

    const reloadedSession = await sessionRepo().findOneOrFail({ where: { id: session.id } });
    expect(reloadedSession.aiAutoReplyEnabled).toBe(false);
    expect(reloadedSession.guardrailStatus).not.toBe('normal');

    const logs = await logRepo().find({ where: { conversationId: session.id } });
    expect(logs.length).toBe(1);
    expect(logs[0].enforced).toBe(true);
    expect(logs[0].aiAutoReplyDisabled).toBe(true);
  });

  it('SHADOW: logs but does not block, flag, or disable', async () => {
    const { tenant, session, participant } = await setup(false);
    const msg = await createTestMessage(session.id, tenant.id, participant.id, {
      content: 'Guaranteed returns! Double your money with our crypto investment platform',
    });

    const r = await runInboundGate({ session, tenantId: tenant.id, message: msg, content: msg.content, channel: 'widget' });
    expect(r.proceed).toBe(true);

    const reloadedMsg = await msgRepo().findOneOrFail({ where: { id: msg.id } });
    expect(reloadedMsg.guardrailFlagged).toBe(false);

    const reloadedSession = await sessionRepo().findOneOrFail({ where: { id: session.id } });
    expect(reloadedSession.aiAutoReplyEnabled).toBe(true);

    const logs = await logRepo().find({ where: { conversationId: session.id } });
    expect(logs.length).toBe(1);
    expect(logs[0].enforced).toBe(false);
  });

  it('clean message: proceeds, nothing logged or changed', async () => {
    const { tenant, session, participant } = await setup(true);
    const msg = await createTestMessage(session.id, tenant.id, participant.id, {
      content: 'Hi, can I book a haircut for tomorrow afternoon?',
    });

    const r = await runInboundGate({ session, tenantId: tenant.id, message: msg, content: msg.content, channel: 'widget' });
    expect(r.proceed).toBe(true);

    const logs = await logRepo().find({ where: { conversationId: session.id } });
    expect(logs.length).toBe(0);
    const reloadedSession = await sessionRepo().findOneOrFail({ where: { id: session.id } });
    expect(reloadedSession.aiAutoReplyEnabled).toBe(true);
  });

  it('is idempotent (shadow): gating the same message twice logs once, never re-classifies', async () => {
    const { tenant, session, participant } = await setup(false);
    const msg = await createTestMessage(session.id, tenant.id, participant.id, {
      content: 'Best online casino bonus — free spins on our slots now',
    });
    const r1 = await runInboundGate({ session, tenantId: tenant.id, message: msg, content: msg.content, channel: 'widget' });
    const r2 = await runInboundGate({ session, tenantId: tenant.id, message: msg, content: msg.content, channel: 'widget' });
    expect(r1.proceed).toBe(true); // shadow always proceeds
    expect(r2.proceed).toBe(true);
    const logs = await logRepo().find({ where: { conversationId: session.id } });
    expect(logs.length).toBe(1); // claimed once → one detection event despite two calls
  });

  it('is idempotent (enforce): the second gate of a flagged message stays blocked, logs once', async () => {
    const { tenant, session, participant } = await setup(true);
    const msg = await createTestMessage(session.id, tenant.id, participant.id, {
      content: 'Please send me your password and the OTP code',
    });
    const r1 = await runInboundGate({ session, tenantId: tenant.id, message: msg, content: msg.content, channel: 'widget' });
    const r2 = await runInboundGate({ session, tenantId: tenant.id, message: msg, content: msg.content, channel: 'widget' });
    expect(r1.proceed).toBe(false);
    expect(r2.proceed).toBe(false);
    const logs = await logRepo().find({ where: { conversationId: session.id } });
    expect(logs.length).toBe(1);
  });

  it('ENFORCE: an already-disabled session fast-exits and flags the new message', async () => {
    const { tenant, session, participant } = await setup(true);
    await sessionRepo().update(session.id, { aiAutoReplyEnabled: false, guardrailStatus: 'spam' });
    const reloaded = await sessionRepo().findOneOrFail({ where: { id: session.id } });

    const msg = await createTestMessage(session.id, tenant.id, participant.id, { content: 'hello are you there' });
    const r = await runInboundGate({ session: reloaded, tenantId: tenant.id, message: msg, content: msg.content, channel: 'widget' });
    expect(r.proceed).toBe(false);

    const reloadedMsg = await msgRepo().findOneOrFail({ where: { id: msg.id } });
    expect(reloadedMsg.guardrailFlagged).toBe(true);
  });
});
