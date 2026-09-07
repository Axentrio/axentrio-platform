/**
 * Authentication Routes
 * GET /auth/me - Get current user via Clerk auth + auto-provisioning
 */
import { Router, Response } from 'express';
import { AppDataSource } from '../database/data-source';
import { User } from '../database/entities/User';
import { requireClerkAuth, autoProvision, ProvisionedRequest } from '../middleware/clerk.middleware';
import { asyncHandler } from '../middleware/error-handler';
import { sendSuccess } from '../utils/response';

const router = Router();

/**
 * GET /auth/me
 * Get current authenticated user via Clerk + auto-provisioning
 */
router.get(
  '/me',
  requireClerkAuth,
  autoProvision,
  asyncHandler(async (req: ProvisionedRequest, res: Response) => {
    // Look up locale separately — req.user comes from a small cached struct
    // (id/email/role/tenant) and does not carry user preferences.
    const userId = req.userId;
    const user = userId
      ? await AppDataSource.getRepository(User).findOne({
          where: { id: userId },
          select: ['locale', 'notificationPreferences'],
        })
      : null;

    sendSuccess(res, {
      agentId: req.agentId,
      tenantId: req.tenantId,
      role: req.userRole,
      tenantName: req.tenantName,
      email: req.user?.email,
      locale: user?.locale ?? null,
      notificationPreferences: user?.notificationPreferences ?? null,
    });
  }),
);

export default router;
