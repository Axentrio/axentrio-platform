import { Router } from 'express';
import { asyncHandler } from '../middleware/error-handler';
import { requireClerkAuth, autoProvision } from '../middleware/clerk.middleware';
import { resolveTenantContext } from '../middleware/super-admin.middleware';
import * as ctrl from './knowledge.controller';

const router = Router();

// All routes require agent authentication
router.use(requireClerkAuth, autoProvision, resolveTenantContext);

router.get('/ai-settings', asyncHandler(ctrl.getAiSettings));
router.patch('/ai-settings', asyncHandler(ctrl.updateAiSettings));
router.post('/ai-settings/test', asyncHandler(ctrl.testAiSettings));

export default router;
