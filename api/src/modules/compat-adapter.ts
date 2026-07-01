// Compatibility adapter — represents today's engineered modules and a template's
// `expectedModules` in the composable-templates vocabulary (skills + single-skill
// modules), in-memory and losslessly. No DB, no schema change.
//
// Phase 2 (.scratch/plan-composable-templates-implementation.md): the adapter is
// deliberately near-trivial — that IS the proof that the rename (module → skill)
// and the "expectedModules ≡ single-skill modules" claim are lossless. The
// engineered SkillDefinition gains readiness + per-state postures in Phase 3; the
// authored Module gains real prose + persistence in Phase 4. Here they are just
// views over what already exists.

import type { ModuleDefinition } from './module-catalog';

/**
 * The engineered-skill view of a module — same capability, new vocabulary. Phase
 * 2 carries only the fields that exist today; Phase 3 extends it with a readiness
 * predicate and per-state prompt postures.
 */
export interface SkillDefinition {
  id: string;
  displayName: string;
  gate: ModuleDefinition['gate'];
  tools: ModuleDefinition['tools'];
  buildPromptSection?: ModuleDefinition['buildPromptSection'];
}

/**
 * A reference from a (synthetic, in Phase 2) authored module to the skills it
 * binds. Today's `expectedModules` maps 1:1 to single-skill modules.
 */
export interface ModuleRef {
  moduleId: string;
  skillIds: string[];
}

/** Engineered module → skill view (lossless: same gate, same tool adapters). */
export function adaptLegacyModule(def: ModuleDefinition): SkillDefinition {
  return {
    id: def.id,
    displayName: def.displayName,
    gate: def.gate,
    tools: def.tools,
    buildPromptSection: def.buildPromptSection,
  };
}

/**
 * A template's `expectedModules` → one single-skill module ref per module id.
 * Deduped (a repeated id yields one ref) so the synthetic representation never
 * invents phantom duplicate modules.
 */
export function adaptExpectedModules(expectedModules: string[]): ModuleRef[] {
  const seen = new Set<string>();
  const refs: ModuleRef[] = [];
  for (const id of expectedModules) {
    if (seen.has(id)) continue;
    seen.add(id);
    refs.push({ moduleId: id, skillIds: [id] });
  }
  return refs;
}
