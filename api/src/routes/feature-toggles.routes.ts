/**
 * Tenant feature-toggle route — lets a tenant's OWN admin switch
 * entitlement-clamped features on/off for themselves. Mounted at /tenants/me.
 *
 * Plan: .scratch/plan-tenant-feature-toggles.md § 4 / § 9b.
 *
 * PUT /tenants/me/feature-toggles
 *   Body: { [ToggleableFeatureKey]: boolean }  — the FULL desired toggle map
 *   (PUT semantics: replaces the stored map; absent key = default-on).
 *     - admin only (super-admin also allowed by requireRole)
 *     - a key outside TENANT_TOGGLEABLE_FEATURES → 400
 *     - enabling a feature the plan doesn't grant → 400, validated against the
 *       entitlement CEILING (entitledFeatures), never effective features —
 *       so a previously-disabled-but-entitled feature can always be re-enabled.
 *       Turning a feature OFF is always allowed.
 *     - atomic write to the dedicated `feature_toggles` column (isolated from the
 *       shared `settings` blob — no other settings writer can clobber it).
 *     - invalidates the entitlement cache + writes an audit event.
 *
 * No GET here — GET /entitlements already returns `featureToggles` +
 * `entitledFeatures` for the settings UI.
 */
import { Router, Request, Response } from 'express';
import { requireClerkAuth, autoProvision } from '../middleware/clerk.middleware';
import { resolveTenantContext } from '../middleware/super-admin.middleware';
import { requireRole } from '../middleware/auth.middleware';
import { asyncHandler, ValidationError } from '../middleware/error-handler';
import { sendSuccess } from '../utils/response';
import { AppDataSource } from '../database/data-source';
import { getEntitlements } from '../billing/entitlements';
import { invalidateEntitlementsAndModules } from '../modules';
import { isToggleableFeature } from '../billing/feature-toggles';
import { logAudit } from '../utils/audit';
import type { TenantFeatureToggles } from '../contracts/entitlements';

const router = Router();

router.use(requireClerkAuth, autoProvision, resolveTenantContext);

router.put(
  '/feature-toggles',
  requireRole('admin'),
  asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const tenantId = req.tenantId!;
    const body = req.body as Record<string, unknown>;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new ValidationError('Body must be an object mapping feature keys to booleans');
    }

    // Resolve the entitlement ceiling once — the clamp checks against this, not
    // effective features, so a disabled-but-entitled feature can be re-enabled.
    const { entitledFeatures } = await getEntitlements(tenantId);

    const next: TenantFeatureToggles = {};
    for (const [key, value] of Object.entries(body)) {
      if (!isToggleableFeature(key)) {
        throw new ValidationError(`Feature "${key}" is not tenant-toggleable`);
      }
      if (typeof value !== 'boolean') {
        throw new ValidationError(`Toggle for "${key}" must be a boolean`);
      }
      if (value && !entitledFeatures[key]) {
        throw new ValidationError(`Feature "${key}" is not included in your plan`);
      }
      next[key] = value;
    }

    // Atomic write to the dedicated feature_toggles column — isolated from the
    // shared `settings` blob, so no other settings writer can clobber it and the
    // super-admin settings-merge can't reach it. Full-map replace (PUT semantics).
    await AppDataSource.query(
      `UPDATE tenants SET feature_toggles = $2::jsonb, updated_at = now() WHERE id = $1`,
      [tenantId, JSON.stringify(next)],
    );

    // Invalidate BOTH caches: entitlements AND the module resolver. Feature-
    // gated modules (e.g. the booking module) derive their activeness from
    // entitlements.features, and the resolver caches the active-module list on
    // its own 60s TTL — without this, a just-toggled-off feature keeps its
    // agent tools (e.g. the bot still tries to book) until that TTL lapses.
    await invalidateEntitlementsAndModules(tenantId);
    await logAudit(req.userId!, 'tenant.feature_toggles_updated', 'tenant', tenantId, tenantId, {
      featureToggles: next,
    });

    // Return a coherent post-write snapshot (effective + ceiling + stored prefs)
    // so the client refreshes without a second round-trip.
    const updated = await getEntitlements(tenantId);
    sendSuccess(res, {
      featureToggles: updated.featureToggles,
      entitledFeatures: updated.entitledFeatures,
      features: updated.features,
    });
  }),
);

export default router;
