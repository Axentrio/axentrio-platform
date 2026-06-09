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

// Services catalog (multi-service). Reads for admin/supervisor/agent; mutations admin-only.
router.get('/services', requireRole('admin', 'supervisor', 'agent'), asyncHandler(ctrl.listServices));
router.post('/services', requireRole('admin'), asyncHandler(ctrl.createService));
router.put('/services/:id', requireRole('admin'), asyncHandler(ctrl.updateService));
router.delete('/services/:id', requireRole('admin'), asyncHandler(ctrl.deleteService));

// Business-type presets (P4). Read for admin/supervisor/agent; apply admin-only.
router.get('/presets', requireRole('admin', 'supervisor', 'agent'), asyncHandler(ctrl.listPresets));
router.post('/presets/:key/apply', requireRole('admin'), asyncHandler(ctrl.applyPreset));

// Bookings management (internal provider). Reads for admin/supervisor/agent;
// mutations admin-only.
router.get('/bookings', requireRole('admin', 'supervisor', 'agent'), asyncHandler(ctrl.listBookings));
router.get('/availability', requireRole('admin', 'supervisor', 'agent'), asyncHandler(ctrl.getBookingAvailability));
router.post('/bookings/:id/cancel', requireRole('admin'), asyncHandler(ctrl.cancelBooking));
router.post('/bookings/:id/reschedule', requireRole('admin'), asyncHandler(ctrl.rescheduleBooking));
router.post('/bookings/:id/accept', requireRole('admin'), asyncHandler(ctrl.acceptRequest));
router.post('/bookings/:id/decline', requireRole('admin'), asyncHandler(ctrl.declineRequest));

export default router;
