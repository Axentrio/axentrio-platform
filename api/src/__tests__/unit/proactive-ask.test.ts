/**
 * The proactive contact ask — the DETERMINISTIC half, no model call.
 *
 * Split deliberately, mirroring the enrichment eval guard. Two different claims need
 * two different kinds of evidence:
 *
 *   - "we ask at most once, never on turn one, never on a channel, never when we
 *     already have contact, never without the tenant opting in" is a property of the
 *     GATE. It is decidable here, and it runs on every commit.
 *   - "the wording never feels pushy" is a property of an LLM's prose. It is measured
 *     by `npm run eval:proactive` against a real model, with published thresholds and a
 *     ZERO ceiling on asking when it must not.
 *
 * The gate is what makes the promise structural: even a model that ignored every line
 * of the instruction cannot be handed it twice in one conversation.
 */
import { describe, it, expect } from 'vitest';
import { shouldAskForContact, PROACTIVE_ASK_RULE } from '../../leads/proactive/should-ask';
import { readAskState, withAskState, ASK_STATE_KEY } from '../../leads/proactive/ask-state';
import type { ChatSession } from '../../database/entities/ChatSession';
import {
  PROACTIVE_EVAL_CASES,
  PROACTIVE_EVAL_THRESHOLDS,
} from '../../leads/proactive/eval/fixtures';
import { composeSystemPrompt } from '../../llm/compose-system-prompt';
import { PROMPT_BLOCK_KEYS } from '../../llm/block-ledger';

/** A capture-capable agent context; `proactiveAsk` is varied per test. */
function ctx(proactiveAsk?: boolean) {
  return {
    mode: 'agent' as const,
    ai: undefined,
    tenantName: 'De Vries Loodgieters',
    tier: 'pro' as const,
    tools: [{ name: 'capture_lead' }] as never,
    proactiveAsk,
  };
}

/** The one configuration in which asking is permitted. Each test spoils exactly one. */
const ALLOWED = {
  enabled: true,
  isChannel: false,
  hasContact: false,
  customerTurns: 2,
  state: {},
};

describe('shouldAskForContact — every condition is a restraint', () => {
  it('permits the ask when, and only when, everything lines up', () => {
    expect(shouldAskForContact(ALLOWED)).toBe(true);
  });

  it('stays silent when the tenant never opted in', () => {
    // proactiveLeadCapture is an OPT_IN feature: entitled ≠ switched on. This changes
    // what the bot asks an EU consumer for, so it needs an explicit act.
    expect(shouldAskForContact({ ...ALLOWED, enabled: false })).toBe(false);
  });

  it('stays silent on a messaging channel', () => {
    // We can already reply there forever; asking for a number is friction with no payoff.
    expect(shouldAskForContact({ ...ALLOWED, isChannel: true })).toBe(false);
  });

  it('never asks for contact details we already have', () => {
    expect(shouldAskForContact({ ...ALLOWED, hasContact: true })).toBe(false);
  });

  it('never asks on the opening turn', () => {
    // "Hi" → "what's your number?" is the forced questionnaire the spec forbids.
    expect(shouldAskForContact({ ...ALLOWED, customerTurns: 1 })).toBe(false);
    expect(shouldAskForContact({ ...ALLOWED, customerTurns: 0 })).toBe(false);
  });

  it('asks AT MOST once per conversation, whatever the customer said', () => {
    // A decline and a silence are recorded identically, because we act on both
    // identically. There is deliberately no "declined" state to get wrong.
    const asked = { askedAt: new Date().toISOString() };
    expect(shouldAskForContact({ ...ALLOWED, state: asked })).toBe(false);
    // Still false many turns later — this is the guarantee, not a rate limit.
    expect(shouldAskForContact({ ...ALLOWED, state: asked, customerTurns: 12 })).toBe(false);
  });
});

describe('ask-state persistence', () => {
  it('reads an absent, malformed or array metadata blob as "never asked"', () => {
    // Fails toward asking rather than toward silence ONLY here, where the alternative
    // is a corrupt blob permanently suppressing a feature the tenant paid for.
    expect(readAskState({ metadata: null } as ChatSession)).toEqual({});
    expect(readAskState({ metadata: {} } as ChatSession)).toEqual({});
    expect(readAskState({ metadata: { leadAsk: 'nonsense' } } as unknown as ChatSession)).toEqual({});
    expect(readAskState({ metadata: { leadAsk: [] } } as unknown as ChatSession)).toEqual({});
  });

  it('round-trips through the same key the SQL merge writes', () => {
    const at = '2026-08-02T10:00:00.000Z';
    const merged = withAskState(null, { askedAt: at });
    expect(merged[ASK_STATE_KEY]).toEqual({ askedAt: at });
    expect(readAskState({ metadata: merged } as unknown as ChatSession).askedAt).toBe(at);
  });

  it('preserves unrelated metadata — the coalescer writes to this column too', () => {
    const merged = withAskState({ coalescerWatermark: 'keep-me', other: 1 }, { askedAt: 'x' });
    expect(merged.coalescerWatermark).toBe('keep-me');
    expect(merged.other).toBe(1);
  });
});

describe('eval fixtures — the contract the offline harness is held to', () => {
  it('keeps a ZERO ceiling on asking when it must not', () => {
    // The one number that must never be relaxed. Every violation is the bot soliciting
    // personal data at a moment the product promised it would not.
    expect(PROACTIVE_EVAL_THRESHOLDS.maxUnwantedAsks).toBe(0);
    expect(PROACTIVE_EVAL_THRESHOLDS.maxUnansweredOrCoercive).toBe(0);
  });

  it('covers all three languages the platform serves, on both sides of the gate', () => {
    const langs = new Set(PROACTIVE_EVAL_CASES.map((c) => c.language));
    expect([...langs].sort()).toEqual(['en', 'fr', 'nl']);
    expect(PROACTIVE_EVAL_CASES.some((c) => c.expect.asks)).toBe(true);
    // The must-not-ask cases are the majority of the value, not filler.
    expect(PROACTIVE_EVAL_CASES.filter((c) => c.expect.mustNotAsk).length).toBeGreaterThanOrEqual(4);
  });

  it('pins the instruction to the restraints it promises', () => {
    // The eval measures the model's compliance; this asserts the text still ASKS for
    // the things compliance is scored on, so a reword cannot quietly drop a rule.
    expect(PROACTIVE_ASK_RULE).toMatch(/ONCE/);
    expect(PROACTIVE_ASK_RULE).toMatch(/Answer their question FIRST/i);
    expect(PROACTIVE_ASK_RULE).toMatch(/never raise it again|never repeat/i);
    expect(PROACTIVE_ASK_RULE).toMatch(/never make it a condition/i);
  });
});

describe('composer wiring — the block appears only when the caller allows it', () => {
  it('emits the ask instruction and ledgers it as included', () => {
    const { prompt, ledger } = composeSystemPrompt(ctx(true));
    expect(prompt).toContain('OFFERING TO FOLLOW UP');
    expect(ledger.getIncluded()).toContain(PROMPT_BLOCK_KEYS.PROACTIVE_CONTACT_ASK);
  });

  it('stays passive when the flag is absent — the pre-existing behaviour of every tier', () => {
    const { prompt, ledger } = composeSystemPrompt(ctx(undefined));
    expect(prompt).not.toContain('OFFERING TO FOLLOW UP');
    expect(ledger.getIncluded()).not.toContain(PROMPT_BLOCK_KEYS.PROACTIVE_CONTACT_ASK);
    // Ledgered as excluded rather than silently missing, so the superadmin prompt
    // preview can explain why a Pro tenant's bot is not asking.
    expect(ledger.getExcluded().map((b) => b.key)).toContain(PROMPT_BLOCK_KEYS.PROACTIVE_CONTACT_ASK);
  });

  it('cannot emit the ask when there is no capture_lead tool to answer into', () => {
    const { prompt } = composeSystemPrompt({ ...ctx(true), tools: [] as never });
    expect(prompt).not.toContain('OFFERING TO FOLLOW UP');
  });
});
