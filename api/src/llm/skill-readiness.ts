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

export const BOOKING_SKILL_ID = 'booking';

/** Refinement applied to an active skill's base `ready` state. Returns the refined
 *  state, or undefined when the skill has no readiness check (pass-through). */
export function readinessRefinement(
  skillId: string,
  ctx: { bookingConfigured: boolean },
): SkillState | undefined {
  if (skillId === BOOKING_SKILL_ID) return ctx.bookingConfigured ? 'ready' : 'unconfigured';
  return undefined;
}
