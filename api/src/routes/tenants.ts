/**
 * Tenant Routes
 * Tenant management and configuration
 */

import crypto from 'crypto';
import { safeOutboundRequest, assertSafeOutboundUrl } from '../security/ssrf-guard';
import { Router, Request, Response } from 'express';
import { IsNull } from 'typeorm';
import { clerkClient } from '@clerk/express';
import { AppDataSource } from '../database/data-source';
import { Tenant } from '../database/entities/Tenant';
import { ChatSession } from '../database/entities/ChatSession';
import { User } from '../database/entities/User';
import { Agent } from '../database/entities/Agent';
import { PendingInvite } from '../database/entities/PendingInvite';
import { requireAdmin, asyncHandler, ValidationError, NotFoundError, BadRequestError, ApiError } from '../middleware';
import { ERROR_CODES } from '../middleware/error-codes';
import { sendSuccess, sendCreated } from '../utils/response';
import { requireClerkAuth, autoProvision, invalidateProvisionCache } from '../middleware/clerk.middleware';
import { inviteToClerkOrganization, revokeAndResendClerkInvitation, removeFromClerkOrganization, addMemberToClerkOrganization } from '../services/clerk-sync.service';
import { logger } from '../utils/logger';
import { logAudit } from '../utils/audit';
import { parsePaginationParams, applyPagination } from '../utils/pagination';
import { releaseAgentSessions } from '../utils/releaseAgentSessions';
import { emitToSession, emitToTenantAgents } from '../websocket/socket.handler';
import { requireFeature } from '../billing/enforce';
import {
  getAnchorBotConfig,
  updateAnchorBotSettings,
  AnchorBotMissingError,
} from '../services/bot-config.service';
import type { BotSettings } from '../database/entities/Bot';

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
    const isAdmin = req.user?.role === 'admin' || req.user?.role === 'super_admin';

    const tenantRepository = AppDataSource.getRepository(Tenant);
    const tenant = await tenantRepository.findOne({
      where: { id: tenantId },
    });

    if (!tenant) {
      throw new NotFoundError('Tenant not found');
    }

    // Multi-bot Phase 4 (#16d): hydrate settings response from anchor Bot,
    // not Tenant.settings. Tenant retains only `ai.apiKey` (the secret) and
    // legacy rollback values. The apiKey is merged in solely to render the
    // `hasApiKey` boolean — the secret never leaves the server.
    let botSettings: BotSettings = {};
    try {
      ({ settings: botSettings } = await getAnchorBotConfig(tenantId));
    } catch (err) {
      if (!(err instanceof AnchorBotMissingError)) throw err;
      // No anchor yet (very early tenant) — fall back to empty settings.
      logger.warn('Anchor bot missing during GET /tenants/me — returning empty settings', { tenantId });
    }
    const settings: Record<string, any> = { ...botSettings };
    if (settings.ai) {
      const tenantApiKey = tenant.settings?.ai?.apiKey;
      // Defensive: bot.settings.ai shouldn't carry apiKey, but strip it anyway.
      const { apiKey: _stale, ...aiRest } = settings.ai as { apiKey?: string };
      settings.ai = { ...aiRest, hasApiKey: !!tenantApiKey };
    }
    if (settings.integrations?.calcom) {
      const { apiKey, ...calcomRest } = settings.integrations.calcom;
      settings.integrations = { ...settings.integrations, calcom: { ...calcomRest, hasApiKey: !!apiKey } };
    }

    // Check if tenant has any widget sessions (for onboarding status)
    const sessionRepo = AppDataSource.getRepository(ChatSession);
    const widgetUsed = await sessionRepo
      .createQueryBuilder('s')
      .where('s.tenant_id = :tenantId', { tenantId })
      .andWhere('s.source = :source', { source: 'widget' })
      .andWhere('s.deleted_at IS NULL')
      .getExists();

    sendSuccess(res, {
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
      // The inbound-webhook HMAC secret is returned ONLY to admins (the portal
      // Integrations page surfaces it); non-admin members previously received it
      // here and could forge inbound webhooks. See security audit #3.
      hasWebhookSecret: !!tenant.webhookSecret,
      ...(isAdmin ? { webhookSecret: tenant.webhookSecret } : {}),
      customDomain: tenant.customDomain,
      createdAt: tenant.createdAt,
      onboarding: {
        widgetUsed,
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
      // Reject non-public / non-https webhook URLs up front (SSRF #A). Empty
      // string clears the webhook (preserved).
      if (webhookUrl) {
        try {
          assertSafeOutboundUrl(webhookUrl);
        } catch {
          throw new BadRequestError('Webhook URL must be a public https:// URL');
        }
      }
      tenant.webhookUrl = webhookUrl;
      // Auto-generate webhook secret on first webhookUrl save
      if (webhookUrl && !tenant.webhookSecret) {
        tenant.webhookSecret = crypto.randomBytes(32).toString('hex');
      }
    }

    // Reject AI settings updates via this endpoint
    if (settings?.ai !== undefined) {
      throw new BadRequestError('AI settings cannot be updated via this endpoint. Use PATCH /tenants/me/ai-settings instead.');
    }

    if (settings?.skills !== undefined) {
      throw new BadRequestError('Skills cannot be updated via this endpoint. Use /tenants/me/skills instead.');
    }

    if (settings?.automations !== undefined) {
      throw new BadRequestError('Automations cannot be updated via this endpoint. Use /tenants/me/automations instead.');
    }

    // Plan-gate. Custom widget appearance (color/title/avatar) lives under
    // `settings.theme` (primaryColor / logoUrl / customCss). Only enforce
    // when the request actually touches those keys — leaving the rest of
    // the settings update path open for all tiers. M0 plan-catalog reshape
    // split the old muddy `customBranding` flag — `customWidgetAppearance`
    // is the closest semantic match for theme-level customization.
    if (settings?.theme !== undefined) {
      await requireFeature(tenantId, 'customWidgetAppearance', 'plan_limit_custom_branding');
    }

    // Multi-bot Phase 4 (#16d): per-bot config (theme/widget/features/
    // integrations/etc.) now lives on Bot.settings. Build a patch with only
    // the moved keys present in the request body and apply via the writer.
    // Section-level deep merge happens inside updateAnchorBotSettings — so
    // e.g. `settings.theme.primaryColor` won't wipe `settings.theme.logoUrl`.
    if (settings) {
      const botPatch: Partial<BotSettings> = {};
      if (settings.theme !== undefined) botPatch.theme = settings.theme;
      if (settings.widget !== undefined) botPatch.widget = settings.widget;
      if (settings.features !== undefined) botPatch.features = settings.features;
      if (settings.integrations !== undefined) botPatch.integrations = settings.integrations;
      if (settings.businessHours !== undefined) botPatch.businessHours = settings.businessHours;
      // ai/skills/automations are rejected above — not relayed here.

      if (Object.keys(botPatch).length > 0) {
        await updateAnchorBotSettings(tenantId, botPatch);
      }
    }

    // Update business hours via the legacy top-level `businessHours` body key.
    if (businessHours) {
      // Read current to preserve unrelated keys (timezone vs schedule vs enabled).
      const { settings: currentBot } = await getAnchorBotConfig(tenantId);
      await updateAnchorBotSettings(tenantId, {
        businessHours: {
          ...(currentBot.businessHours ?? {}),
          ...businessHours,
        } as BotSettings['businessHours'],
      });
    }

    await tenantRepository.save(tenant);

    logger.info('Tenant updated', {
      tenantId,
      updates: { name, webhookUrl: !!webhookUrl, settings: !!settings },
    });

    // Build response settings from the freshly-saved anchor bot so the client
    // sees the post-write state authoritatively (no read/write asymmetry).
    let responseBotSettings: BotSettings = {};
    try {
      ({ settings: responseBotSettings } = await getAnchorBotConfig(tenantId));
    } catch (err) {
      if (!(err instanceof AnchorBotMissingError)) throw err;
    }
    const responseSettings: Record<string, any> = { ...responseBotSettings };
    if (responseSettings.ai) {
      const tenantApiKey = tenant.settings?.ai?.apiKey;
      const { apiKey: _stale, ...aiRest } = responseSettings.ai as { apiKey?: string };
      responseSettings.ai = { ...aiRest, hasApiKey: !!tenantApiKey };
    }
    if (responseSettings.integrations?.calcom) {
      const { apiKey: _ck, ...calcomRest } = responseSettings.integrations.calcom;
      responseSettings.integrations = { ...responseSettings.integrations, calcom: { ...calcomRest, hasApiKey: !!_ck } };
    }

    sendSuccess(res, {
      id: tenant.id,
      name: tenant.name,
      settings: responseSettings,
      webhookUrl: tenant.webhookUrl,
      webhookSecret: tenant.webhookSecret,
      updatedAt: tenant.updatedAt,
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

    sendSuccess(res, result.data, { pagination: result.meta });
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

    sendCreated(res, {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      isActive: user.isActive,
      createdAt: user.createdAt,
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

    sendSuccess(res, {
      apiKey: newApiKey,
      message: 'API key rotated successfully. Store this key safely as it will not be shown again.',
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

    sendSuccess(res, {
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
      sendSuccess(res, {
        testFailed: true,
        error: 'No webhook URL configured',
      });
      return;
    }

    // Validate URL format
    try {
      new URL(tenant.webhookUrl);
    } catch {
      sendSuccess(res, {
        testFailed: true,
        error: 'Invalid webhook URL format',
      });
      return;
    }

    const startTime = Date.now();
    try {
      const response = await safeOutboundRequest({
        method: 'POST',
        url: tenant.webhookUrl,
        data: {
          event: 'webhook.test',
          tenantId: tenant.id,
          timestamp: new Date().toISOString(),
          payload: { type: 'test', content: 'Webhook connectivity test' },
        },
        timeout: 5000,
        headers: {
          'Content-Type': 'application/json',
          'X-Tenant-ID': tenant.id,
          ...(tenant.webhookSecret ? {
            'X-Webhook-Secret': tenant.webhookSecret,
          } : {}),
        },
        validateStatus: () => true,
      });

      const responseTimeMs = Date.now() - startTime;

      if (response.status >= 200 && response.status < 300) {
        sendSuccess(res, {
          responseTimeMs,
        });
      } else {
        sendSuccess(res, {
          testFailed: true,
          error: `Webhook returned status ${response.status}`,
          responseTimeMs,
        });
      }
    } catch (error: unknown) {
      const responseTimeMs = Date.now() - startTime;
      const err = error as { code?: string; message?: string };
      sendSuccess(res, {
        testFailed: true,
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

    sendSuccess(res, {
      webhookSecret: tenant.webhookSecret,
      message: 'Webhook secret regenerated. Update your n8n workflow with the new secret.',
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
      throw new ApiError('Failed to send invite via Clerk', 502, ERROR_CODES.CLERK_UPSTREAM_FAILED);
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

    sendSuccess(res, { message: 'Invitation sent' });
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
    sendSuccess(res, { id: user.id, role: user.role });
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
      throw new BadRequestError('Cannot deactivate yourself');
    }

    const userRepo = AppDataSource.getRepository(User);
    const user = await userRepo.findOne({ where: { id: userId, tenantId, deletedAt: IsNull() } });

    if (!user) {
      throw new NotFoundError('User not found in this tenant');
    }

    if (!user.isActive) {
      throw new BadRequestError('User is already deactivated');
    }

    // Cannot deactivate the last active admin
    if (user.role === 'admin') {
      const activeAdminCount = await userRepo.count({
        where: { tenantId, role: 'admin' as const, isActive: true, deletedAt: IsNull() },
      });
      if (activeAdminCount <= 1) {
        throw new BadRequestError('Cannot deactivate the last active admin');
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
    sendSuccess(res, { message: 'User deactivated' });
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
      throw new NotFoundError('User not found in this tenant');
    }

    if (user.isActive) {
      throw new BadRequestError('User is already active');
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
    sendSuccess(res, { message: 'User reactivated' });
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

    sendSuccess(res, data);
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
      throw new NotFoundError('Invite not found');
    }

    // Re-send Clerk invitation
    const tenant = await AppDataSource.getRepository(Tenant).findOne({ where: { id: tenantId } });
    if (!tenant?.clerkOrgId) {
      throw new BadRequestError('Tenant has no Clerk organization linked');
    }

    const result = await revokeAndResendClerkInvitation(tenant.clerkOrgId, invite.email, req.user?.clerkUserId);

    if (!result.ok && result.code === 'already_member') {
      // Provision the user in our DB since they're already in Clerk org
      const userRepo = AppDataSource.getRepository(User);
      const agentRepo = AppDataSource.getRepository(Agent);
      const existingUser = await userRepo.findOne({ where: { email: invite.email, tenantId } });

      if (!existingUser) {
        try {
          // Find their Clerk userId from org membership
          const memberships = await clerkClient.organizations.getOrganizationMembershipList({
            organizationId: tenant.clerkOrgId!,
            limit: 100,
          });
          const membership = memberships.data?.find(
            (m: any) => m.publicUserData?.identifier?.toLowerCase() === invite.email.toLowerCase()
          );

          if (membership?.publicUserData?.userId) {
            const clerkUserId = membership.publicUserData.userId;
            let name = invite.email.split('@')[0];
            try {
              const clerkUser = await clerkClient.users.getUser(clerkUserId);
              name = [clerkUser.firstName, clerkUser.lastName].filter(Boolean).join(' ') || name;
            } catch { /* use fallback name */ }

            await userRepo.createQueryBuilder().insert().into(User).values({
              tenantId,
              clerkUserId,
              email: invite.email,
              name,
              role: invite.role as any,
              isActive: true,
            }).orIgnore().execute();

            const newUser = await userRepo.findOne({ where: { clerkUserId } });
            if (newUser) {
              await agentRepo.createQueryBuilder().insert().into(Agent).values({
                tenantId,
                userId: newUser.id,
                status: 'offline',
                maxConcurrentChats: 5,
                skills: [],
                languages: ['en'],
              }).orIgnore().execute();
              logger.info('Provisioned already-member user from stale invite', { email: invite.email, userId: newUser.id });
            }
          }
        } catch (provisionErr: any) {
          logger.warn('Could not auto-provision already-member user', { error: provisionErr?.message, email: invite.email });
        }
      }

      await inviteRepo.remove(invite);
      await logAudit(req.userId!, 'invite.cleaned', 'invite', invite.id, tenantId, { email: invite.email, reason: 'already_member' });
      sendSuccess(res, { message: 'User has already joined — synced to members list' });
      return;
    }

    if (!result.ok) {
      throw new ApiError(result.message, 502, ERROR_CODES.CLERK_UPSTREAM_FAILED);
    }

    invite.expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    await inviteRepo.save(invite);

    await logAudit(req.userId!, 'invite.resent', 'invite', invite.id, tenantId, { email: invite.email });

    sendSuccess(res, { message: 'Invite resent' });
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
      throw new NotFoundError('Invite not found');
    }

    await logAudit(req.userId!, 'invite.cancelled', 'invite', invite.id, tenantId, { email: invite.email });

    await inviteRepo.remove(invite);

    sendSuccess(res, { message: 'Invite cancelled' });
  })
);

export function computeOnboardingStatus(tenant: any, kbDocCount: number) {
  const settings = tenant.settings || {};
  const ai = settings.ai || {};
  const automations = settings.automations || {};

  // Cal.com is shelved, so the former `calcomConnected` onboarding step is gone.
  const steps = {
    aiEnabled: !!ai.enabled,
    brandVoiceConfigured: !!(ai.brandVoice?.name && ai.brandVoice.name !== 'Organization Assistant'),
    knowledgeBaseHasDocs: kbDocCount > 0,
    automationsConfigured: !!(
      automations.emailNotifications?.bookingConfirmation?.enabled ||
      automations.emailNotifications?.newLeadAlert?.enabled ||
      automations.emailNotifications?.conversationSummary?.enabled
    ),
  };

  const totalCount = Object.keys(steps).length;
  const completedCount = Object.values(steps).filter(Boolean).length;

  return {
    complete: completedCount === totalCount,
    completedCount,
    totalCount,
    steps,
  };
}

/**
 * Get onboarding status
 * GET /api/v1/tenants/me/onboarding-status
 */
router.get(
  '/me/onboarding-status',
  requireClerkAuth, autoProvision,
  asyncHandler(async (req: Request, res: Response) => {
    const tenantId = req.user!.tenantId;
    const tenant = await AppDataSource.getRepository(Tenant).findOne({ where: { id: tenantId } });
    if (!tenant) throw new NotFoundError('Tenant not found');

    const kbResult = await AppDataSource.query(
      `SELECT COUNT(*)::int AS count FROM knowledge_documents WHERE "tenantId" = $1 AND status = 'indexed'`,
      [tenantId]
    ).catch(() => [{ count: 0 }]);

    // Multi-bot Phase 4 (#16d): onboarding steps inspect ai/integrations/
    // automations — all on Bot.settings. Pass the anchor bot's settings into
    // computeOnboardingStatus (the function expects `{ settings }` shape).
    let botSettings: BotSettings = {};
    try {
      ({ settings: botSettings } = await getAnchorBotConfig(tenantId));
    } catch (err) {
      if (!(err instanceof AnchorBotMissingError)) throw err;
    }

    const status = computeOnboardingStatus({ settings: botSettings }, kbResult[0]?.count || 0);
    sendSuccess(res, status);
  })
);

/**
 * Get available tools for the tenant
 * GET /api/v1/tenants/me/available-tools
 */
router.get(
  '/me/available-tools',
  requireClerkAuth, autoProvision,
  asyncHandler(async (req: Request, res: Response) => {
    const tenantId = req.user!.tenantId;
    const tenant = await AppDataSource.getRepository(Tenant).findOne({ where: { id: tenantId } });
    if (!tenant) throw new NotFoundError('Tenant not found');

    // Multi-bot Phase 4 (#16d): tool registry resolves integrations from
    // Bot.settings now. Anchor bot drives the tenant-level tool list.
    const { settings: botSettings } = await getAnchorBotConfig(tenantId);

    const { ToolRegistry } = await import('../agent/tool-registry');
    const registry = new ToolRegistry();
    const tools = await registry.getToolsForTenant(tenant, botSettings);

    sendSuccess(res, {
      tools: tools.map((t) => ({
        name: t.name,
        description: t.description,
        hasSideEffects: t.hasSideEffects,
        category: ['kb_search', 'capture_lead', 'escalate_to_human'].includes(t.name) ? 'always' : 'booking',
      })),
    });
  })
);

export { router as tenantRouter };
