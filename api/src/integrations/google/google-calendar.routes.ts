import { Router } from 'express';
import { asyncHandler } from '../../middleware/error-handler';
import { requireClerkAuth, autoProvision } from '../../middleware/clerk.middleware';
import { resolveTenantContext } from '../../middleware/super-admin.middleware';
import { requireRole } from '../../middleware/auth.middleware';
import * as ctrl from './google-calendar.controller';

/** Public — Google redirects the browser here after consent (no auth header). */
export const googleCalendarCallbackRouter = Router();
googleCalendarCallbackRouter.get('/callback', asyncHandler(ctrl.googleCallback));

/** Authenticated (admin) — initiate connect, check status, disconnect. */
const router = Router();
router.use(requireClerkAuth, autoProvision, resolveTenantContext);
router.get('/connect-url', requireRole('admin'), asyncHandler(ctrl.getGoogleConnectUrl));
router.get('/status', requireRole('admin', 'supervisor', 'agent'), asyncHandler(ctrl.getGoogleStatus));
router.delete('/disconnect', requireRole('admin'), asyncHandler(ctrl.disconnectGoogle));
router.get('/calendars', requireRole('admin', 'supervisor'), asyncHandler(ctrl.listGoogleCalendars));
router.put('/calendar', requireRole('admin'), asyncHandler(ctrl.setGoogleCalendar));

export default router;
