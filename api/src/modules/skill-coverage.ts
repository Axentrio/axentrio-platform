/**
 * Skill coverage — the read-only diagnostic for a feature the tenant PAYS for
 * whose delivering skill no bound template selects, so the feature is silently
 * dead for that bot.
 *
 * The failure this prevents (found in production): a Pro tenant's bot bound a
 * template whose `selected_skill_ids` was `["booking"]`. `agent.service` gates
 * tools with `gatedToolNames(selectedSkillIds, activeModuleIds)`, which drops the
 * tools of every ACTIVE skill the template did NOT select — so `capture_lead` was
 * stripped. The tenant's `leadCapture` entitlement said `true`, they paid for
 * Leads, and the bot never captured one. Nothing anywhere surfaced it.
 *
 * STRICTLY ADVISORY: this mirrors the runtime gate, it never feeds it. Nothing
 * here is imported by the agent loop or by tool resolution.
 *
 * The feature↔skill mapping is DERIVED from the catalog's own gates
 * (`ModuleDefinition.gate`), not a hand-kept list — a new feature-gated skill is
 * covered the day it registers, and a renamed feature key can't drift.
 */
import { allModules, featureGatedSkillIds, type ModuleDefinition } from './module-catalog';
import {
  resolveBoundTemplates,
  effectiveSkillIds,
  type BotTemplateBinding,
} from '../templates/template-resolver';
import type { Entitlements, FeatureKey } from '../billing/types';

/** One entitled-but-undelivered feature: the plan says yes, the bot's templates don't. */
export interface UnselectedEntitledSkill {
  /** The entitlement key that is on (e.g. 'leadCapture'). */
  feature: FeatureKey;
  /** The skill that delivers it (e.g. 'lead_capture'). */
  skillId: string;
  /** Human label for the skill (e.g. 'Lead capture'). */
  skillName: string;
}

/**
 * Pure core: which feature-gated skills are LIVE for the tenant but selected by
 * none of the bot's bound templates.
 *
 * `features` must be the EFFECTIVE map (entitlement ceiling ∧ tenant preference):
 * omitting a skill you never bought — or deliberately switched off — is not a
 * misconfiguration, so only a feature that is both entitled AND switched on can
 * warn. Enablement-gated skills are bespoke per-tenant work, not something a plan
 * promises, so they are out of scope.
 */
export function findUnselectedEntitledSkills(opts: {
  selectedSkillIds: string[];
  features: Partial<Record<FeatureKey, boolean>>;
  /** Defaults to the registered catalog; injectable so tests need no registration. */
  skills?: ModuleDefinition[];
}): UnselectedEntitledSkill[] {
  const selected = new Set(opts.selectedSkillIds);
  const out: UnselectedEntitledSkill[] = [];
  for (const def of opts.skills ?? allModules()) {
    if (def.gate.kind !== 'feature') continue;
    if (opts.features[def.gate.feature] !== true) continue;
    if (selected.has(def.id)) continue;
    out.push({ feature: def.gate.feature, skillId: def.id, skillName: def.displayName });
  }
  return out;
}

/**
 * The diagnostic for one bot. `entitlements` is passed in (never re-resolved) so
 * this stays a pure read on top of what the caller already has.
 *
 * Two deliberate silences:
 *   - Composable gating OFF ⇒ nothing. `gatedToolNames` only runs behind that
 *     flag; with it off no skill's tools are dropped and the warning would lie.
 *   - No bound template ⇒ nothing. That bot answers from the knowledge base only
 *     — an explicit, already-surfaced empty state, not a silent misconfiguration.
 *     Warning once per entitled feature there would be pure noise.
 */
export async function computeUnselectedEntitledSkills(
  bot: {
    templateId?: string | null;
    templateVersion?: string | null;
    templateBindings?: BotTemplateBinding[] | null;
  },
  entitlements: Entitlements,
): Promise<UnselectedEntitledSkill[]> {
  if (process.env.COMPOSABLE_TEMPLATES_ENABLED !== 'true') return [];
  const resolved = await resolveBoundTemplates(bot);
  if (resolved.length === 0) return [];
  return findUnselectedEntitledSkills({
    // The EFFECTIVE skills, not the explicitly selected ones (#103). A template whose policy is
    // `inherit_entitled` — Blank — already gives the bot every entitled skill, so warning that it
    // "did not select" them would report a misconfiguration that does not exist.
    selectedSkillIds: effectiveSkillIds(
      resolved,
      featureGatedSkillIds((f) => entitlements.features[f] === true),
    ),
    features: entitlements.features,
  });
}
