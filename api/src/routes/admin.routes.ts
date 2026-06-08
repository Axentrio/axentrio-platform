/**
 * Super-admin routes aggregator.
 *
 * Shared auth (Clerk + autoProvision + super-admin) is applied once here, then
 * the sub-routers (which keep their full `/tenants…`, `/users…`, `/analytics`,
 * `/audit-logs…` paths) are mounted. Split out of a single 1175-line file by
 * sub-resource for navigability — behaviour is unchanged.
 */
import { Router } from 'express';
import { requireClerkAuth, autoProvision } from '../middleware/clerk.middleware';
import { requireSuperAdmin } from '../middleware/super-admin.middleware';
import tenantAdminRoutes from './admin/tenant-admin.routes';
import userAdminRoutes from './admin/user-admin.routes';
import reportingAdminRoutes from './admin/reporting-admin.routes';

const router = Router();

// All admin routes require Clerk auth + autoProvision + super admin.
router.use(requireClerkAuth, autoProvision, requireSuperAdmin);

router.use(tenantAdminRoutes);
router.use(userAdminRoutes);
router.use(reportingAdminRoutes);

export default router;
