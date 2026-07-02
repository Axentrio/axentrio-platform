/**
 * Module catalog — the static, in-code registry of every Module the platform
 * ships (.scratch/plan-entitlements-modules.md, D12/D13/D14).
 *
 * A Module is a deployable unit of Agent capability: the tools it contributes,
 * an optional prompt contribution, and an optional config schema. Each module
 * declares exactly ONE gate:
 *
 *   - feature-gated: active iff the tenant's RESOLVED entitlements have the
 *     feature on. No tenant_modules row is required or consulted (booking is
 *     this — active for every entitled tenant with zero rows).
 *   - enablement-gated: bespoke per-tenant work; active iff the tenant has a
 *     tenant_modules row with enabled=true (and valid config). Inert for
 *     everyone else — the code ships to all tenants but does nothing.
 *
 * Registration happens at import time (see modules/index.ts); a duplicate id
 * throws so a copy-paste mistake fails the boot, not a tenant.
 */
import type { ZodTypeAny } from 'zod';
import type { ToolAdapter } from '../agent/tool-adapter';
import type { FeatureKey } from '../billing/types';

export type ModuleGate =
  | { kind: 'feature'; feature: FeatureKey }
  | { kind: 'enablement' };

export interface ModulePromptContext {
  tenantId: string;
  botId: string;
  /** Validated tenant_modules.config ({} for feature-gated modules). */
  config: Record<string, unknown>;
}

export interface ModuleDefinition {
  /** Catalog id — also the tenant_modules.module_id value for bespoke modules. */
  id: string;
  displayName: string;
  /** Plain-English "what this skill does" — shown in the Bot Studio skills catalog. */
  description?: string;
  /** What makes this skill `ready` (its config requirement), for the catalog. */
  readinessHint?: string;
  /** Canonical behavioural prose for this skill (frozen in code). Emitted for a
   *  template that binds the skill, and the seed a per-template override starts
   *  from. Complements — does not replace — the skill's hard tool-gated rules. */
  defaultProse?: string;
  /** Tool names this skill gives the bot, for DISPLAY (decoupled from `tools`, so a
   *  skill whose runtime tools live in the builtin registry can still show them). */
  provides?: string[];
  gate: ModuleGate;
  /** Tool adapters this module contributes to the agent loop. */
  tools: ToolAdapter[];
  /**
   * Optional prompt contribution, composed into the system prompt after
   * skills. Loads its own data (e.g. booking loads the service catalog).
   * Return null/'' to contribute nothing this run.
   */
  buildPromptSection?: (ctx: ModulePromptContext) => Promise<string | null>;
  /**
   * Optional zod schema for tenant_modules.config. Validated at admin write
   * time (400 with errors) AND at resolve time (invalid stored config →
   * module inactive, fail closed).
   */
  configSchema?: ZodTypeAny;
}

const catalog = new Map<string, ModuleDefinition>();

export function registerModule(def: ModuleDefinition): void {
  if (catalog.has(def.id)) {
    // Startup failure by design — a duplicate id is a programming error.
    throw new Error(`registerModule: duplicate module id "${def.id}"`);
  }
  catalog.set(def.id, def);
}

export function getModule(id: string): ModuleDefinition | undefined {
  return catalog.get(id);
}

export function allModules(): ModuleDefinition[] {
  return Array.from(catalog.values());
}

/**
 * Template-authoritative skill gating: the set of tool names to DROP when a bot's
 * skills are pinned to `selectedSkillIds`. For every ACTIVE skill the template did
 * NOT select, drop its tools. Uses the UNION of the skill's declared `provides`
 * (which may be a curated subset) and its ACTUAL registered `tools`, so a real tool
 * absent from `provides` (e.g. booking's `list_bookings`) is gated, never leaked.
 * Pure — the caller filters its loaded tool list against this set.
 */
export function gatedToolNames(selectedSkillIds: string[], activeModuleIds: string[]): Set<string> {
  const selected = new Set(selectedSkillIds);
  const drop = new Set<string>();
  for (const id of activeModuleIds) {
    if (selected.has(id)) continue;
    const def = catalog.get(id);
    for (const n of def?.provides ?? []) drop.add(n);
    for (const tl of def?.tools ?? []) drop.add(tl.name);
  }
  return drop;
}

/**
 * The PROMPT-surface twin of gatedToolNames. Whether an active skill's prompt
 * contribution (buildPromptSection) should be included for this bot: when composable
 * gating is on, a skill's prompt is included IFF its template selected it — so a
 * gated skill's guidance (e.g. booking's SERVICES catalog + "you MUST call
 * create_booking") can't leak into the prompt even though its tools were dropped.
 * Flag OFF → legacy behaviour (every active skill's section is included).
 */
export function skillPromptAllowed(moduleId: string, selectedSkillIds: string[], composableEnabled: boolean): boolean {
  return !composableEnabled || selectedSkillIds.includes(moduleId);
}

/** Test seam — clears the catalog so registration tests can re-register. */
export function clearCatalogForTests(): void {
  catalog.clear();
}
