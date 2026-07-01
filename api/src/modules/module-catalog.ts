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

/** Test seam — clears the catalog so registration tests can re-register. */
export function clearCatalogForTests(): void {
  catalog.clear();
}
