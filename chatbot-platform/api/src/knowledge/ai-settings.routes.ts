import { Router } from 'express';
import { asyncHandler } from '../middleware/error-handler';
import { requireClerkAuth, autoProvision } from '../middleware/clerk.middleware';
import { resolveTenantContext } from '../middleware/super-admin.middleware';
import { requireRole } from '../middleware/auth.middleware';
import * as ctrl from './knowledge.controller';

const router = Router();

router.use(requireClerkAuth, autoProvision, resolveTenantContext);

// Read: admin, supervisor
router.get('/ai-settings', requireRole('admin', 'supervisor'), asyncHandler(ctrl.getAiSettings));

// Write: admin only
router.patch('/ai-settings', requireRole('admin'), asyncHandler(ctrl.updateAiSettings));
router.post('/ai-settings/test', requireRole('admin'), asyncHandler(ctrl.testAiSettings));
router.post('/ai-settings/test-chat', requireRole('admin'), asyncHandler(ctrl.testChat));

export default router;
