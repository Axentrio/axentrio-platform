// Bot-loop detection — PURE state logic + a store interface.
//
// Detects an automated / non-progressing counterparty so the AI stops replying
// into an endless loop (R10/R18). The reducer and evaluation are pure and fully
// unit-testable; the durable counter store (Redis) is injected and wired later.
// See .scratch/plan-global-ai-guardrails.md §2.

/** Rolling per-conversation counters (persisted between turns). */
export interface LoopState {
  /** Hash of the previous inbound message, to detect verbatim repeats. */
  lastHash?: string;
  /** Consecutive identical substantive inbound messages. */
  repeated: number;
  /** Consecutive non-progressing ("bot-like") inbound turns. */
  botLike: number;
  /** Cumulative count of inbound turns carrying a suspicious link. */
  suspiciousLinkTurns: number;
}

/** Signal derived from the current inbound message (by the caller). */
export interface LoopSignal {
  /** Stable hash of the normalized message content. */
  hash: string;
  /** True when the message is genuine forward progress (clean + substantive).
   *  An EXACT repeat is treated as non-progressing regardless of this flag. */
  meaningful: boolean;
  /** Human-typical short content resets repeated and bot-like streaks. */
  humanSignal: boolean;
  /** True when the message carries a suspicious link. */
  hasSuspiciousLink: boolean;
}

/** Thresholds from R10. Exported for tests + tuning. */
export const LOOP_THRESHOLDS = {
  repeated: 3, // 3 identical substantive messages
  botLike: 5, // 5 automated-looking turns
  suspiciousLinkTurns: 2, // 2 suspicious-link messages
} as const;

/** Human signals are transient inputs, not persisted state. */
export const EMPTY_LOOP_STATE: LoopState = { repeated: 0, botLike: 0, suspiciousLinkTurns: 0 };

/** Pure reducer: fold the current message's signal into the prior state.
 *  - Human signals reset `repeated` and `botLike`.
 *  - `repeated`: consecutive identical substantive messages.
 *  - `botLike`: consecutive non-progressing turns, where non-progressing = an
 *    exact repeat OR a non-meaningful (flagged/empty) message. */
export function advanceLoopState(prev: LoopState, signal: LoopSignal): LoopState {
  const isRepeat = !!signal.hash && signal.hash === prev.lastHash;
  const suspiciousLinkTurns = prev.suspiciousLinkTurns + (signal.hasSuspiciousLink ? 1 : 0);
  if (signal.humanSignal) {
    return { lastHash: signal.hash, repeated: 0, botLike: 0, suspiciousLinkTurns };
  }

  const substantiveRepeat = isRepeat && signal.meaningful && !signal.humanSignal;
  const repeated = substantiveRepeat ? prev.repeated + 1 : signal.meaningful ? 1 : 0;
  const nonProgressing = isRepeat || !signal.meaningful;
  const botLike = nonProgressing ? prev.botLike + 1 : 0;
  return { lastHash: signal.hash, repeated, botLike, suspiciousLinkTurns };
}

/** Pure evaluation: is this conversation in a bot-loop, and why. */
export function evaluateLoopState(state: LoopState): { isLoop: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (state.repeated >= LOOP_THRESHOLDS.repeated) reasons.push(`${state.repeated} repeated substantive messages`);
  if (state.botLike >= LOOP_THRESHOLDS.botLike) reasons.push(`${state.botLike} non-progressing turns`);
  if (state.suspiciousLinkTurns >= LOOP_THRESHOLDS.suspiciousLinkTurns) reasons.push(`${state.suspiciousLinkTurns} suspicious-link messages`);
  return { isLoop: reasons.length > 0, reasons };
}

/** Persistence boundary for loop counters. The gate runs at ingress (outside any
 *  agent lock), so `advance` MUST be an ATOMIC read-modify-write per session —
 *  the Redis impl uses a Lua script that mirrors `advanceLoopState`. */
export interface LoopStateStore {
  advance(sessionId: string, signal: LoopSignal): Promise<LoopState>;
  /** Read the counters WITHOUT advancing them. Used when a message is gated a
   *  second time: its own advance already happened, so advancing again would
   *  double-count it. */
  peek(sessionId: string): Promise<LoopState>;
  clear(sessionId: string): Promise<void>;
}

/** Atomically fold the signal into the session's counters, then evaluate. */
export async function detectBotLoop(
  store: LoopStateStore,
  sessionId: string,
  signal: LoopSignal,
): Promise<{ isLoop: boolean; reasons: string[]; state: LoopState }> {
  const state = await store.advance(sessionId, signal);
  const { isLoop, reasons } = evaluateLoopState(state);
  return { isLoop, reasons, state };
}
