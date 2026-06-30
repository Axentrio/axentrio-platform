// Skill readiness refinement (composable-templates Phase 3a). An ACTIVE skill is
// `ready` by default; a readiness check can degrade it to `unconfigured` (no tools,
// captures the request) when the integration isn't set up. v1 is booking-only —
// other skills have no readiness check yet and pass through unrefined.
//
// Runtime fail-open lives upstream: agent.service sets bookingConfigured=true on a
// readiness-lookup error, so a transient DB blip never falsely declines a
// configured tenant. This module is therefore pure (no I/O) and trivially testable;
// Phase 3b reads the same rule to pick the prompt posture.

import type { SkillState } from '../modules/skill-state';
import type {
  SkillReadinessDto,
  SkillRemedy,
  SkillState as WireSkillState,
} from '../contracts/skill-readiness';

export const BOOKING_SKILL_ID = 'booking';

// Compile-time guard: the wire SkillState (re-declared in the contract so the
// portal needn't import from ../modules — see contracts/skill-readiness.ts) MUST
// mirror the canonical SKILL_STATES. If a member is added/removed on one side
// only the equivalence collapses to `never` and this `= true` fails tsc.
type _BothWays<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
export const SKILL_STATE_CONTRACT_IN_SYNC: _BothWays<SkillState, WireSkillState> = true;

/** Refinement applied to an active skill's base `ready` state. Returns the refined
 *  state, or undefined when the skill has no readiness check (pass-through). */
export function readinessRefinement(
  skillId: string,
  ctx: { bookingConfigured: boolean },
): SkillState | undefined {
  if (skillId === BOOKING_SKILL_ID) return ctx.bookingConfigured ? 'ready' : 'unconfigured';
  return undefined;
}

/**
 * Pure state → tenant remedy (composable-templates Phase 6). The SINGLE source of
 * truth for the mapping — the readiness endpoint and the bot-template view both
 * call it, and the portal maps the result to display copy. `ready`/`absent`/`error`
 * carry no action (null): error is a fail-safe, absent skills are omitted upstream.
 */
export function skillStateToRemedy(state: SkillState): SkillRemedy {
  switch (state) {
    case 'unentitled':
      return 'upgrade';
    case 'disabled':
      return 'turn on';
    case 'unconfigured':
      return 'finish setup';
    default:
      return null; // ready | absent | error
  }
}

/**
 * Wrap a readiness refinement so a THROW degrades just that one skill to `error`
 * (fail-safe), instead of failing the whole resolution. The readiness endpoint
 * uses this; the agent runtime fails OPEN separately on the booking-config lookup
 * (a transient blip must never falsely decline a configured tenant), so the two
 * error policies live at their call sites, not here.
 */
export function safeReadiness(
  refine: (skillId: string) => SkillState | undefined,
  onError?: (skillId: string, err: unknown) => void,
): (skillId: string) => SkillState | undefined {
  return (skillId) => {
    try {
      return refine(skillId);
    } catch (err) {
      onError?.(skillId, err);
      return 'error';
    }
  };
}

/**
 * Build the tenant-facing readiness list from resolved skill states. `absent`
 * skills (not offered by any bound template, not actionable) are OMITTED — the
 * Phase-6 choice is silent, not a remedy=null row. Pure: the caller injects the
 * skill-name lookup (e.g. `getModule(id)?.displayName ?? id`).
 */
export function skillStatesToReadiness(
  states: Record<string, SkillState>,
  nameOf: (skillId: string) => string,
): SkillReadinessDto[] {
  const out: SkillReadinessDto[] = [];
  for (const [id, state] of Object.entries(states)) {
    if (state === 'absent') continue;
    out.push({ id, name: nameOf(id), state, remedy: skillStateToRemedy(state) });
  }
  return out;
}
