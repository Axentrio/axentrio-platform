/**
 * Super-admin entitlement controls — per-tenant feature overrides and
 * bespoke-module enablement (.scratch/plan-entitlements-modules.md, Phase 3).
 *
 * These are the ONLY write paths for Tenant.featureOverrides and
 * tenant_modules (the generic tenant PATCH does not accept them): writes are
 * validated, server-stamped, audit-logged, and invalidate the resolver
 * caches so they take effect immediately.
 */
import { Router, Request, Response } from 'express';
import { AppDataSource } from '../../database/data-source';
import { Tenant } from '../../database/entities/Tenant';
import type { FeatureOverride } from '../../database/entities/Tenant';
import { TenantModule } from '../../database/entities/TenantModule';
import { PLANS, overrideExceedsTier } from '../../billing/plans';
import type { FeatureKey } from '../../billing/types';
import { FEATURE_TAXONOMY, FEATURE_GROUPS } from '../../billing/feature-taxonomy';
import { allModules, getModule, invalidateModules, invalidateEntitlementsAndModules, listActiveModules } from '../../modules';
import { asyncHandler, ValidationError, NotFoundError, ApiError } from '../../middleware/error-handler';
import { sendSuccess } from '../../utils/response';
import { logAudit } from '../../utils/audit';

const router = Router();

/** Canonical feature key set — derived from the plan catalog. */
const FEATURE_KEYS = new Set(Object.keys(PLANS.free.features));

function adminIdentity(req: Request): string {
  return (req as { user?: { email?: string } }).user?.email ?? req.userId ?? 'super-admin';
}

async function loadTenant(id: string): Promise<Tenant> {
  const tenant = await AppDataSource.getRepository(Tenant).findOne({ where: { id } });
  if (!tenant) throw new NotFoundError('Tenant not found');
  return tenant;
}

/**
 * Validates one wire override entry and returns the stamped record, or null
 * when the entry is an explicit deletion ("tier default").
 */
function normalizeOverride(
  key: string,
  entry: unknown,
  existing: FeatureOverride | undefined,
  setBy: string,
  setAt: string,
): FeatureOverride | null {
  if (!FEATURE_KEYS.has(key)) throw new ValidationError(`Unknown feature key: ${key}`);
  if (entry === null) return null; // explicit null = no override (deletion)
  if (typeof entry !== 'object' || Array.isArray(entry)) {
    throw new ValidationError(`Override for "${key}" must be { value, reason } or null`);
  }
  const { value, reason } = entry as { value?: unknown; reason?: unknown };
  if (typeof value !== 'boolean') {
    throw new ValidationError(`Override for "${key}": value must be a boolean`);
  }
  if (typeof reason !== 'string' || !reason.trim()) {
    throw new ValidationError(`Override for "${key}": a non-empty reason is required`);
  }
  // Preserve original provenance when the override is unchanged; restamp on
  // any value/reason change.
  return existing && existing.value === value && existing.reason === reason.trim()
    ? existing
    : { value, reason: reason.trim().slice(0, 500), setBy, setAt };
}

// ── Feature overrides ────────────────────────────────────────────────────────

// GET /admin/tenants/:id/feature-overrides — overrides + tier defaults for the
// tri-state UI ("tier default" vs "forced on/off" with provenance).
router.get(
  '/tenants/:id/feature-overrides',
  asyncHandler(async (req: Request, res: Response) => {
    const tenant = await loadTenant(req.params.id);
    sendSuccess(res, {
      tier: tenant.tier,
      tierDefaults: PLANS[tenant.tier].features,
      overrides: tenant.featureOverrides ?? {},
      // UI structure: labels, logical groups, parent dependencies.
      taxonomy: FEATURE_TAXONOMY,
      groups: FEATURE_GROUPS,
    });
  }),
);

// PUT /admin/tenants/:id/feature-overrides — replaces the FULL override map.
// Body: { [featureKey]: { value: boolean, reason: string } | null }
// A feature absent from the body (or explicit null) loses its override and
// returns to tier default — the tri-state's "tier default" is a deletion.
router.put(
  '/tenants/:id/feature-overrides',
  asyncHandler(async (req: Request, res: Response) => {
    const tenant = await loadTenant(req.params.id);
    const rawBody = req.body as Record<string, unknown>;
    if (!rawBody || typeof rawBody !== 'object' || Array.isArray(rawBody)) {
      throw new ValidationError('Body must be an object mapping feature keys to overrides');
    }
    // Backward-compatible wire shape. The portal used to POST the bare feature
    // map; it now POSTs { overrides, confirmAboveTier }. The API and portal deploy
    // INDEPENDENTLY, so accept BOTH — a cached portal must keep working.
    const wrapped =
      typeof rawBody.overrides === 'object' &&
      rawBody.overrides !== null &&
      !Array.isArray(rawBody.overrides);
    const body = (wrapped ? rawBody.overrides : rawBody) as Record<string, unknown>;
    const confirmAboveTier = rawBody.confirmAboveTier === true;

    const setBy = adminIdentity(req);
    const setAt = new Date().toISOString();
    const next: Record<string, FeatureOverride> = {};
    // Grants that turn a feature ON above the tenant's plan AND are new or changed
    // versus the stored map. An above-plan comp stays allowed, but only with an
    // explicit confirmation, so an accidental flip cannot silently enable, for
    // example, booking on an Essential tenant.
    const aboveTierNew: string[] = [];

    for (const [key, entry] of Object.entries(body)) {
      const existing = tenant.featureOverrides?.[key];
      const override = normalizeOverride(key, entry, existing, setBy, setAt);
      if (override === null) continue;
      next[key] = override;
      // A grant is "new above-tier" only when it exceeds the plan AND was not
      // already granted — so re-saving an existing comp, or editing an unrelated
      // key, never re-prompts.
      if (
        overrideExceedsTier(tenant.tier, key as FeatureKey, override.value) &&
        existing?.value !== true
      ) {
        aboveTierNew.push(key);
      }
    }

    if (aboveTierNew.length && !confirmAboveTier) {
      throw new ApiError(
        `Granting ${aboveTierNew.join(', ')} above the ${tenant.tier} plan needs confirmation.`,
        400,
        'above_tier_confirmation_required',
        { featureKeys: aboveTierNew },
      );
    }

    tenant.featureOverrides = next;
    await AppDataSource.getRepository(Tenant).save(tenant);
    // Overrides change resolved features → feature-gated modules must re-resolve.
    await invalidateEntitlementsAndModules(tenant.id);
    await logAudit(req.userId!, 'tenant.feature_overrides_updated', 'tenant', tenant.id, tenant.id, {
      overrides: Object.fromEntries(Object.entries(next).map(([k, v]) => [k, v.value])),
      aboveTier: aboveTierNew,
    });

    sendSuccess(res, {
      tier: tenant.tier,
      tierDefaults: PLANS[tenant.tier].features,
      overrides: next,
      taxonomy: FEATURE_TAXONOMY,
      groups: FEATURE_GROUPS,
    });
  }),
);

// ── Module enablement (bespoke modules only) ────────────────────────────────

// GET /admin/tenants/:id/modules — every enablement-gated catalog module with
// this tenant's row state + resolved activeness.
router.get(
  '/tenants/:id/modules',
  asyncHandler(async (req: Request, res: Response) => {
    const tenant = await loadTenant(req.params.id);
    const rows = await AppDataSource.getRepository(TenantModule).find({ where: { tenantId: tenant.id } });
    const activeIds = new Set((await listActiveModules(tenant.id)).map((m) => m.module.id));
    const modules = allModules()
      .filter((m) => m.gate.kind === 'enablement')
      .map((m) => {
        const row = rows.find((r) => r.moduleId === m.id);
        return {
          id: m.id,
          displayName: m.displayName,
          hasConfigSchema: !!m.configSchema,
          enabled: row?.enabled ?? false,
          config: row?.config ?? {},
          reason: row?.reason ?? null,
          setBy: row?.setBy ?? null,
          updatedAt: row?.updatedAt ?? null,
          active: activeIds.has(m.id),
        };
      });
    sendSuccess(res, { modules });
  }),
);

// PUT /admin/tenants/:id/modules/:moduleId — upsert one module's enablement.
// Body: { enabled: boolean, reason: string, config?: object }
// Disabling upserts enabled=false (config + audit preserved for re-enable);
// rows are never deleted. Feature-gated module ids are rejected — their
// activeness is the entitlement, and a row would be misleading dead state.
router.put(
  '/tenants/:id/modules/:moduleId',
  asyncHandler(async (req: Request, res: Response) => {
    const tenant = await loadTenant(req.params.id);
    const { moduleId } = req.params;

    const def = getModule(moduleId);
    if (!def) throw new NotFoundError(`Unknown module: ${moduleId}`);
    if (def.gate.kind !== 'enablement') {
      throw new ValidationError(
        `Module "${moduleId}" is feature-gated (${def.gate.feature}) — manage it via the tenant's plan or a feature override, not a module row`,
      );
    }

    const { enabled, reason, config } = (req.body ?? {}) as {
      enabled?: unknown;
      reason?: unknown;
      config?: unknown;
    };
    if (typeof enabled !== 'boolean') throw new ValidationError('enabled must be a boolean');
    if (typeof reason !== 'string' || !reason.trim()) {
      throw new ValidationError('a non-empty reason is required');
    }
    let nextConfig: Record<string, unknown> | undefined;
    if (config !== undefined) {
      if (!config || typeof config !== 'object' || Array.isArray(config)) {
        throw new ValidationError('config must be an object');
      }
      if (def.configSchema) {
        const parsed = def.configSchema.safeParse(config);
        if (!parsed.success) {
          // 400 with the validation errors — an admin must never save config
          // that would silently deactivate the module at resolve time.
          throw new ValidationError(
            `config fails the module schema: ${parsed.error.issues
              .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
              .join('; ')}`,
          );
        }
        nextConfig = parsed.data as Record<string, unknown>;
      } else {
        nextConfig = config as Record<string, unknown>;
      }
    }

    const repo = AppDataSource.getRepository(TenantModule);
    let row = await repo.findOne({ where: { tenantId: tenant.id, moduleId } });
    if (!row) {
      row = repo.create({ tenantId: tenant.id, moduleId, config: {} });
    }
    row.enabled = enabled;
    row.reason = reason.trim().slice(0, 500);
    row.setBy = adminIdentity(req);
    if (nextConfig !== undefined) row.config = nextConfig;
    await repo.save(row);

    await invalidateModules(tenant.id);
    await logAudit(req.userId!, 'tenant.module_updated', 'tenant', tenant.id, tenant.id, {
      moduleId,
      enabled,
    });

    sendSuccess(res, {
      id: moduleId,
      enabled: row.enabled,
      config: row.config,
      reason: row.reason,
      setBy: row.setBy,
    });
  }),
);

export default router;
