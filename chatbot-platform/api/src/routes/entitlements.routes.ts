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

const router = Router();

router.use(requireClerkAuth, autoProvision, resolveTenantContext);

router.get(
  '/',
  asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const tenantId = req.tenantId!;
    const current = await getEntitlements(tenantId);

    // Catalog of all marketed plans (excludes the `free` cancellation sink).
    // The frontend uses this to render the locked-feature previews and the
    // pricing/comparison page. Includes Enterprise (rank 3) so the upgrade
    // story can show a Contact Sales row alongside the self-serve tiers.
    const marketedPlans = (Object.values(PLANS) as Array<typeof PLANS[InternalPlanId]>)
      .filter((p) => p.id !== 'free')
      .sort((a, b) => a.rank - b.rank);

    const selfServePlans = selfServeCheckoutablePlans().map((p) => p.id);

    sendSuccess(res, {
      current,
      plans: marketedPlans,
      selfServePlans,
    });
  }),
);

export default router;
