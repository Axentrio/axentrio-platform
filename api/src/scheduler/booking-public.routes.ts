/**
 * Public self-service booking routes (no Clerk auth — the signed token is the
 * authorization). Mounted before the Clerk middleware in server.ts.
 */
import { Router } from 'express';
import { asyncHandler } from '../middleware/error-handler';
import * as ctrl from './booking-public.controller';

export const bookingPublicRouter = Router();

bookingPublicRouter.get('/manage', asyncHandler(ctrl.getManagePage));
bookingPublicRouter.post('/manage/cancel', asyncHandler(ctrl.postCancel));
bookingPublicRouter.get('/manage/reschedule', asyncHandler(ctrl.getReschedulePage));
bookingPublicRouter.post('/manage/reschedule', asyncHandler(ctrl.postReschedule));
