/**
 * Turn-coalescer timing policy — PURE, dependency-free (only reads env at load).
 * Kept separate from turn-coalescer.ts so it can be unit-tested without dragging
 * in the DB / agent / socket graph. See .scratch/plan-message-coalescer.md.
 */

// Adaptive quiet windows (ms). Tunable in prod without a code change.
export const QUIET_LONE_MS = Number(process.env.TURN_QUIET_LONE_MS ?? 700);
export const QUIET_BURST_MS = Number(process.env.TURN_QUIET_BURST_MS ?? 2000);
export const QUIET_CAPTURE_MS = Number(process.env.TURN_QUIET_CAPTURE_MS ?? 2500);
export const MAX_WAIT_MS = Number(process.env.TURN_MAX_WAIT_MS ?? 6000);

export interface TurnState {
  firstPendingAt: number; // DB created_at (ms epoch) of the first unanswered msg
  lastPendingAt: number; // DB created_at (ms epoch) of the most recent msg
  count: number;
  captureMode: boolean;
}

/**
 * dueAt = min(lastPendingAt + threshold, firstPendingAt + MAX_WAIT).
 * - captureMode (lone email/phone fragment) → longest quiet window
 * - count >= 2 (a burst) → medium window
 * - otherwise → short window (keeps the lone-message case fast)
 * The MAX_WAIT ceiling stops a chatty user from stalling forever.
 */
export function computeDueAt(state: TurnState): number {
  const threshold = state.captureMode
    ? QUIET_CAPTURE_MS
    : state.count >= 2
      ? QUIET_BURST_MS
      : QUIET_LONE_MS;
  return Math.min(state.lastPendingAt + threshold, state.firstPendingAt + MAX_WAIT_MS);
}

/**
 * Capture-mode heuristic (Phase 1): a lone email- or phone-looking fragment is
 * almost always a partial slot-fill, so wait longer. Advisory only — it can only
 * change timing, never correctness (stale-suppression is the backstop).
 */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_RE = /^[+(]?[\d][\d\s().-]{6,}$/;
export function isContactFragment(text: string): boolean {
  const t = (text || '').trim();
  if (!t || t.length > 64) return false;
  return EMAIL_RE.test(t) || PHONE_RE.test(t);
}
