import { beforeEach, describe, it, expect, vi } from 'vitest';
import Redis from 'ioredis';
import { AppDataSource } from '../../database/data-source';
import { ChatSession } from '../../database/entities/ChatSession';
import { Message } from '../../database/entities/Message';
import { SpamScamLog } from '../../database/entities/SpamScamLog';
import {
  runInboundGate,
  SOLICITATION_WARN_REPLIES,
  SOLICITATION_WARN_REPLY,
} from '../../guardrails/inbound-guardrails.service';
import { redisLoopStore } from '../../guardrails/loop-store';
import { createTestTenant, createTestSession, createTestParticipant, createTestMessage } from '../helpers/factories';

const loopStates = vi.hoisted(() => new Map<string, {
  lastHash?: string;
  repeated: number;
  botLike: number;
  suspiciousLinkTurns: number;
}>());

const redisBridge = vi.hoisted(() => ({
  evalOverride: undefined as undefined | ((
    script: string,
    keyCount: number,
    ...args: string[]
  ) => Promise<unknown>),
}));

const redis = vi.hoisted(() => ({
  eval: async (
    script: string,
    keyCount: number,
    key: string,
    hash: string,
    meaningfulArg: string,
    humanArg: string,
    linkArg: string,
    ttlArg: string,
  ) => {
    if (redisBridge.evalOverride) {
      return redisBridge.evalOverride(
        script, keyCount, key, hash, meaningfulArg, humanArg, linkArg, ttlArg,
      );
    }
    const prev = loopStates.get(key) ?? { repeated: 0, botLike: 0, suspiciousLinkTurns: 0 };
    const meaningful = meaningfulArg === '1';
    const human = humanArg === '1';
    const isRepeat = hash === prev.lastHash;
    const repeated = human ? 0 : isRepeat && meaningful ? prev.repeated + 1 : meaningful ? 1 : 0;
    const botLike = human ? 0 : isRepeat || !meaningful ? prev.botLike + 1 : 0;
    const suspiciousLinkTurns = prev.suspiciousLinkTurns + (linkArg === '1' ? 1 : 0);
    loopStates.set(key, { lastHash: hash, repeated, botLike, suspiciousLinkTurns });
    return [repeated, botLike, suspiciousLinkTurns];
  },
  del: async (key: string) => Number(loopStates.delete(key)),
}));

vi.mock('../../config/redis', () => ({ getRedisClient: () => redis }));

async function setup(enforce: boolean, language?: string) {
  const settings = {
    ...(enforce ? { guardrails: { enforce: true } } : {}),
    ...(language ? {
      onboarding: {
        version: 1,
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        language,
        company: null,
        steps: {},
      },
    } : {}),
  };
  const tenant = await createTestTenant({ settings: settings as never });
  const session = await createTestSession(tenant.id, { status: 'bot' });
  const participant = await createTestParticipant(session.id, { type: 'user' });
  // Reload so DB defaults (ai_auto_reply_enabled=true, guardrail_status='normal') are populated.
  const reloaded = await AppDataSource.getRepository(ChatSession).findOneOrFail({ where: { id: session.id } });
  return { tenant, session: reloaded, participant };
}

const msgRepo = () => AppDataSource.getRepository(Message);
const sessionRepo = () => AppDataSource.getRepository(ChatSession);
const logRepo = () => AppDataSource.getRepository(SpamScamLog);

async function runEnforcedTurns(contents: string[], channel = 'widget') {
  const { tenant, session, participant } = await setup(true);
  const results = [];
  for (const content of contents) {
    const message = await createTestMessage(session.id, tenant.id, participant.id, { content });
    results.push(await runInboundGate({
      session, tenantId: tenant.id, message, content, channel,
    }));
  }
  return { results, sessionId: session.id };
}

describe('guardrails · runInboundGate (integration)', () => {
  beforeEach(() => {
    loopStates.clear();
    redisBridge.evalOverride = undefined;
  });

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
    expect(logs[0].action).toBe('blocked');
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

  it('ENFORCE: warns on solicitation without flagging, pausing, or notifying', async () => {
    const { tenant, session, participant } = await setup(true);
    const msg = await createTestMessage(session.id, tenant.id, participant.id, {
      content: 'Hi, I came across your business and we offer SEO and web design to boost your sales',
    });

    const r = await runInboundGate({
      session, tenantId: tenant.id, message: msg, content: msg.content, channel: 'messenger',
    });
    expect(r).toEqual({
      proceed: true,
      category: 'solicitation',
      replyOverride: SOLICITATION_WARN_REPLY,
    });

    const reloadedMsg = await msgRepo().findOneOrFail({ where: { id: msg.id } });
    expect(reloadedMsg.guardrailFlagged).toBe(false);

    const reloadedSession = await sessionRepo().findOneOrFail({ where: { id: session.id } });
    expect(reloadedSession.aiAutoReplyEnabled).toBe(true);
    expect(reloadedSession.guardrailStatus).toBe('normal');

    const logs = await logRepo().find({ where: { conversationId: session.id } });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      detectedCategory: 'solicitation',
      enforced: false,
      action: 'warn_reply',
      aiAutoReplyDisabled: false,
      notificationSent: false,
    });
  });

  it('ENFORCE: blocks solicitation that also harvests credentials', async () => {
    const { tenant, session, participant } = await setup(true);
    const msg = await createTestMessage(session.id, tenant.id, participant.id, {
      content: 'We offer SEO services to grow your business. Please send me your password.',
    });

    const r = await runInboundGate({
      session, tenantId: tenant.id, message: msg, content: msg.content, channel: 'messenger',
    });

    expect(r.proceed).toBe(false);
    expect((await msgRepo().findOneOrFail({ where: { id: msg.id } })).guardrailFlagged).toBe(true);
    expect((await sessionRepo().findOneOrFail({ where: { id: session.id } })).aiAutoReplyEnabled).toBe(false);
  });

  it('SHADOW: solicitation remains log-only without a reply override', async () => {
    const { tenant, session, participant } = await setup(false);
    const msg = await createTestMessage(session.id, tenant.id, participant.id, {
      content: 'We offer SEO services to grow your business',
    });

    const input = {
      session, tenantId: tenant.id, message: msg, content: msg.content, channel: 'messenger',
    };
    expect(await runInboundGate(input)).toEqual({ proceed: true, category: 'clean' });
    expect(await runInboundGate(input)).toEqual({ proceed: true, category: 'clean' });

    const logs = await logRepo().find({ where: { conversationId: session.id } });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      detectedCategory: 'solicitation',
      enforced: false,
      action: 'log_only',
      aiAutoReplyDisabled: false,
      notificationSent: false,
    });
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

  describe('review scenarios', () => {
    it.each([
      { name: 'Hello? ×3', sequences: [Array(3).fill('Hello?')] },
      { name: 'Are you there?', sequences: [Array(3).fill('Are you there?')] },
      { name: 'punctuation only', sequences: [Array(3).fill('???')] },
      { name: 'Price?', sequences: [Array(3).fill('Price?')] },
      { name: 'fragments', sequences: [['Kitchen', 'Leak', 'Upstairs']] },
      {
        name: 'duplicate send',
        sequences: [Array(2).fill('Please send the quote again when you can')],
      },
      {
        name: 'repeated addresses',
        sequences: [
          Array(3).fill('12 Rue de la Loi'),
          Array(3).fill('12 Main Street'),
        ],
      },
      {
        name: 'Why is nobody answering?',
        sequences: [Array(3).fill('Why is nobody answering?')],
      },
      { name: 'emoji only', sequences: [Array(3).fill('👋')] },
      {
        name: 'ordinary link alone',
        sequences: [Array(3).fill('https://example.com/product/123')],
      },
      { name: 'test', sequences: [Array(3).fill('test')] },
      { name: 'who are you', sequences: [Array(3).fill('Who are you?')] },
    ])('passes human scenario: $name', async ({ sequences }) => {
      for (const contents of sequences) {
        const { results, sessionId } = await runEnforcedTurns(contents);
        expect(results.every(({ proceed, category }) => proceed && category === 'clean')).toBe(true);
        expect((await sessionRepo().findOneOrFail({ where: { id: sessionId } })).aiAutoReplyEnabled).toBe(true);
        expect(await logRepo().count({ where: { conversationId: sessionId } })).toBe(0);
      }
    });

    it.each([
      {
        name: 'fake Meta warning plus suspicious link',
        contents: ['Meta support: your page will be deleted. Verify your account https://bit.ly/x'],
        channel: 'messenger',
        proceeds: [false],
        category: 'phishing',
      },
      {
        name: 'repeated solicitation becomes a bot loop',
        contents: Array(5).fill('We offer SEO services to grow your business'),
        channel: 'messenger',
        proceeds: [true, true, true, true, false],
        category: 'bot_loop',
      },
      {
        name: 'password request',
        contents: ['Please send me your password and the OTP code'],
        proceeds: [false],
        category: 'phishing',
      },
      {
        name: 'repeated promo plus the same weak-risk link',
        contents: Array(2).fill('Promo https://bit.ly/x'),
        proceeds: [true, false],
        category: 'bot_loop',
        suspiciousLinkTurns: 2,
      },
      {
        name: 'generic automated reply ×3',
        contents: Array(3).fill(
          'Your request has been received, a representative will contact you shortly',
        ),
        proceeds: [true, true, false],
        category: 'bot_loop',
      },
      {
        name: 'two-bot alternation',
        contents: Array(3).fill(
          'Thank you for contacting Example Support. How may I assist you today?',
        ),
        proceeds: [true, true, false],
        category: 'bot_loop',
      },
    ])('blocks abusive scenario: $name', async ({
      contents, channel = 'widget', proceeds, category, suspiciousLinkTurns,
    }) => {
      const { results, sessionId } = await runEnforcedTurns(contents, channel);
      expect(results.map(({ proceed }) => proceed)).toEqual(proceeds);
      expect(results.at(-1)?.category).toBe(category);
      if (suspiciousLinkTurns !== undefined) {
        expect(loopStates.get(`gr:loop:${sessionId}`)?.suspiciousLinkTurns).toBe(suspiciousLinkTurns);
      }
    });
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

  it('is idempotent (enforce): a stale solicitation retry keeps the neutral outcome', async () => {
    const { tenant, session, participant } = await setup(true);
    const msg = await createTestMessage(session.id, tenant.id, participant.id, {
      content: 'We offer SEO services to grow your business',
    });

    const input = {
      session, tenantId: tenant.id, message: msg, content: msg.content, channel: 'messenger',
    };
    const expected = {
      proceed: true,
      category: 'solicitation',
      replyOverride: SOLICITATION_WARN_REPLY,
    };

    expect(await runInboundGate(input)).toEqual(expected);
    expect(await runInboundGate(input)).toEqual(expected);
    expect(await logRepo().count({ where: { conversationId: session.id } })).toBe(1);
  });

  // Regression: a clean message writes no outcome row on purpose, so re-gating
  // it (runTurn re-gates its whole window, and a 'stale' turn leaves the
  // watermark unmoved) used to fall through to a hard block and froze the
  // conversation for good.
  it('re-gates an already-claimed clean message from its content and proceeds', async () => {
    const { tenant, session, participant } = await setup(true);
    const msg = await createTestMessage(session.id, tenant.id, participant.id, {
      content: 'Hi, can I book tomorrow?',
    });
    await msgRepo().update(msg.id, { guardrailChecked: true });

    expect(await runInboundGate({
      session, tenantId: tenant.id, message: msg, content: msg.content, channel: 'widget',
    })).toEqual({ proceed: true, category: 'clean' });

    // The replay must not flag the message or write a second log row.
    expect((await msgRepo().findOneOrFail({ where: { id: msg.id } })).guardrailFlagged).toBe(false);
    expect(await logRepo().count({ where: { conversationId: session.id } })).toBe(0);
  });

  it('ENFORCE: still blocks a claimed message without an outcome when the content is malicious', async () => {
    const { tenant, session, participant } = await setup(true);
    const msg = await createTestMessage(session.id, tenant.id, participant.id, {
      content: 'Your account will be deleted. Verify your account here https://bit.ly/x',
    });
    await msgRepo().update(msg.id, { guardrailChecked: true });

    const r = await runInboundGate({
      session, tenantId: tenant.id, message: msg, content: msg.content, channel: 'messenger',
    });
    expect(r.proceed).toBe(false);
    expect(r.category).not.toBe('clean');
  });

  it('SHADOW: a claimed message without an outcome never blocks', async () => {
    const { tenant, session, participant } = await setup(false);
    const msg = await createTestMessage(session.id, tenant.id, participant.id, {
      content: 'Guaranteed returns! Double your money with our crypto investment platform',
    });
    await msgRepo().update(msg.id, { guardrailChecked: true });

    expect(await runInboundGate({
      session, tenantId: tenant.id, message: msg, content: msg.content, channel: 'widget',
    })).toEqual({ proceed: true, category: 'clean' });
  });

  it.each([
    ['nl', SOLICITATION_WARN_REPLIES.nl],
    ['fr', SOLICITATION_WARN_REPLIES.fr],
    ['de', SOLICITATION_WARN_REPLIES.en],
  ])('uses the tenant language for a solicitation warning (%s)', async (language, reply) => {
    const { tenant, session, participant } = await setup(true, language);
    const msg = await createTestMessage(session.id, tenant.id, participant.id, {
      content: 'We offer SEO services to grow your business',
    });

    const result = await runInboundGate({
      session, tenantId: tenant.id, message: msg, content: msg.content, channel: 'messenger',
    });
    expect(result.replyOverride).toBe(reply);
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

describe('guardrails · redisLoopStore Lua', () => {
  it('executes the atomic reducer script in Redis', async () => {
    const url = process.env.TEST_REDIS_URL ?? 'redis://localhost:6380';
    const client = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 2 });
    const sessionId = `lua-${process.env.TEST_RUN_ID ?? process.pid}`;
    const redisKey = `gr:loop:${sessionId}`;

    try {
      await client.connect();
      await client.ping();
    } catch (error) {
      client.disconnect();
      throw new Error(
        `guardrails Lua test needs Redis at ${url}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    redisBridge.evalOverride = (script, keyCount, ...args) =>
      client.eval(script, keyCount, ...args);
    try {
      await client.del(redisKey);
      const first = await redisLoopStore.advance(sessionId, {
        hash: 'promo',
        meaningful: true,
        humanSignal: false,
        hasSuspiciousLink: true,
      });
      const second = await redisLoopStore.advance(sessionId, {
        hash: 'promo',
        meaningful: true,
        humanSignal: false,
        hasSuspiciousLink: true,
      });
      const reset = await redisLoopStore.advance(sessionId, {
        hash: 'hello',
        meaningful: false,
        humanSignal: true,
        hasSuspiciousLink: false,
      });

      expect(first).toMatchObject({ repeated: 1, botLike: 0, suspiciousLinkTurns: 1 });
      expect(second).toMatchObject({ repeated: 2, botLike: 1, suspiciousLinkTurns: 2 });
      expect(reset).toMatchObject({ repeated: 0, botLike: 0, suspiciousLinkTurns: 2 });
    } finally {
      redisBridge.evalOverride = undefined;
      await client.del(redisKey);
      await client.quit();
    }
  });
});
