import { Router } from 'express';
import { asyncHandler } from '../../middleware/error-handler';
import { requireClerkAuth, autoProvision } from '../../middleware/clerk.middleware';
import { resolveTenantContext } from '../../middleware/super-admin.middleware';
import { requireRole } from '../../middleware/auth.middleware';
import * as ctrl from './outlook-calendar.controller';

/** Public — Microsoft redirects the browser here after consent (no auth header). */
export const outlookCalendarCallbackRouter = Router();
outlookCalendarCallbackRouter.get('/callback', asyncHandler(ctrl.outlookCallback));

/** Authenticated (admin) — initiate connect, check status, disconnect. */
const router = Router();
router.use(requireClerkAuth, autoProvision, resolveTenantContext);
router.get('/connect-url', requireRole('admin'), asyncHandler(ctrl.getOutlookConnectUrl));
router.get('/status', requireRole('admin', 'supervisor', 'agent'), asyncHandler(ctrl.getOutlookStatus));
router.delete('/disconnect', requireRole('admin'), asyncHandler(ctrl.disconnectOutlook));

export default router;
