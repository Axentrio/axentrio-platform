/**
 * Notification Routes
 * In-memory notification management (no DB entity needed for first deploy)
 */
import { Router, Request, Response } from 'express';
import { logger } from '../utils/logger';
import { requireClerkAuth, autoProvision, ProvisionedRequest } from '../middleware/clerk.middleware';
import { resolveTenantContext } from '../middleware/super-admin.middleware';
import { parsePaginationParams } from '../utils/pagination';

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
  async (req: Request, res: Response): Promise<void> => {
    try {
      const authReq = req as ProvisionedRequest;
      const userId = authReq.user?.id;

      if (!userId) {
        res.status(401).json({ error: 'Not authenticated' });
        return;
      }

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

      res.json({
        success: true,
        notifications: paginated,
        meta: {
          page: params.page,
          limit: params.limit,
          total,
          totalPages,
          hasMore: params.page < totalPages,
        },
        unreadCount: getUserNotifications(userId).filter((n) => !n.read).length,
      });
    } catch (error) {
      logger.error('Error fetching notifications:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

/**
 * PATCH /notifications/:id/read
 * Mark a notification as read
 */
router.patch(
  '/:id/read',
  async (req: Request, res: Response): Promise<void> => {
    try {
      const authReq = req as ProvisionedRequest;
      const userId = authReq.user?.id;
      const { id } = req.params;

      if (!userId) {
        res.status(401).json({ error: 'Not authenticated' });
        return;
      }

      const notifications = getUserNotifications(userId);
      const notification = notifications.find((n) => n.id === id);

      if (!notification) {
        res.status(404).json({ error: 'Notification not found' });
        return;
      }

      notification.read = true;

      res.json({
        success: true,
        notification,
      });
    } catch (error) {
      logger.error('Error marking notification as read:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

/**
 * PATCH /notifications/read-all
 * Mark all notifications as read
 */
router.patch(
  '/read-all',
  async (req: Request, res: Response): Promise<void> => {
    try {
      const authReq = req as ProvisionedRequest;
      const userId = authReq.user?.id;

      if (!userId) {
        res.status(401).json({ error: 'Not authenticated' });
        return;
      }

      const notifications = getUserNotifications(userId);
      notifications.forEach((n) => {
        n.read = true;
      });

      res.json({
        success: true,
        message: 'All notifications marked as read',
      });
    } catch (error) {
      logger.error('Error marking all notifications as read:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

export default router;
