/**
 * Entitlements route — exposes the resolved per-tenant entitlements +
 * marketing-surface plan catalog to the portal.
 *
 * Subscription/feature-access epic — M1 (entitlement SDK backend).
 *
 * GET /entitlements
 *   Authenticated. Returns:
 *     {
 *       current: Entitlements,                  // for the calling tenant
 *       plans: PlanDefinition[],                // catalog of all marketed tiers (filters out `free`)
 *       selfServePlans: InternalPlanId[],       // canonical "show in upgrade UIs" list
 *     }
 *
 * Used by the portal to drive:
 *   - locked-but-visible sidebar (M2)
 *   - feature-gate preview pages (M2)
 *   - pricing/comparison surfaces (M4)
 *   - the `useEntitlement()` hook
 */

import { Router, Request, Response } from 'express';
import { requireClerkAuth, autoProvision } from '../middleware/clerk.middleware';
import { resolveTenantContext } from '../middleware/super-admin.middleware';
import { asyncHandler } from '../middleware/error-handler';
import { sendSuccess } from '../utils/response';
import { getEntitlements } from '../billing/entitlements';
import { PLANS, selfServeCheckoutablePlans } from '../billing/plans';
import type { InternalPlanId } from '../billing/types';
import { listActiveModules } from '../modules';

const router = Router();

router.use(requireClerkAuth, autoProvision, resolveTenantContext);

router.get(
  '/',
  asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const tenantId = req.tenantId!;
    const current = await getEntitlements(tenantId);
    // Active module ids for `useHasModule` (D13). [] for free/non-active
    // tenants even when enablement rows exist (the resolver enforces D2).
    // The resolver's internal entitlement read hits the cache — the double
    // read here is one DB query per TTL window, no recursion.
    const activeModules = (await listActiveModules(tenantId)).map((m) => m.module.id);

    // Catalog of all marketed plans (excludes the `free` cancellation sink).
    // The frontend uses this to render the locked-feature previews and the
    // pricing/comparison page. Includes Enterprise (rank 3) which is now
    // self-serve at €149/mo alongside Essential and Pro.
    const marketedPlans = (Object.values(PLANS) as Array<typeof PLANS[InternalPlanId]>)
      .filter((p) => p.id !== 'free')
      .sort((a, b) => a.rank - b.rank);

    const selfServePlans = selfServeCheckoutablePlans().map((p) => p.id);

    sendSuccess(res, {
      current: { ...current, activeModules },
      plans: marketedPlans,
      selfServePlans,
    });
  }),
);

export default router;
