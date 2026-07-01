/**
 * Wire contract: GET /api/v1/bots/:botId/skill-readiness — the advisory per-skill
 * state + remedy a tenant sees alongside a bot's template bindings
 * (composable-templates Phase 6).
 *
 * Rules for this directory (see entitlements.ts): pure types only — no runtime
 * code and NO imports outside this directory. The portal type-checks these under
 * its own tsconfig and its Docker image copies ONLY api/src/contracts, so an
 * import from ../modules would fail the portal build. `SkillState` is therefore
 * RE-DECLARED here, mirroring SKILL_STATES in api/src/modules/skill-state.ts; a
 * compile-time assertion in api/src/llm/skill-readiness.ts fails tsc if the two
 * unions ever drift.
 */

/** Mirror of SKILL_STATES in api/src/modules/skill-state.ts (kept in sync by a
 *  compile-time assertion api-side). */
export type SkillState = 'ready' | 'unentitled' | 'disabled' | 'unconfigured' | 'absent' | 'error';

/** Machine-level remedy the tenant can act on; the portal maps it to display copy.
 *  null = nothing to do (ready) or a fail-safe (error). `absent` skills are omitted
 *  from the response entirely, so they never carry a remedy. */
export type SkillRemedy = 'upgrade' | 'turn on' | 'finish setup' | null;

export interface SkillReadinessDto {
  id: string;
  /** Human-readable skill label (e.g. 'Bookings'); falls back to the id. */
  name: string;
  state: SkillState;
  remedy: SkillRemedy;
}

export type SkillReadinessResponse = SkillReadinessDto[];
