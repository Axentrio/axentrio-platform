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
  async (req: Request, res: Response): Promise<void> => {
    try {
      const authReq = req as ProvisionedRequest;
      const agentId = authReq.user?.id;

      const agent = await agentRepository.findOne({
        where: { id: agentId },
        relations: ['user'],
      });

      if (!agent || !agent.user) {
        res.status(404).json({ error: 'User profile not found' });
        return;
      }

      const user = agent.user;

      res.json({
        success: true,
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
    } catch (error) {
      logger.error('Error fetching user profile:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

/**
 * PATCH /users/profile
 * Update user profile
 */
router.patch(
  '/profile',
  async (req: Request, res: Response): Promise<void> => {
    try {
      const authReq = req as ProvisionedRequest;
      const agentId = authReq.user?.id;
      const { name, avatarUrl, timezone, locale } = req.body;

      const agent = await agentRepository.findOne({
        where: { id: agentId },
        relations: ['user'],
      });

      if (!agent || !agent.user) {
        res.status(404).json({ error: 'User profile not found' });
        return;
      }

      const user = agent.user;

      if (name !== undefined) user.name = name;
      if (avatarUrl !== undefined) user.avatarUrl = avatarUrl;
      if (timezone !== undefined) user.timezone = timezone;
      if (locale !== undefined) user.locale = locale;

      await userRepository.save(user);

      res.json({
        success: true,
        profile: {
          id: user.id,
          name: user.name,
          email: user.email,
          avatarUrl: user.avatarUrl,
          timezone: user.timezone,
          locale: user.locale,
        },
      });
    } catch (error) {
      logger.error('Error updating user profile:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

/**
 * PATCH /users/preferences
 * Update notification preferences
 */
router.patch(
  '/preferences',
  async (req: Request, res: Response): Promise<void> => {
    try {
      const authReq = req as ProvisionedRequest;
      const agentId = authReq.user?.id;
      const { notificationPreferences } = req.body;

      const agent = await agentRepository.findOne({
        where: { id: agentId },
        relations: ['user'],
      });

      if (!agent || !agent.user) {
        res.status(404).json({ error: 'User profile not found' });
        return;
      }

      const user = agent.user;
      user.notificationPreferences = {
        ...user.notificationPreferences,
        ...notificationPreferences,
      };

      await userRepository.save(user);

      res.json({
        success: true,
        preferences: user.notificationPreferences,
      });
    } catch (error) {
      logger.error('Error updating preferences:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

/**
 * PATCH /users/password
 * Change password (verify old, hash new)
 */
router.patch(
  '/password',
  async (req: Request, res: Response): Promise<void> => {
    try {
      const authReq = req as ProvisionedRequest;
      const agentId = authReq.user?.id;
      const { currentPassword, newPassword } = req.body;

      if (!currentPassword || !newPassword) {
        res.status(400).json({ error: 'Current password and new password are required' });
        return;
      }

      if (newPassword.length < 8) {
        res.status(400).json({ error: 'New password must be at least 8 characters' });
        return;
      }

      const agent = await agentRepository.findOne({
        where: { id: agentId },
        relations: ['user'],
      });

      if (!agent || !agent.user) {
        res.status(404).json({ error: 'User not found' });
        return;
      }

      const user = agent.user;

      if (!user.password) {
        res.status(400).json({ error: 'No password set for this account' });
        return;
      }

      // Verify current password
      const isValid = await bcrypt.compare(currentPassword, user.password);
      if (!isValid) {
        res.status(401).json({ error: 'Current password is incorrect' });
        return;
      }

      // Hash and save new password
      const salt = await bcrypt.genSalt(12);
      user.password = await bcrypt.hash(newPassword, salt);
      user.passwordChangedAt = new Date();

      await userRepository.save(user);

      logger.info('Password changed', { userId: user.id });

      res.json({
        success: true,
        message: 'Password changed successfully',
      });
    } catch (error) {
      logger.error('Error changing password:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

export default router;
