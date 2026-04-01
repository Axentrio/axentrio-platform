/**
 * Tenant Routes
 * Tenant management and configuration
 */

import crypto from 'crypto';
import axios from 'axios';
import { Router, Request, Response } from 'express';
import { IsNull } from 'typeorm';
import { AppDataSource } from '../database/data-source';
import { Tenant } from '../database/entities/Tenant';
import { User } from '../database/entities/User';
import { PendingInvite } from '../database/entities/PendingInvite';
import { requireAdmin, asyncHandler, ValidationError, NotFoundError } from '../middleware';
import { requireClerkAuth, autoProvision, invalidateProvisionCache } from '../middleware/clerk.middleware';
import { inviteToClerkOrganization, removeFromClerkOrganization, addMemberToClerkOrganization } from '../services/clerk-sync.service';
import { logger } from '../utils/logger';
import { logAudit } from '../utils/audit';
import { parsePaginationParams, applyPagination } from '../utils/pagination';
import { releaseAgentSessions } from '../utils/releaseAgentSessions';
import { emitToSession, emitToTenantAgents } from '../websocket/socket.handler';

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

    // Strip encrypted AI API key from response
    const settings = { ...tenant.settings };
    if (settings.ai) {
      const { apiKey, ...aiRest } = settings.ai;
      settings.ai = { ...aiRest, hasApiKey: !!apiKey } as any;
    }
    if (settings.integrations?.calcom) {
      const { apiKey, ...calcomRest } = settings.integrations.calcom;
      settings.integrations = { ...settings.integrations, calcom: { ...calcomRest, hasApiKey: !!apiKey } as any };
    }

    res.json({
      success: true,
      data: {
        id: tenant.id,
        name: tenant.name,
        slug: tenant.slug,
        apiKey: tenant.apiKey,
        tier: tenant.tier,
        status: tenant.status,
        settings,
        maxSessions: tenant.maxSessions,
        currentSessions: tenant.currentSessions,
        webhookUrl: tenant.webhookUrl,
        webhookSecret: tenant.webhookSecret,
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
    if (webhookUrl !== undefined) {
      tenant.webhookUrl = webhookUrl;
      // Auto-generate webhook secret on first webhookUrl save
      if (webhookUrl && !tenant.webhookSecret) {
        tenant.webhookSecret = crypto.randomBytes(32).toString('hex');
      }
    }

    // Reject AI settings updates via this endpoint
    if (settings?.ai !== undefined) {
      res.status(400).json({
        error: 'AI settings cannot be updated via this endpoint. Use PATCH /tenants/me/ai-settings instead.',
      });
      return;
    }

    // Deep merge settings (preserve nested objects like theme, features)
    if (settings) {
      const existing = tenant.settings || {};
      tenant.settings = {
        ...existing,
        ...settings,
        theme: settings.theme ? { ...existing.theme, ...settings.theme } : existing.theme,
        features: settings.features !== undefined
          ? { ...existing.features, ...settings.features }
          : existing.features,
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

    // Strip encrypted AI API key from response
    const responseSettings = { ...tenant.settings };
    if (responseSettings.ai) {
      const { apiKey: _k, ...aiRest } = responseSettings.ai;
      responseSettings.ai = { ...aiRest, hasApiKey: !!_k } as any;
    }
    if (responseSettings.integrations?.calcom) {
      const { apiKey: _ck, ...calcomRest } = responseSettings.integrations.calcom;
      responseSettings.integrations = { ...responseSettings.integrations, calcom: { ...calcomRest, hasApiKey: !!_ck } as any };
    }

    res.json({
      success: true,
      data: {
        id: tenant.id,
        name: tenant.name,
        settings: responseSettings,
        webhookUrl: tenant.webhookUrl,
        webhookSecret: tenant.webhookSecret,
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
    const params = parsePaginationParams(req.query as Record<string, unknown>);

    const userRepository = AppDataSource.getRepository(User);

    const qb = userRepository.createQueryBuilder('user')
      .select(['user.id', 'user.email', 'user.name', 'user.role', 'user.isActive', 'user.avatarUrl', 'user.lastLoginAt', 'user.createdAt'])
      .where('user.tenantId = :tenantId', { tenantId })
      .andWhere('user.deletedAt IS NULL');

    if (!params.sortBy) {
      qb.orderBy('user.createdAt', 'DESC');
    }

    const result = await applyPagination(qb, params);

    res.json({
      success: true,
      data: result.data,
      meta: result.meta,
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

/**
 * Test webhook connection
 * POST /api/v1/tenants/me/webhook-test
 */
router.post(
  '/me/webhook-test',
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

    if (!tenant.webhookUrl) {
      res.json({
        success: false,
        error: 'No webhook URL configured',
      });
      return;
    }

    // Validate URL format
    try {
      new URL(tenant.webhookUrl);
    } catch {
      res.json({
        success: false,
        error: 'Invalid webhook URL format',
      });
      return;
    }

    const startTime = Date.now();
    try {
      const response = await axios.post(
        tenant.webhookUrl,
        {
          event: 'webhook.test',
          tenantId: tenant.id,
          timestamp: new Date().toISOString(),
          payload: { type: 'test', content: 'Webhook connectivity test' },
        },
        {
          timeout: 5000,
          headers: {
            'Content-Type': 'application/json',
            'X-Tenant-ID': tenant.id,
            ...(tenant.webhookSecret ? {
              'X-Webhook-Secret': tenant.webhookSecret,
            } : {}),
          },
          validateStatus: () => true,
        }
      );

      const responseTimeMs = Date.now() - startTime;

      if (response.status >= 200 && response.status < 300) {
        res.json({
          success: true,
          responseTimeMs,
        });
      } else {
        res.json({
          success: false,
          error: `Webhook returned status ${response.status}`,
          responseTimeMs,
        });
      }
    } catch (error: unknown) {
      const responseTimeMs = Date.now() - startTime;
      const err = error as { code?: string; message?: string };
      res.json({
        success: false,
        error: err.code === 'ECONNABORTED'
          ? 'Webhook timed out (5s limit)'
          : err.message || 'Connection failed',
        responseTimeMs,
      });
    }
  })
);

/**
 * Regenerate webhook secret
 * POST /api/v1/tenants/me/webhook-secret/regenerate
 */
router.post(
  '/me/webhook-secret/regenerate',
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

    tenant.webhookSecret = crypto.randomBytes(32).toString('hex');
    await tenantRepository.save(tenant);

    logger.info('Webhook secret regenerated', { tenantId });

    res.json({
      success: true,
      data: {
        webhookSecret: tenant.webhookSecret,
        message: 'Webhook secret regenerated. Update your n8n workflow with the new secret.',
      },
    });
  })
);

/**
 * Invite user to tenant
 * POST /api/v1/tenants/me/invite
 */
router.post(
  '/me/invite',
  requireClerkAuth, autoProvision,
  requireAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const { email, role } = req.body;
    if (!email || !role) {
      throw new ValidationError('Email and role are required');
    }

    if (!['admin', 'supervisor', 'agent'].includes(role)) {
      throw new ValidationError('Invalid role');
    }

    const tenantId = req.user!.tenantId;
    const tenantRepo = AppDataSource.getRepository(Tenant);
    const tenant = await tenantRepo.findOne({ where: { id: tenantId } });

    if (!tenant?.clerkOrgId) {
      throw new ValidationError('No Clerk organization linked');
    }

    const invited = await inviteToClerkOrganization(
      tenant.clerkOrgId,
      email,
      req.user!.clerkUserId
    );
    if (!invited) {
      res.status(502).json({ error: 'Failed to send invite' });
      return;
    }

    const inviteRepo = AppDataSource.getRepository(PendingInvite);
    await inviteRepo
      .createQueryBuilder()
      .insert()
      .into(PendingInvite)
      .values({
        tenantId: tenant.id,
        email: email.toLowerCase(),
        role,
        invitedBy: req.userId!,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      })
      .orUpdate(['role', 'invited_by', 'created_at', 'expires_at'], ['tenant_id', 'email'])
      .execute();

    // Fetch the saved invite to get its ID for the audit log
    const savedInvite = await inviteRepo.findOne({ where: { tenantId: tenant.id, email: email.toLowerCase() } });
    await logAudit(req.userId!, 'invite.sent', 'invite', savedInvite?.id ?? tenant.id, tenantId, { email, role });

    res.json({ success: true, message: 'Invitation sent' });
  })
);

/**
 * Change user role within tenant
 * PATCH /api/v1/tenants/me/users/:userId
 */
router.patch(
  '/me/users/:userId',
  requireClerkAuth, autoProvision,
  requireAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const { role } = req.body;

    if (!role || !['admin', 'supervisor', 'agent'].includes(role)) {
      throw new ValidationError('Invalid role');
    }

    const tenantId = req.user!.tenantId;
    const userRepo = AppDataSource.getRepository(User);
    const user = await userRepo.findOne({
      where: { id: req.params.userId, tenantId, deletedAt: IsNull() },
    });

    if (!user) {
      throw new NotFoundError('User not found in this tenant');
    }

    user.role = role;
    await userRepo.save(user);

    // Invalidate autoProvision cache so role change takes effect immediately
    if (user.clerkUserId) {
      const tenant = await AppDataSource.getRepository(Tenant).findOne({ where: { id: tenantId } });
      if (tenant?.clerkOrgId) {
        invalidateProvisionCache(tenant.clerkOrgId, user.clerkUserId);
      }
    }

    logger.info('Tenant admin changed user role', {
      userId: user.id, newRole: role, changedBy: req.userId,
    });
    res.json({ success: true, data: { id: user.id, role: user.role } });
  })
);

/**
 * Deactivate a tenant member
 * POST /api/v1/tenants/me/users/:userId/deactivate
 */
router.post(
  '/me/users/:userId/deactivate',
  requireClerkAuth, autoProvision,
  requireAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const tenantId = req.user!.tenantId;
    const { userId } = req.params;

    // Cannot deactivate yourself
    if (userId === req.userId) {
      res.status(400).json({ error: 'Cannot deactivate yourself' });
      return;
    }

    const userRepo = AppDataSource.getRepository(User);
    const user = await userRepo.findOne({ where: { id: userId, tenantId, deletedAt: IsNull() } });

    if (!user) {
      res.status(404).json({ error: 'User not found in this tenant' });
      return;
    }

    if (!user.isActive) {
      res.status(400).json({ error: 'User is already deactivated' });
      return;
    }

    // Cannot deactivate the last active admin
    if (user.role === 'admin') {
      const activeAdminCount = await userRepo.count({
        where: { tenantId, role: 'admin' as const, isActive: true, deletedAt: IsNull() },
      });
      if (activeAdminCount <= 1) {
        res.status(400).json({ error: 'Cannot deactivate the last active admin' });
        return;
      }
    }

    // Deactivate in DB + cleanup sessions in one transaction
    let releaseResult = { releasedSessions: 0, returnedHandoffs: 0, affectedSessionIds: [] as string[] };
    await AppDataSource.transaction(async (manager) => {
      user.isActive = false;
      await manager.save(User, user);
      releaseResult = await releaseAgentSessions(user.id, tenantId, manager);
    });

    // Remove from Clerk org + invalidate cache
    const tenant = await AppDataSource.getRepository(Tenant).findOne({ where: { id: tenantId } });
    if (user.clerkUserId && tenant?.clerkOrgId) {
      await removeFromClerkOrganization(tenant.clerkOrgId, user.clerkUserId);
      invalidateProvisionCache(tenant.clerkOrgId, user.clerkUserId);
    }

    await logAudit(req.userId!, 'user.deactivated', 'user', user.id, tenantId, {
      releasedSessions: releaseResult.releasedSessions,
      returnedHandoffs: releaseResult.returnedHandoffs,
    });

    // Socket events — after transaction committed
    for (const sessionId of releaseResult.affectedSessionIds) {
      emitToSession(tenantId, sessionId, 'agent:removed', {
        sessionId,
        reason: 'agent_deactivated',
      });
    }
    if (releaseResult.releasedSessions > 0 || releaseResult.returnedHandoffs > 0) {
      emitToTenantAgents(tenantId, 'handoff:queue_updated', {
        reason: 'agent_deactivated',
      });
    }

    logger.info('Deactivated user', { userId: user.id, tenantId, deactivatedBy: req.userId });
    res.json({ success: true });
  })
);

/**
 * Reactivate a tenant member
 * POST /api/v1/tenants/me/users/:userId/reactivate
 */
router.post(
  '/me/users/:userId/reactivate',
  requireClerkAuth, autoProvision,
  requireAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const tenantId = req.user!.tenantId;
    const { userId } = req.params;

    const userRepo = AppDataSource.getRepository(User);
    const user = await userRepo.findOne({ where: { id: userId, tenantId, deletedAt: IsNull() } });

    if (!user) {
      res.status(404).json({ error: 'User not found in this tenant' });
      return;
    }

    if (user.isActive) {
      res.status(400).json({ error: 'User is already active' });
      return;
    }

    user.isActive = true;
    await userRepo.save(user);

    // Re-add to Clerk org
    if (user.clerkUserId) {
      const tenant = await AppDataSource.getRepository(Tenant).findOne({ where: { id: tenantId } });
      if (tenant?.clerkOrgId) {
        await addMemberToClerkOrganization(tenant.clerkOrgId, user.clerkUserId, 'org:member');
      }
    }

    await logAudit(req.userId!, 'user.reactivated', 'user', user.id, tenantId);

    logger.info('Reactivated user', { userId: user.id, tenantId, reactivatedBy: req.userId });
    res.json({ success: true });
  })
);

/**
 * List pending invites for current tenant
 * GET /api/v1/tenants/me/pending-invites
 */
router.get(
  '/me/pending-invites',
  requireClerkAuth, autoProvision,
  requireAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const tenantId = req.user!.tenantId;

    const invites = await AppDataSource.getRepository(PendingInvite)
      .find({ where: { tenantId }, order: { createdAt: 'DESC' } });

    // Resolve inviter names
    const inviterIds = [...new Set(invites.map(i => i.invitedBy).filter(Boolean))] as string[];
    const inviters = inviterIds.length > 0
      ? await AppDataSource.getRepository(User)
          .createQueryBuilder('u')
          .select(['u.id', 'u.name', 'u.email'])
          .where('u.id IN (:...ids)', { ids: inviterIds })
          .getMany()
      : [];
    const inviterMap = new Map(inviters.map(u => [u.id, { name: u.name, email: u.email }]));

    const data = invites.map(inv => ({
      id: inv.id,
      email: inv.email,
      role: inv.role,
      invitedBy: inv.invitedBy ? inviterMap.get(inv.invitedBy) ?? null : null,
      createdAt: inv.createdAt,
      expiresAt: inv.expiresAt,
      isExpired: new Date() > inv.expiresAt,
    }));

    res.json({ success: true, data });
  })
);

/**
 * Resend a pending invite
 * POST /api/v1/tenants/me/pending-invites/:id/resend
 */
router.post(
  '/me/pending-invites/:id/resend',
  requireClerkAuth, autoProvision,
  requireAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const tenantId = req.user!.tenantId;
    const inviteRepo = AppDataSource.getRepository(PendingInvite);

    const invite = await inviteRepo.findOne({
      where: { id: req.params.id, tenantId },
    });

    if (!invite) {
      res.status(404).json({ error: 'Invite not found' });
      return;
    }

    // Re-send Clerk invitation
    const tenant = await AppDataSource.getRepository(Tenant).findOne({ where: { id: tenantId } });
    if (!tenant?.clerkOrgId) {
      res.status(400).json({ error: 'Tenant has no Clerk organization linked' });
      return;
    }

    const sent = await inviteToClerkOrganization(tenant.clerkOrgId, invite.email, req.user?.clerkUserId);
    if (!sent) {
      res.status(502).json({ error: 'Failed to resend Clerk invitation' });
      return;
    }

    // Reset expiry
    invite.expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    await inviteRepo.save(invite);

    await logAudit(req.userId!, 'invite.resent', 'invite', invite.id, tenantId, { email: invite.email });

    res.json({ success: true, message: 'Invite resent' });
  })
);

/**
 * Cancel a pending invite
 * DELETE /api/v1/tenants/me/pending-invites/:id
 */
router.delete(
  '/me/pending-invites/:id',
  requireClerkAuth, autoProvision,
  requireAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const tenantId = req.user!.tenantId;
    const inviteRepo = AppDataSource.getRepository(PendingInvite);

    const invite = await inviteRepo.findOne({
      where: { id: req.params.id, tenantId },
    });

    if (!invite) {
      res.status(404).json({ error: 'Invite not found' });
      return;
    }

    await logAudit(req.userId!, 'invite.cancelled', 'invite', invite.id, tenantId, { email: invite.email });

    await inviteRepo.remove(invite);

    res.json({ success: true, message: 'Invite cancelled' });
  })
);

export { router as tenantRouter };
