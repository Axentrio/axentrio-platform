/**
 * Notification Routes
 * In-memory notification management (no DB entity needed for first deploy)
 */
import { Router, Request, Response } from 'express';
import { requireClerkAuth, autoProvision, ProvisionedRequest } from '../middleware/clerk.middleware';
import { resolveTenantContext } from '../middleware/super-admin.middleware';
import { parsePaginationParams } from '../utils/pagination';
import { asyncHandler, NotFoundError } from '../middleware/error-handler';
import { sendSuccess } from '../utils/response';

const router = Router();

// In-memory notification store
interface Notification {
  id: string;
  userId: string;
  type: string;
  title: string;
  message: string;
  read: boolean;
  createdAt: Date;
  metadata?: Record<string, unknown>;
}

const notificationStore = new Map<string, Notification[]>();

// Helper to get notifications for a user
function getUserNotifications(userId: string): Notification[] {
  if (!notificationStore.has(userId)) {
    notificationStore.set(userId, []);
  }
  return notificationStore.get(userId)!;
}

// All routes require agent authentication
router.use(requireClerkAuth, autoProvision, resolveTenantContext);

/**
 * GET /notifications
 * List notifications for current user
 */
router.get(
  '/',
  asyncHandler(async (req: Request, res: Response) => {
    const authReq = req as ProvisionedRequest;
    const userId = authReq.user?.id!;

    const params = parsePaginationParams(req.query as Record<string, unknown>);
    const unreadOnly = req.query.unread === 'true';

    let notifications = getUserNotifications(userId);

    if (unreadOnly) {
      notifications = notifications.filter((n) => !n.read);
    }

    notifications.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

    const total = notifications.length;
    const offset = (params.page - 1) * params.limit;
    const paginated = notifications.slice(offset, offset + params.limit);
    const totalPages = Math.ceil(total / params.limit);

    sendSuccess(res, paginated, {
      page: params.page,
      limit: params.limit,
      total,
      totalPages,
      hasMore: params.page < totalPages,
      unreadCount: getUserNotifications(userId).filter((n) => !n.read).length,
    });
  })
);

/**
 * PATCH /notifications/:id/read
 * Mark a notification as read
 */
router.patch(
  '/:id/read',
  asyncHandler(async (req: Request, res: Response) => {
    const authReq = req as ProvisionedRequest;
    const userId = authReq.user?.id!;
    const { id } = req.params;

    const notifications = getUserNotifications(userId);
    const notification = notifications.find((n) => n.id === id);

    if (!notification) {
      throw new NotFoundError('Notification not found');
    }

    notification.read = true;

    sendSuccess(res, notification);
  })
);

/**
 * PATCH /notifications/read-all
 * Mark all notifications as read
 */
router.patch(
  '/read-all',
  asyncHandler(async (req: Request, res: Response) => {
    const authReq = req as ProvisionedRequest;
    const userId = authReq.user?.id!;

    const notifications = getUserNotifications(userId);
    notifications.forEach((n) => {
      n.read = true;
    });

    sendSuccess(res, { message: 'All notifications marked as read' });
  })
);

export default router;
