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

// Bookings management (internal provider). Reads for admin/supervisor/agent;
// mutations admin-only.
router.get('/bookings', requireRole('admin', 'supervisor', 'agent'), asyncHandler(ctrl.listBookings));
router.get('/availability', requireRole('admin', 'supervisor', 'agent'), asyncHandler(ctrl.getBookingAvailability));
router.post('/bookings/:id/cancel', requireRole('admin'), asyncHandler(ctrl.cancelBooking));
router.post('/bookings/:id/reschedule', requireRole('admin'), asyncHandler(ctrl.rescheduleBooking));

export default router;
