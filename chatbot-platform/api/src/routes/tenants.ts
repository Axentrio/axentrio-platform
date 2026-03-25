/**
 * Tenant Routes
 * Tenant management and configuration
 */

import crypto from 'crypto';
import { Router, Request, Response } from 'express';
import { AppDataSource } from '../database/data-source';
import { Tenant } from '../database/entities/Tenant';
import { User } from '../database/entities/User';
import { requireAdmin, asyncHandler, ValidationError, NotFoundError } from '../middleware';
import { requireClerkAuth, autoProvision } from '../middleware/clerk.middleware';
import { logger } from '../utils/logger';

function generateApiKey(): string {
  return crypto.randomBytes(32).toString('hex');
}

const router = Router();

/**
 * Get current tenant
 * GET /api/v1/tenants/me
 */
router.get(
  '/me',
  requireClerkAuth, autoProvision,
  asyncHandler(async (req: Request, res: Response) => {
    const tenantId = req.user!.tenantId;

    const tenantRepository = AppDataSource.getRepository(Tenant);
    const tenant = await tenantRepository.findOne({
      where: { id: tenantId },
    });

    if (!tenant) {
      throw new NotFoundError('Tenant not found');
    }

    res.json({
      success: true,
      data: {
        id: tenant.id,
        name: tenant.name,
        slug: tenant.slug,
        tier: tenant.tier,
        status: tenant.status,
        settings: tenant.settings,
        maxSessions: tenant.maxSessions,
        currentSessions: tenant.currentSessions,
        webhookUrl: tenant.webhookUrl,
        customDomain: tenant.customDomain,
        createdAt: tenant.createdAt,
      },
    });
  })
);

/**
 * Update tenant
 * PATCH /api/v1/tenants/me
 */
router.patch(
  '/me',
  requireClerkAuth, autoProvision,
  requireAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const tenantId = req.user!.tenantId;
    const { name, settings, webhookUrl, businessHours } = req.body;

    const tenantRepository = AppDataSource.getRepository(Tenant);
    const tenant = await tenantRepository.findOne({
      where: { id: tenantId },
    });

    if (!tenant) {
      throw new NotFoundError('Tenant not found');
    }

    // Update fields
    if (name) tenant.name = name;
    if (webhookUrl !== undefined) tenant.webhookUrl = webhookUrl;

    // Merge settings
    if (settings) {
      tenant.settings = {
        ...tenant.settings,
        ...settings,
      };
    }

    // Update business hours
    if (businessHours) {
      tenant.settings = {
        ...tenant.settings,
        businessHours: {
          ...tenant.settings?.businessHours,
          ...businessHours,
        },
      };
    }

    await tenantRepository.save(tenant);

    logger.info('Tenant updated', {
      tenantId,
      updates: { name, webhookUrl: !!webhookUrl, settings: !!settings },
    });

    res.json({
      success: true,
      data: {
        id: tenant.id,
        name: tenant.name,
        settings: tenant.settings,
        webhookUrl: tenant.webhookUrl,
        updatedAt: tenant.updatedAt,
      },
    });
  })
);

/**
 * Get tenant users
 * GET /api/v1/tenants/me/users
 */
router.get(
  '/me/users',
  requireClerkAuth, autoProvision,
  requireAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const tenantId = req.user!.tenantId;
    const { page = 1, limit = 20 } = req.query;

    const userRepository = AppDataSource.getRepository(User);

    const [users, total] = await userRepository.findAndCount({
      where: { tenantId },
      select: ['id', 'email', 'name', 'role', 'isActive', 'avatarUrl', 'lastLoginAt', 'createdAt'],
      order: { createdAt: 'DESC' },
      skip: (Number(page) - 1) * Number(limit),
      take: Number(limit),
    });

    res.json({
      success: true,
      data: users,
      meta: {
        page: Number(page),
        limit: Number(limit),
        total,
        totalPages: Math.ceil(total / Number(limit)),
      },
    });
  })
);

/**
 * Create tenant user
 * POST /api/v1/tenants/me/users
 */
router.post(
  '/me/users',
  requireClerkAuth, autoProvision,
  requireAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const tenantId = req.user!.tenantId;
    const { email, name, role, password } = req.body;

    if (!email || !name || !role) {
      throw new ValidationError('Email, name, and role are required');
    }

    const userRepository = AppDataSource.getRepository(User);

    // Check if email already exists
    const existingUser = await userRepository.findOne({
      where: { email, tenantId },
    });

    if (existingUser) {
      throw new ValidationError('User with this email already exists');
    }

    // Create user
    const user = userRepository.create({
      tenantId,
      email,
      name,
      role,
      password: password || undefined, // In production, hash the password
      isActive: true,
    });

    await userRepository.save(user);

    logger.info('Tenant user created', {
      tenantId,
      userId: user.id,
      email: user.email,
      role: user.role,
    });

    res.status(201).json({
      success: true,
      data: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        isActive: user.isActive,
        createdAt: user.createdAt,
      },
    });
  })
);

/**
 * Rotate API key
 * POST /api/v1/tenants/me/api-key/rotate
 */
router.post(
  '/me/api-key/rotate',
  requireClerkAuth, autoProvision,
  requireAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const tenantId = req.user!.tenantId;

    const tenantRepository = AppDataSource.getRepository(Tenant);
    const tenant = await tenantRepository.findOne({
      where: { id: tenantId },
    });

    if (!tenant) {
      throw new NotFoundError('Tenant not found');
    }

    // Generate new API key
    const newApiKey = generateApiKey();
    tenant.apiKey = newApiKey;

    await tenantRepository.save(tenant);

    logger.info('API key rotated', { tenantId });

    res.json({
      success: true,
      data: {
        apiKey: newApiKey,
        message: 'API key rotated successfully. Store this key safely as it will not be shown again.',
      },
    });
  })
);

/**
 * Get tenant stats
 * GET /api/v1/tenants/me/stats
 */
router.get(
  '/me/stats',
  requireClerkAuth, autoProvision,
  asyncHandler(async (req: Request, res: Response) => {
    const tenantId = req.user!.tenantId;

    const sessionStats = await AppDataSource.query(
      `
      SELECT 
        COUNT(*) as total_sessions,
        COUNT(CASE WHEN status = 'active' THEN 1 END) as active_sessions,
        COUNT(CASE WHEN status = 'closed' THEN 1 END) as closed_sessions,
        COUNT(CASE WHEN status = 'waiting' THEN 1 END) as waiting_sessions,
        AVG(duration_seconds) as avg_duration,
        AVG(satisfaction_rating) as avg_satisfaction
      FROM chat_sessions
      WHERE tenant_id = $1
    `,
      [tenantId]
    );

    const messageStats = await AppDataSource.query(
      `
      SELECT 
        COUNT(*) as total_messages,
        COUNT(CASE WHEN type = 'text' THEN 1 END) as text_messages,
        COUNT(CASE WHEN type = 'image' THEN 1 END) as image_messages,
        COUNT(CASE WHEN type = 'file' THEN 1 END) as file_messages
      FROM messages
      WHERE tenant_id = $1
    `,
      [tenantId]
    );

    const todaySessions = await AppDataSource.query(
      `
      SELECT COUNT(*) as count
      FROM chat_sessions
      WHERE tenant_id = $1 AND DATE(created_at) = CURRENT_DATE
    `,
      [tenantId]
    );

    res.json({
      success: true,
      data: {
        sessions: {
          total: parseInt(sessionStats[0].total_sessions, 10),
          active: parseInt(sessionStats[0].active_sessions, 10),
          closed: parseInt(sessionStats[0].closed_sessions, 10),
          waiting: parseInt(sessionStats[0].waiting_sessions, 10),
          today: parseInt(todaySessions[0].count, 10),
          avgDuration: Math.round(sessionStats[0].avg_duration || 0),
          avgSatisfaction: parseFloat(sessionStats[0].avg_satisfaction || 0),
        },
        messages: {
          total: parseInt(messageStats[0].total_messages, 10),
          text: parseInt(messageStats[0].text_messages, 10),
          images: parseInt(messageStats[0].image_messages, 10),
          files: parseInt(messageStats[0].file_messages, 10),
        },
      },
    });
  })
);

export { router as tenantRouter };
