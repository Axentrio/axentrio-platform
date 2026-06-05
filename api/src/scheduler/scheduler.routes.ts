import { Router } from 'express';
import { asyncHandler } from '../middleware/error-handler';
import { requireClerkAuth, autoProvision } from '../middleware/clerk.middleware';
import { resolveTenantContext } from '../middleware/super-admin.middleware';
import { requireRole } from '../middleware/auth.middleware';
import * as ctrl from './scheduler.controller';

const router = Router();

router.use(requireClerkAuth, autoProvision, resolveTenantContext);

// Read: admin / supervisor / agent (super_admin bypasses via middleware).
router.get('/config', requireRole('admin', 'supervisor', 'agent'), asyncHandler(ctrl.getSchedulerConfig));

// Write: admin only.
router.put('/config', requireRole('admin'), asyncHandler(ctrl.updateSchedulerConfig));

export default router;
