import { Router, Request, Response, NextFunction } from 'express';
import multer from 'multer';
import { ApiError, asyncHandler } from '../middleware/error-handler';
import { requireClerkAuth, autoProvision } from '../middleware/clerk.middleware';
import { resolveTenantContext } from '../middleware/super-admin.middleware';
import { requireRole } from '../middleware/auth.middleware';
import { placesRateLimiter } from '../middleware/rate-limit.middleware';
import { confirmationAttachmentMaxBytes } from '../booking/booking-providers/confirmation-extras';
import * as ctrl from './scheduler.controller';

const router = Router();

router.use(requireClerkAuth, autoProvision, resolveTenantContext);

// Read: admin / supervisor / agent (super_admin bypasses via middleware).
router.get('/config', requireRole('admin', 'supervisor', 'agent'), asyncHandler(ctrl.getSchedulerConfig));

// Write: admin only.
router.put('/config', requireRole('admin'), asyncHandler(ctrl.updateSchedulerConfig));

// Booking-confirmation email attachments. Their OWN multipart routes rather than fields on
// `PUT /config`: bytes do not belong in a JSON settings payload. Bot-scoped exactly like
// `/config` - the target Agent comes from the same `targetBotId` query contract.
//
// The declared mimetype is only a cheap first filter; the controller re-checks the DETECTED
// bytes, which is the check that actually holds.
const confirmationUpload = multer({
  storage: multer.memoryStorage(),
  // The SAME ceiling the reader enforces, so a file multer accepts can never be dropped later.
  limits: { fileSize: confirmationAttachmentMaxBytes() },
});
router.post(
  '/config/confirmation-attachments',
  requireRole('admin'),
  confirmationUpload.single('file'),
  asyncHandler(ctrl.uploadConfirmationAttachment)
);
router.delete(
  '/config/confirmation-attachments/:attachmentId',
  requireRole('admin'),
  asyncHandler(ctrl.deleteConfirmationAttachment)
);

// Address suggestions for the venue form. POST, not GET, so a partially-typed address never
// lands in a query string, an access log or a referrer header. Rate-limited because each call
// spends a billable element and they fire while somebody types.
router.post('/places/autocomplete', requireRole('admin'), placesRateLimiter, asyncHandler(ctrl.autocompleteVenueAddress));
router.post('/places/select', requireRole('admin'), placesRateLimiter, asyncHandler(ctrl.selectVenueAddress));

// Services catalog (multi-service). Reads for admin/supervisor/agent; mutations admin-only.
router.get('/services', requireRole('admin', 'supervisor', 'agent'), asyncHandler(ctrl.listServices));
router.post('/services', requireRole('admin'), asyncHandler(ctrl.createService));
// Declared BEFORE '/services/:id' — otherwise Express matches 'reorder' as an id and the
// request lands in updateService with a non-uuid param.
router.put('/services/reorder', requireRole('admin'), asyncHandler(ctrl.reorderServices));
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

// Adapter: multer errors (e.g. LIMIT_FILE_SIZE) reach Express before the controller runs, so
// they bypass asyncHandler's ZodError adapter. Convert them to ApiError so the global handler
// emits the standard envelope with the multer code preserved in error.code.
router.use((err: Error, _req: Request, _res: Response, next: NextFunction) => {
  if (err instanceof multer.MulterError) {
    return next(new ApiError(err.message, 400, err.code));
  }
  return next(err);
});

export default router;
