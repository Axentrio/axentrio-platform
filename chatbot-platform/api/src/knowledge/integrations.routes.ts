import { Router } from 'express';
import { asyncHandler } from '../middleware/error-handler';
import { requireClerkAuth, autoProvision } from '../middleware/clerk.middleware';
import { resolveTenantContext } from '../middleware/super-admin.middleware';
import { requireRole } from '../middleware/auth.middleware';
import * as ctrl from './integrations.controller';

const router = Router();

router.use(requireClerkAuth, autoProvision, resolveTenantContext);

// Read: admin, supervisor
router.get('/integrations', requireRole('admin', 'supervisor'), asyncHandler(ctrl.getIntegrations));

// Write: admin only
router.patch('/integrations', requireRole('admin'), asyncHandler(ctrl.updateIntegrations));
router.post('/integrations/calcom/connect', requireRole('admin'), asyncHandler(ctrl.connectCalcom));
router.get('/integrations/calcom/event-types', requireRole('admin'), asyncHandler(ctrl.getCalcomEventTypes));

export default router;
