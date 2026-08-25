// Behaviour matrix for the inbound guardrails gate.
//
// For every classifier family, in both enforce and shadow mode, it records:
//   - firstGate: the verdict when the gate wins the exactly-once claim.
//   - replay:    the verdict when the message is ALREADY claimed and carries no
//                persisted outcome (the state a coalesced 'stale' re-run sees).
//
// It also records the bot-loop case, where the loop counters are advanced
// directly (so the session is never disabled) and the replay therefore has to
// decide without the loop signal.
//
// The matrix is written to MATRIX_OUT (default /tmp/guardrail-matrix.json) so the
// same file can be produced on the pre-fix and post-fix code and diffed.
import { writeFileSync } from 'fs';
import { describe, it, expect, vi } from 'vitest';
import { AppDataSource } from '../../database/data-source';
import { ChatSession } from '../../database/entities/ChatSession';
import { Message } from '../../database/entities/Message';
import { runInboundGate, type InboundGateResult } from '../../guardrails/inbound-guardrails.service';
import { redisLoopStore } from '../../guardrails/loop-store';
import { createTestTenant, createTestSession, createTestParticipant, createTestMessage } from '../helpers/factories';

const loopStates = vi.hoisted(() => new Map<string, {
  lastHash?: string;
  repeated: number;
  botLike: number;
  suspiciousLinkTurns: number;
}>());

// Faithful in-memory stand-in for the atomic Lua advance in loop-store.ts.
const redis = vi.hoisted(() => ({
  eval: async (
    _script: string,
    _keyCount: number,
    key: string,
    hash: string,
    meaningfulArg: string,
    humanArg: string,
    linkArg: string,
  ) => {
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
  hmget: async (key: string) => {
    const s = loopStates.get(key);
    return s
      ? [s.lastHash ?? null, String(s.repeated), String(s.botLike), String(s.suspiciousLinkTurns)]
      : [null, null, null, null];
  },
}));

vi.mock('../../config/redis', () => ({ getRedisClient: () => redis }));

const CASES: { name: string; content: string }[] = [
  { name: 'clean · booking question', content: 'Hi, can I book tomorrow?' },
  { name: 'clean · the frozen chat', content: 'ja voor Achraf' },
  {
    name: 'solicitation · cold B2B',
    content: 'Hi, I came across your business and we offer SEO and web design to boost your sales',
  },
  {
    name: 'solicitation + credential',
    content: 'We offer SEO services to grow your business. Please send me your password.',
  },
  {
    name: 'phishing · account threat + shortener',
    content: 'Your account will be deleted. Verify your account here https://bit.ly/x',
  },
  {
    name: 'scam · crypto returns',
    content: 'Guaranteed returns! Double your money with our crypto investment platform',
  },
  { name: 'suspicious link · bare shortener', content: 'Check this out https://bit.ly/abc123' },
];

const msgRepo = () => AppDataSource.getRepository(Message);
const sessionRepo = () => AppDataSource.getRepository(ChatSession);

async function freshSession(enforce: boolean) {
  const tenant = await createTestTenant({
    settings: (enforce ? { guardrails: { enforce: true } } : {}) as never,
  });
  const session = await createTestSession(tenant.id, { status: 'bot' });
  const participant = await createTestParticipant(session.id, { type: 'user' });
  const reloaded = await sessionRepo().findOneOrFail({ where: { id: session.id } });
  return { tenantId: tenant.id, session: reloaded, participantId: participant.id };
}

function render(r: InboundGateResult): string {
  return `${r.proceed ? 'PROCEED' : 'BLOCK'} · ${r.category}${r.replyOverride ? ' · canned reply' : ''}`;
}

/** Gate a message that wins the claim (the ordinary first pass). */
async function firstGate(content: string, enforce: boolean, channel = 'whatsapp') {
  const { tenantId, session, participantId } = await freshSession(enforce);
  const message = await createTestMessage(session.id, tenantId, participantId, { content });
  return render(await runInboundGate({ session, tenantId, message, content, channel }));
}

/** Gate a message that is already claimed and has NO persisted outcome. */
async function replayGate(content: string, enforce: boolean, channel = 'whatsapp') {
  const { tenantId, session, participantId } = await freshSession(enforce);
  const message = await createTestMessage(session.id, tenantId, participantId, { content });
  await msgRepo().update(message.id, { guardrailChecked: true });
  return render(await runInboundGate({ session, tenantId, message, content, channel }));
}

describe('guardrails · first gate vs replay behaviour matrix', () => {
  it('records the verdict of every family on both paths', async () => {
    const rows: { mode: string; case: string; firstGate: string; replay: string }[] = [];

    for (const enforce of [true, false]) {
      const mode = enforce ? 'enforce' : 'shadow';
      for (const c of CASES) {
        rows.push({
          mode,
          case: c.name,
          firstGate: await firstGate(c.content, enforce),
          replay: await replayGate(c.content, enforce),
        });
      }

      // Bot loop: advance the counters directly so no block is recorded and the
      // session stays enabled. The next FIRST gate must see a loop, and so must
      // the replay, which peeks the same counters instead of advancing them.
      const repeated = 'Please confirm the order status now for account 12345';
      const loopRow = { mode, case: 'bot_loop · counters already tripped', firstGate: '', replay: '' };

      const a = await freshSession(enforce);
      for (let i = 0; i < 3; i++) {
        const m = await createTestMessage(a.session.id, a.tenantId, a.participantId, { content: repeated });
        await runInboundGate({
          session: a.session, tenantId: a.tenantId, message: m, content: repeated, channel: 'whatsapp',
        });
        await sessionRepo().update(a.session.id, { aiAutoReplyEnabled: true, guardrailStatus: 'normal' });
      }
      const aFresh = await sessionRepo().findOneOrFail({ where: { id: a.session.id } });
      const mNext = await createTestMessage(a.session.id, a.tenantId, a.participantId, { content: repeated });
      loopRow.firstGate = render(await runInboundGate({
        session: aFresh, tenantId: a.tenantId, message: mNext, content: repeated, channel: 'whatsapp',
      }));

      const b = await freshSession(enforce);
      for (let i = 0; i < 4; i++) {
        await redisLoopStore.advance(b.session.id, {
          hash: 'same-hash-for-the-repeat', meaningful: true, humanSignal: false, hasSuspiciousLink: false,
        });
      }
      const mReplay = await createTestMessage(b.session.id, b.tenantId, b.participantId, { content: repeated });
      await msgRepo().update(mReplay.id, { guardrailChecked: true });
      loopRow.replay = render(await runInboundGate({
        session: b.session, tenantId: b.tenantId, message: mReplay, content: repeated, channel: 'whatsapp',
      }));

      rows.push(loopRow);
    }

    const out = process.env.MATRIX_OUT || '/tmp/guardrail-matrix.json';
    writeFileSync(out, `${JSON.stringify(rows, null, 2)}\n`);
    // eslint-disable-next-line no-console
    console.log(`\nGUARDRAIL MATRIX → ${out}\n${rows
      .map((r) => `${r.mode.padEnd(8)} | ${r.case.padEnd(38)} | first: ${r.firstGate.padEnd(34)} | replay: ${r.replay}`)
      .join('\n')}\n`);

    // The invariant this file exists to pin: a second gating of a message must
    // reach the SAME verdict as the first one. Anything else either freezes a
    // healthy conversation or re-admits content the first pass rejected.
    expect(rows).toHaveLength(16);
    for (const r of rows) {
      expect(`${r.mode} · ${r.case} → ${r.replay}`).toBe(`${r.mode} · ${r.case} → ${r.firstGate}`);
    }
  });

  // The one place the two paths are ALLOWED to disagree, pinned so nobody has to
  // rediscover it. The bot-loop verdict is session state, not content, so a second
  // look reads the counters as they are NOW, not as they were at the first look.
  // The divergence is always in the strict direction: a replay can block what the
  // first pass allowed, never the reverse.
  it('may block on a replay when loop counters moved after the first pass', async () => {
    const { tenantId, session, participantId } = await freshSession(true);
    const content = 'Please confirm the order status now for account 12345';
    const message = await createTestMessage(session.id, tenantId, participantId, { content });

    expect(render(await runInboundGate({ session, tenantId, message, content, channel: 'whatsapp' })))
      .toBe('PROCEED · clean');

    // Sibling traffic trips the loop AFTER this message was gated clean.
    for (let i = 0; i < 3; i++) {
      await redisLoopStore.advance(session.id, {
        hash: 'sibling-repeat', meaningful: true, humanSignal: false, hasSuspiciousLink: false,
      });
    }

    const reloaded = await sessionRepo().findOneOrFail({ where: { id: session.id } });
    expect(render(await runInboundGate({ session: reloaded, tenantId, message, content, channel: 'whatsapp' })))
      .toBe('BLOCK · bot_loop');

    // And it blocks the whole way: flagged, paused, journalled — never a silent drop.
    expect((await msgRepo().findOneOrFail({ where: { id: message.id } })).guardrailFlagged).toBe(true);
    const paused = await sessionRepo().findOneOrFail({ where: { id: session.id } });
    expect(paused.aiAutoReplyEnabled).toBe(false);
    expect(paused.guardrailStatus).toBe('bot_loop');
  });
});
