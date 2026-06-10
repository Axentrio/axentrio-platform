/**
 * Module resolver — the single source of truth for "is module X active for
 * tenant Y right now?" (.scratch/plan-entitlements-modules.md, D13).
 *
 * Callable from the agent runtime AND the HTTP layer. Gate kinds are
 * exclusive: feature-gated modules read RESOLVED entitlements only;
 * enablement-gated modules read their tenant_modules row only. Both sit
 * behind the global D2 billable precheck — a free/suspended/cancelled tenant
 * activates nothing, even with enabled rows.
 *
 * Fail-closed everywhere: unknown module ids, malformed rows, invalid config,
 * and resolution errors all resolve inactive.
 *
 * Caching mirrors the entitlement resolver: tenant_modules rows are cached
 * per tenant with a short TTL; `invalidateModules` MUST be called on every
 * tenant_modules write. Resolver output is computed per call from the two
 * cached inputs (entitlements + rows) — no third cache layer.
 */
import { AppDataSource } from '../database/data-source';
import { TenantModule } from '../database/entities/TenantModule';
import { getEntitlements } from '../billing/entitlements';
import { PlanLimitError } from '../billing/enforce';
import type { FeatureKey } from '../billing/types';
import { cached, invalidate } from '../utils/cache';
import { logger } from '../utils/logger';
import { allModules, getModule, type ModuleDefinition } from './module-catalog';

const MODULES_TTL_SECONDS = 60;
const modulesCacheKey = (tenantId: string) => `tenant-modules:${tenantId}`;

export interface ActiveModule {
  module: ModuleDefinition;
  /** Validated config ({} for feature-gated modules). */
  config: Record<string, unknown>;
}

interface TenantModuleRow {
  moduleId: string;
  enabled: boolean;
  config: Record<string, unknown>;
}

async function getTenantModuleRows(tenantId: string): Promise<TenantModuleRow[]> {
  return cached(modulesCacheKey(tenantId), MODULES_TTL_SECONDS, async () => {
    const rows = await AppDataSource.getRepository(TenantModule).find({
      where: { tenantId },
      select: ['moduleId', 'enabled', 'config'],
    });
    return rows.map((r) => ({ moduleId: r.moduleId, enabled: r.enabled, config: r.config ?? {} }));
  });
}

/** MUST be called after any write to tenant_modules for the tenant. */
export async function invalidateModules(tenantId: string): Promise<void> {
  await invalidate(modulesCacheKey(tenantId));
}

function resolveOne(
  tenantId: string,
  def: ModuleDefinition,
  entitled: (feature: FeatureKey) => boolean,
  rows: TenantModuleRow[],
): ActiveModule | null {
  if (def.gate.kind === 'feature') {
    // Feature-gated: entitlements ONLY — rows are never consulted.
    return entitled(def.gate.feature) ? { module: def, config: {} } : null;
  }
  // Enablement-gated: row ONLY (absent row or enabled=false → inactive).
  const row = rows.find((r) => r.moduleId === def.id);
  if (!row?.enabled) return null;
  const config = row.config && typeof row.config === 'object' && !Array.isArray(row.config) ? row.config : {};
  if (def.configSchema) {
    const parsed = def.configSchema.safeParse(config);
    if (!parsed.success) {
      logger.warn('[Modules] stored config fails schema — module inactive (fail closed)', {
        tenantId,
        moduleId: def.id,
        issues: parsed.error.issues.slice(0, 5),
      });
      return null;
    }
    return { module: def, config: parsed.data as Record<string, unknown> };
  }
  return { module: def, config };
}

/**
 * All modules active for the tenant right now. `[]` for free/non-active
 * tenants regardless of rows (D2), and on resolution errors (fail closed).
 */
export async function listActiveModules(tenantId: string): Promise<ActiveModule[]> {
  let entitlements;
  try {
    entitlements = await getEntitlements(tenantId);
  } catch (error) {
    logger.warn('[Modules] entitlement resolution failed — no modules active (fail closed)', {
      tenantId,
      error,
    });
    return [];
  }
  if (!entitlements.billable) return [];

  const defs = allModules();
  const needsRows = defs.some((d) => d.gate.kind === 'enablement');
  const rows = needsRows ? await getTenantModuleRows(tenantId).catch(() => []) : [];

  const active: ActiveModule[] = [];
  for (const def of defs) {
    const resolved = resolveOne(tenantId, def, (feature) => entitlements.features[feature] === true, rows);
    if (resolved) active.push(resolved);
  }
  return active;
}

/** Is one module active? Unknown ids resolve inactive (fail closed). */
export async function isModuleActive(tenantId: string, moduleId: string): Promise<boolean> {
  if (!getModule(moduleId)) return false;
  const active = await listActiveModules(tenantId);
  return active.some((a) => a.module.id === moduleId);
}

/**
 * HTTP-layer gate: throw the standard 402 plan-limit envelope when the module
 * is not active for the tenant.
 */
export async function requireModule(tenantId: string, moduleId: string): Promise<void> {
  if (!(await isModuleActive(tenantId, moduleId))) {
    throw new PlanLimitError(`plan_limit_module_${moduleId}`, null, { moduleId });
  }
}
