// Skill-state machine — the committed vocabulary for the composable-templates
// redesign (.scratch/plan-composable-templates-implementation.md, Phase 1).
//
// A "skill" is the engineered layer (tools + integration + readiness + per-state
// prompt postures) — today's code "module", being renamed. Each selected skill
// resolves, per tenant+bot, to exactly one of these states; the state drives the
// prompt posture, whether tools are exposed, and the tenant-facing remedy.
//
// This file is the TYPE-ONLY home (no resolution logic yet — that lands in
// Phase 3, in agent.service + skill-readiness, the only place with tenant+bot
// context). Runtime-introspectable so the spec is testable and Phase 6 can map
// state → remedy off a single source of truth.

export const SKILL_STATES = [
  'ready', // selected ∧ entitled ∧ enabled ∧ configured → full prose + tools
  'unentitled', // plan tier excludes it → degrade, no tools, remedy "upgrade"
  'disabled', // entitled but tenant toggled off → degrade, no tools, remedy "turn on"
  'unconfigured', // enabled but not set up → degrade → capture request, remedy "finish setup"
  'absent', // not selected by any bound template → omitted
  'error', // readiness check threw → fail-safe degrade (runtime treats as ready; logged)
] as const;

export type SkillState = (typeof SKILL_STATES)[number];

// The result of resolving one skill for a given tenant+bot. Phase 3 populates
// the resolution (state machine + readiness); later phases attach the resolved
// config payload when a concrete consumer needs it (kept minimal here per YAGNI).
export interface SkillResolution {
  id: string;
  state: SkillState;
}
