import { describe, it, expect } from 'vitest';
import {
  advanceLoopState,
  evaluateLoopState,
  detectBotLoop,
  EMPTY_LOOP_STATE,
  LOOP_THRESHOLDS,
  LoopState,
  LoopStateStore,
} from '../../guardrails/loop-detector';

const sig = (hash: string, meaningful = true, hasSuspiciousLink = false, humanSignal = false) => ({
  hash,
  meaningful,
  hasSuspiciousLink,
  humanSignal,
});

// Fold a sequence of signals starting from empty state.
function fold(signals: ReturnType<typeof sig>[]): LoopState {
  return signals.reduce((s, x) => advanceLoopState(s, x), EMPTY_LOOP_STATE);
}

describe('guardrails · loop-detector reducer', () => {
  it('counts repeated substantive messages and fires at the threshold', () => {
    const after2 = fold([sig('a'), sig('a')]);
    expect(after2.repeated).toBe(2);
    expect(evaluateLoopState(after2).isLoop).toBe(false);

    const after3 = advanceLoopState(after2, sig('a'));
    expect(after3.repeated).toBe(LOOP_THRESHOLDS.repeated);
    expect(evaluateLoopState(after3).isLoop).toBe(true);
  });

  it('resets the repeated counter when the message changes', () => {
    const s = fold([sig('a'), sig('a'), sig('b')]);
    expect(s.repeated).toBe(1);
    expect(evaluateLoopState(s).isLoop).toBe(false);
  });

  it('fires on non-progressing (bot-like) turns even with distinct content', () => {
    // Distinct but non-meaningful (flagged/empty) messages accumulate botLike.
    const s = fold([sig('a', false), sig('b', false), sig('c', false), sig('d', false), sig('e', false)]);
    expect(s.botLike).toBe(LOOP_THRESHOLDS.botLike);
    expect(evaluateLoopState(s).isLoop).toBe(true);
  });

  it('a meaningful message resets the bot-like streak', () => {
    const s = fold([sig('a', false), sig('b', false), sig('c', false), sig('d', false), sig('e', true)]);
    expect(s.botLike).toBe(0);
    expect(evaluateLoopState(s).isLoop).toBe(false);
  });

  it('still fires for a repeated generic automated reply', () => {
    const reply = 'Your request has been received, a representative will contact you shortly';
    const s = fold([sig(reply), sig(reply), sig(reply)]);
    expect(s.repeated).toBe(3);
    expect(evaluateLoopState(s).isLoop).toBe(true);
  });

  it('human signals reset repeated and bot-like counters', () => {
    const hello = sig('hello?', false, false, true);
    const s = fold([hello, hello, hello, hello, hello]);
    expect(s.repeated).toBe(0);
    expect(s.botLike).toBe(0);
    expect(evaluateLoopState(s).isLoop).toBe(false);
  });

  it('a human signal resets a substantive streak, which can then re-arm', () => {
    const reply = sig('automated reply');
    const human = sig('anyone?', false, false, true);
    const reset = fold([reply, reply, human]);
    expect(reset.repeated).toBe(0);
    expect(reset.botLike).toBe(0);

    const rearmed = fold([reply, reply, human, reply, reply, reply]);
    expect(rearmed.repeated).toBe(LOOP_THRESHOLDS.repeated);
    expect(evaluateLoopState(rearmed).isLoop).toBe(true);
  });

  it('emoji-only messages never become a loop', () => {
    const emoji = sig('👋', false, false, true);
    const s = fold([emoji, emoji, emoji, emoji, emoji]);
    expect(evaluateLoopState(s).isLoop).toBe(false);
  });

  it('fires on cumulative suspicious-link turns (even on meaningful turns)', () => {
    const s = fold([sig('a', true, true), sig('b', true, true)]);
    expect(s.suspiciousLinkTurns).toBe(LOOP_THRESHOLDS.suspiciousLinkTurns);
    expect(evaluateLoopState(s).isLoop).toBe(true);
  });

  it('a clean progressing conversation is never a loop', () => {
    const s = fold([sig('a', true), sig('b', true), sig('c', true)]);
    expect(evaluateLoopState(s).isLoop).toBe(false);
  });
});

describe('guardrails · detectBotLoop with a store', () => {
  it('persists state across turns and reports the loop verdict', async () => {
    const mem = new Map<string, LoopState>();
    const store: LoopStateStore = {
      advance: async (id, signal) => {
        const next = advanceLoopState(mem.get(id) ?? EMPTY_LOOP_STATE, signal);
        mem.set(id, next);
        return next;
      },
      clear: async (id) => void mem.delete(id),
    };

    const r1 = await detectBotLoop(store, 'sess1', sig('x'));
    expect(r1.isLoop).toBe(false);
    const r2 = await detectBotLoop(store, 'sess1', sig('x'));
    expect(r2.isLoop).toBe(false);
    const r3 = await detectBotLoop(store, 'sess1', sig('x'));
    expect(r3.isLoop).toBe(true);
    expect(r3.reasons.join(' ')).toMatch(/repeated/);
    expect(mem.get('sess1')?.repeated).toBe(3);
  });
});
