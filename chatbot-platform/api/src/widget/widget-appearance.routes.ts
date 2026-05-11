import { Router } from 'express';
import { asyncHandler } from '../middleware/error-handler';
import { requireClerkAuth, autoProvision } from '../middleware/clerk.middleware';
import { resolveTenantContext } from '../middleware/super-admin.middleware';
import { requireRole } from '../middleware/auth.middleware';
import {
  getWidgetAppearance,
  updateWidgetAppearance,
} from './widget-appearance.controller';

const router = Router();

router.use(requireClerkAuth, autoProvision, resolveTenantContext);

router.get(
  '/widget-appearance',
  requireRole('admin', 'supervisor'),
  asyncHandler(getWidgetAppearance),
);

router.patch(
  '/widget-appearance',
  requireRole('admin'),
  asyncHandler(updateWidgetAppearance),
);

export default router;
