/**
 * Notification Routes
 * DB-backed operator notifications (replaces the legacy in-memory store).
 * Response shape is unchanged so existing clients keep working.
 */
import { Router, Request, Response } from 'express';
import { requireClerkAuth, autoProvision, ProvisionedRequest } from '../middleware/clerk.middleware';
import { resolveTenantContext } from '../middleware/super-admin.middleware';
import { parsePaginationParams } from '../utils/pagination';
import { asyncHandler, NotFoundError } from '../middleware/error-handler';
import { sendSuccess } from '../utils/response';
import { notificationService } from '../services/notification.service';

const router = Router();

// All routes require agent authentication
router.use(requireClerkAuth, autoProvision, resolveTenantContext);

/**
 * GET /notifications
 * List notifications for the current user.
 */
router.get(
  '/',
  asyncHandler(async (req: Request, res: Response) => {
    const authReq = req as ProvisionedRequest;
    const recipientUserId = authReq.userId!;
    const params = parsePaginationParams(req.query as Record<string, unknown>);
    const unreadOnly = req.query.unread === 'true';

    const { items, total, unreadCount } = await notificationService.list({
      recipientUserId,
      unreadOnly,
      page: params.page,
      limit: params.limit,
    });
    const totalPages = Math.ceil(total / params.limit);

    sendSuccess(res, items, {
      page: params.page,
      limit: params.limit,
      total,
      totalPages,
      hasMore: params.page < totalPages,
      unreadCount,
    });
  }),
);

/**
 * PATCH /notifications/read-all
 * Mark all notifications as read.
 */
router.patch(
  '/read-all',
  asyncHandler(async (req: Request, res: Response) => {
    const authReq = req as ProvisionedRequest;
    await notificationService.markAllRead(authReq.userId!);
    sendSuccess(res, { message: 'All notifications marked as read' });
  }),
);

/**
 * PATCH /notifications/:id/read
 * Mark a notification as read.
 */
router.patch(
  '/:id/read',
  asyncHandler(async (req: Request, res: Response) => {
    const authReq = req as ProvisionedRequest;
    const notification = await notificationService.markRead(authReq.userId!, req.params.id);
    if (!notification) {
      throw new NotFoundError('Notification not found');
    }
    sendSuccess(res, notification);
  }),
);

export default router;
