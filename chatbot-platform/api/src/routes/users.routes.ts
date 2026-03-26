/**
 * User Routes
 * Profile management and preferences
 */
import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { AppDataSource } from '../database/data-source';
import { User } from '../database/entities/User';
import { Agent } from '../database/entities/Agent';
import { logger } from '../utils/logger';
import { requireClerkAuth, autoProvision, ProvisionedRequest } from '../middleware/clerk.middleware';
import { resolveTenantContext } from '../middleware/super-admin.middleware';
import { asyncHandler, NotFoundError, BadRequestError, UnauthorizedError } from '../middleware/error-handler';
import { validate } from '../middleware/validate';
import { sendSuccess } from '../utils/response';
import { updateProfileSchema } from '../schemas';

const router = Router();
const userRepository = AppDataSource.getRepository(User);
const agentRepository = AppDataSource.getRepository(Agent);

// All routes require agent authentication
router.use(requireClerkAuth, autoProvision, resolveTenantContext);

/**
 * GET /users/profile
 * Get current user profile
 */
router.get(
  '/profile',
  asyncHandler(async (req: Request, res: Response) => {
    const authReq = req as ProvisionedRequest;
    const agentId = authReq.user?.id;

    const agent = await agentRepository.findOne({
      where: { id: agentId },
      relations: ['user'],
    });

    if (!agent || !agent.user) {
      throw new NotFoundError('User profile not found');
    }

    const user = agent.user;

    sendSuccess(res, {
      profile: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        avatarUrl: user.avatarUrl,
        timezone: user.timezone,
        locale: user.locale,
        isActive: user.isActive,
        emailVerified: user.emailVerified,
        notificationPreferences: user.notificationPreferences,
        lastLoginAt: user.lastLoginAt,
        createdAt: user.createdAt,
      },
    });
  })
);

/**
 * PATCH /users/profile
 * Update user profile
 */
router.patch(
  '/profile',
  validate(updateProfileSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const authReq = req as ProvisionedRequest;
    const agentId = authReq.user?.id;
    const { name, avatarUrl, timezone, locale } = req.body;

    const agent = await agentRepository.findOne({
      where: { id: agentId },
      relations: ['user'],
    });

    if (!agent || !agent.user) {
      throw new NotFoundError('User profile not found');
    }

    const user = agent.user;

    if (name !== undefined) user.name = name;
    if (avatarUrl !== undefined) user.avatarUrl = avatarUrl;
    if (timezone !== undefined) user.timezone = timezone;
    if (locale !== undefined) user.locale = locale;

    await userRepository.save(user);

    sendSuccess(res, {
      profile: {
        id: user.id,
        name: user.name,
        email: user.email,
        avatarUrl: user.avatarUrl,
        timezone: user.timezone,
        locale: user.locale,
      },
    });
  })
);

/**
 * PATCH /users/preferences
 * Update notification preferences
 */
router.patch(
  '/preferences',
  asyncHandler(async (req: Request, res: Response) => {
    const authReq = req as ProvisionedRequest;
    const agentId = authReq.user?.id;
    const { notificationPreferences } = req.body;

    const agent = await agentRepository.findOne({
      where: { id: agentId },
      relations: ['user'],
    });

    if (!agent || !agent.user) {
      throw new NotFoundError('User profile not found');
    }

    const user = agent.user;
    user.notificationPreferences = {
      ...user.notificationPreferences,
      ...notificationPreferences,
    };

    await userRepository.save(user);

    sendSuccess(res, { preferences: user.notificationPreferences });
  })
);

/**
 * PATCH /users/password
 * Change password (verify old, hash new)
 */
router.patch(
  '/password',
  asyncHandler(async (req: Request, res: Response) => {
    const authReq = req as ProvisionedRequest;
    const agentId = authReq.user?.id;
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
      throw new BadRequestError('Current password and new password are required');
    }

    if (newPassword.length < 8) {
      throw new BadRequestError('New password must be at least 8 characters');
    }

    const agent = await agentRepository.findOne({
      where: { id: agentId },
      relations: ['user'],
    });

    if (!agent || !agent.user) {
      throw new NotFoundError('User not found');
    }

    const user = agent.user;

    if (!user.password) {
      throw new BadRequestError('No password set for this account');
    }

    // Verify current password
    const isValid = await bcrypt.compare(currentPassword, user.password);
    if (!isValid) {
      throw new UnauthorizedError('Current password is incorrect');
    }

    // Hash and save new password
    const salt = await bcrypt.genSalt(12);
    user.password = await bcrypt.hash(newPassword, salt);
    user.passwordChangedAt = new Date();

    await userRepository.save(user);

    logger.info('Password changed', { userId: user.id });

    sendSuccess(res, { message: 'Password changed successfully' });
  })
);

export default router;
