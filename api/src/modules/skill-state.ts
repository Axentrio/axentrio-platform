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

/**
 * Resolve the state of each selected/active skill (Phase 3a). PURE — no DB:
 * `agent.service` feeds it already-resolved locals (active modules, the bound
 * template's selected skills, a gate-kind lookup, and an optional readiness
 * refinement). Returns a `{ skillId: state }` map.
 *
 * The state machine:
 *   - active (entitled ∧ enabled ∧ valid) → `ready`, then refined by `readiness`
 *     (booking: `ready` only when configured, else `unconfigured`).
 *   - selected but not active → why: feature-gate → `unentitled`, enablement-gate
 *     → `disabled`, unknown id → `absent`.
 *
 * Entitlement is the hard ceiling: `readiness` only ever refines a `ready` base —
 * it can never upgrade an unentitled/disabled skill.
 */
export function resolveSkillStates(opts: {
  selected: string[];
  active: string[];
  gateKind: (id: string) => 'feature' | 'enablement' | undefined;
  readiness?: (id: string) => SkillState | undefined;
}): Record<string, SkillState> {
  const activeSet = new Set(opts.active);
  const ids = new Set<string>([...opts.selected, ...opts.active]);
  const out: Record<string, SkillState> = {};
  for (const id of ids) {
    if (activeSet.has(id)) {
      out[id] = opts.readiness?.(id) ?? 'ready';
    } else {
      const gate = opts.gateKind(id);
      out[id] = gate === undefined ? 'absent' : gate === 'enablement' ? 'disabled' : 'unentitled';
    }
  }
  return out;
}

/**
 * Phase 3b — drop the tools belonging to any skill that isn't `ready`, so a
 * degraded skill is physically uncallable by the model (no phantom actions),
 * not merely discouraged in the prompt. Pure: the caller supplies the per-skill
 * tool-name lookup. Returns the same array reference when nothing is dropped.
 */
export function dropUnreadySkillTools<T extends { name: string }>(
  tools: T[],
  skillStates: Record<string, SkillState>,
  skillToolNames: (skillId: string) => string[],
): T[] {
  const drop = new Set<string>();
  for (const [id, state] of Object.entries(skillStates)) {
    if (state !== 'ready') for (const n of skillToolNames(id)) drop.add(n);
  }
  return drop.size === 0 ? tools : tools.filter((t) => !drop.has(t.name));
}
