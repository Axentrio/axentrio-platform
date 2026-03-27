import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { IsNull } from 'typeorm';
import { AppDataSource } from '../database/data-source';
import { Tenant } from '../database/entities/Tenant';
import { User } from '../database/entities/User';
import { ChatSession } from '../database/entities/ChatSession';
import { Message } from '../database/entities/Message';
import { PendingInvite } from '../database/entities/PendingInvite';
import { Agent } from '../database/entities/Agent';
import { requireClerkAuth, autoProvision, invalidateProvisionCache } from '../middleware/clerk.middleware';
import { requireSuperAdmin } from '../middleware/super-admin.middleware';
import { parsePaginationParams, applyPagination } from '../utils/pagination';
import { logger } from '../utils/logger';
import { logAudit } from '../utils/audit';
import { AuditLog } from '../database/entities/AuditLog';
import {
  createClerkOrganization,
  addMemberToClerkOrganization,
  inviteToClerkOrganization,
  removeFromClerkOrganization,
  deleteClerkOrganization,
  updateClerkOrganization,
} from '../services/clerk-sync.service';
import { asyncHandler, BadRequestError, NotFoundError } from '../middleware/error-handler';
import { validate } from '../middleware/validate';
import { sendSuccess, sendCreated } from '../utils/response';
import { createTenantSchema, inviteMemberSchema } from '../schemas';
import { releaseAgentSessions } from '../utils/releaseAgentSessions';
import { emitToSession, emitToTenantAgents } from '../websocket/socket.handler';

const router = Router();

// All routes require Clerk auth + autoProvision + super admin
router.use(requireClerkAuth, autoProvision, requireSuperAdmin);

// ==================
// Tenant Management
// ==================

// GET /admin/tenants — list all tenants
router.get('/tenants', asyncHandler(async (req: Request, res: Response) => {
  const params = parsePaginationParams(req.query as Record<string, unknown>);
  const qb = AppDataSource.getRepository(Tenant)
    .createQueryBuilder('tenant');

  const search = req.query.search as string;
  if (search) {
    qb.andWhere('(tenant.name ILIKE :search OR tenant.slug ILIKE :search)', {
      search: `%${search}%`,
    });
  }

  const tier = req.query.tier as string;
  if (tier) {
    qb.andWhere('tenant.tier = :tier', { tier });
  }

  const status = req.query.status as string;
  if (status) {
    qb.andWhere('tenant.status = :status', { status });
  }

  const result = await applyPagination(qb, params);
  sendSuccess(res, result.data, { pagination: result.meta });
}));

// GET /admin/tenants/:id/pending-invites — list pending invites for a tenant
router.get('/tenants/:id/pending-invites', asyncHandler(async (req: Request, res: Response) => {
  const tenantId = req.params.id;

  const invites = await AppDataSource.getRepository(PendingInvite)
    .find({ where: { tenantId }, order: { createdAt: 'DESC' } });

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
}));

// POST /admin/tenants/:id/pending-invites/:inviteId/resend
router.post('/tenants/:id/pending-invites/:inviteId/resend', asyncHandler(async (req: Request, res: Response) => {
  const { id: tenantId, inviteId } = req.params;

  const invite = await AppDataSource.getRepository(PendingInvite).findOne({
    where: { id: inviteId, tenantId },
  });
  if (!invite) throw new NotFoundError('Invite not found');

  const tenant = await AppDataSource.getRepository(Tenant).findOne({ where: { id: tenantId } });
  if (!tenant?.clerkOrgId) throw new BadRequestError('Tenant has no Clerk organization linked');

  const sent = await inviteToClerkOrganization(tenant.clerkOrgId, invite.email);
  if (!sent) {
    res.status(502).json({ error: 'Failed to resend Clerk invitation' });
    return;
  }

  invite.expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  await AppDataSource.getRepository(PendingInvite).save(invite);

  await logAudit(req.userId!, 'invite.resent', 'invite', invite.id, tenantId, { email: invite.email });

  logger.info('Super-admin resent invite', { inviteId, tenantId, resendBy: req.userId });
  sendSuccess(res, {
    id: invite.id,
    email: invite.email,
    role: invite.role,
    expiresAt: invite.expiresAt,
  });
}));

// DELETE /admin/tenants/:id/pending-invites/:inviteId
router.delete('/tenants/:id/pending-invites/:inviteId', asyncHandler(async (req: Request, res: Response) => {
  const { id: tenantId, inviteId } = req.params;

  const inviteRepo = AppDataSource.getRepository(PendingInvite);
  const invite = await inviteRepo.findOne({ where: { id: inviteId, tenantId } });
  if (!invite) throw new NotFoundError('Invite not found');

  await logAudit(req.userId!, 'invite.cancelled', 'invite', invite.id, tenantId, { email: invite.email });
  await inviteRepo.remove(invite);

  logger.info('Super-admin cancelled invite', { inviteId, tenantId, cancelledBy: req.userId });
  res.status(204).send();
}));

// GET /admin/tenants/:id/audit-logs — paginated audit logs for a tenant
router.get('/tenants/:id/audit-logs', asyncHandler(async (req: Request, res: Response) => {
  const params = parsePaginationParams(req.query as Record<string, unknown>);
  const qb = AppDataSource.getRepository(AuditLog)
    .createQueryBuilder('log')
    .where('log.tenantId = :tenantId', { tenantId: req.params.id })
    .orderBy('log.createdAt', 'DESC');

  const result = await applyPagination(qb, params);

  const actorIds = [...new Set(result.data.map(l => l.actorId))];
  const actors = actorIds.length > 0
    ? await AppDataSource.getRepository(User).createQueryBuilder('u')
        .select(['u.id', 'u.name', 'u.email'])
        .where('u.id IN (:...ids)', { ids: actorIds })
        .getMany()
    : [];
  const actorMap = new Map(actors.map(a => [a.id, { name: a.name, email: a.email }]));

  const data = result.data.map(log => ({
    id: log.id,
    action: log.action,
    entityType: log.entityType,
    entityId: log.entityId,
    actorName: actorMap.get(log.actorId)?.name ?? 'Unknown',
    actorEmail: actorMap.get(log.actorId)?.email ?? '',
    metadata: log.metadata,
    createdAt: log.createdAt,
  }));

  sendSuccess(res, data, { pagination: result.meta });
}));

// POST /admin/tenants/:id/api-key/rotate — rotate API key for a tenant
router.post('/tenants/:id/api-key/rotate', asyncHandler(async (req: Request, res: Response) => {
  const repo = AppDataSource.getRepository(Tenant);
  const tenant = await repo.findOne({ where: { id: req.params.id } });

  if (!tenant) throw new NotFoundError('Tenant not found');

  tenant.apiKey = `ak_${crypto.randomUUID().replace(/-/g, '')}`;
  await repo.save(tenant);

  await logAudit(req.userId!, 'apikey.rotated', 'tenant', tenant.id, tenant.id);

  sendSuccess(res, { apiKey: tenant.apiKey });
}));

// GET /admin/tenants/:id — tenant details with users, invites, API key
router.get('/tenants/:id', asyncHandler(async (req: Request, res: Response) => {
  const tenant = await AppDataSource.getRepository(Tenant).findOne({
    where: { id: req.params.id },
  });

  if (!tenant) throw new NotFoundError('Tenant not found');

  const userRepo = AppDataSource.getRepository(User);
  const userCount = await userRepo.count({ where: { tenantId: tenant.id } });
  const users = await userRepo.find({
    where: { tenantId: tenant.id },
    order: { createdAt: 'DESC' },
    take: 10,
  });

  const sessionCount = await AppDataSource.getRepository(ChatSession).count({
    where: { tenantId: tenant.id },
  });

  const messageCount = await AppDataSource.getRepository(Message).count({
    where: { session: { tenantId: tenant.id } },
  });

  const pendingInvites = await AppDataSource.getRepository(PendingInvite).find({
    where: { tenantId: tenant.id },
    order: { createdAt: 'DESC' },
  });

  // Mask API key: show first 3 + last 4 chars
  const ak = tenant.apiKey;
  const apiKeyMasked = ak.length > 7
    ? `${ak.slice(0, 3)}${'*'.repeat(ak.length - 7)}${ak.slice(-4)}`
    : '****';

  const recentAuditLogs = await AppDataSource.getRepository(AuditLog)
    .find({
      where: { tenantId: tenant.id },
      order: { createdAt: 'DESC' },
      take: 20,
    });

  // Resolve actor names for audit logs
  const actorIds = [...new Set(recentAuditLogs.map(l => l.actorId))];
  const actors = actorIds.length > 0
    ? await userRepo.createQueryBuilder('u')
        .select(['u.id', 'u.name', 'u.email'])
        .where('u.id IN (:...ids)', { ids: actorIds })
        .getMany()
    : [];
  const actorMap = new Map(actors.map(a => [a.id, { name: a.name, email: a.email }]));

  sendSuccess(res, {
    ...tenant,
    apiKeyMasked,
    userCount,
    sessionCount,
    messageCount,
    users: users.map(u => ({
      id: u.id,
      name: u.name,
      email: u.email,
      role: u.role,
      isActive: u.isActive,
      lastLoginAt: u.lastLoginAt,
      createdAt: u.createdAt,
    })),
    pendingInvites: pendingInvites.map(inv => ({
      id: inv.id,
      email: inv.email,
      role: inv.role,
      createdAt: inv.createdAt,
      expiresAt: inv.expiresAt,
      isExpired: new Date() > inv.expiresAt,
    })),
    recentAuditLogs: recentAuditLogs.map(log => ({
      id: log.id,
      action: log.action,
      entityType: log.entityType,
      entityId: log.entityId,
      actorName: actorMap.get(log.actorId)?.name ?? 'Unknown',
      metadata: log.metadata,
      createdAt: log.createdAt,
    })),
  });
}));

// POST /admin/tenants — create tenant with Clerk org
router.post('/tenants', validate(createTenantSchema), asyncHandler(async (req: Request, res: Response) => {
  const { name, tier, settings, adminEmail } = req.body;

  // Step 1: Create Clerk org first
  const clerkOrg = await createClerkOrganization(name);
  if (!clerkOrg) {
    res.status(502).json({ success: false, error: { message: 'Failed to create organization in Clerk' } });
    return;
  }

  // Step 2: Create local Tenant record
  const repo = AppDataSource.getRepository(Tenant);
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const apiKey = `ak_${crypto.randomUUID().replace(/-/g, '')}`;

  let tenant;
  try {
    tenant = repo.create({
      name,
      slug,
      apiKey,
      clerkOrgId: clerkOrg.id,
      tier: tier || 'free',
      settings,
    });
    await repo.save(tenant);
    await logAudit(req.userId!, 'tenant.created', 'tenant', tenant.id, tenant.id, { name, tier: tier || 'free' });
  } catch (dbError) {
    // Compensating transaction: delete the Clerk org
    logger.error('Failed to create tenant in DB, cleaning up Clerk org', { error: dbError });
    await deleteClerkOrganization(clerkOrg.id);
    throw dbError;
  }

  // Step 3: Add the creating super admin as org admin so they can manage & invite
  if (req.user?.clerkUserId) {
    await addMemberToClerkOrganization(clerkOrg.id, req.user.clerkUserId, 'org:admin');
  }

  // Step 4: Invite initial admin if email provided
  if (adminEmail) {
    const invited = await inviteToClerkOrganization(clerkOrg.id, adminEmail, req.user?.clerkUserId);
    if (!invited) {
      logger.warn('Clerk invite failed, PendingInvite still created for auto-provision', { adminEmail });
    }

    const inviteRepo = AppDataSource.getRepository(PendingInvite);
    await inviteRepo.save(inviteRepo.create({
      tenantId: tenant.id,
      email: adminEmail.toLowerCase(),
      role: 'admin',
      invitedBy: req.userId!,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // 7 days
    }));
  }

  sendCreated(res, tenant);
}));

// PATCH /admin/tenants/:id — update tenant
router.patch('/tenants/:id', asyncHandler(async (req: Request, res: Response) => {
  const repo = AppDataSource.getRepository(Tenant);
  const tenant = await repo.findOne({ where: { id: req.params.id } });

  if (!tenant) throw new NotFoundError('Tenant not found');

  const { name, tier, status, settings } = req.body;
  if (name) tenant.name = name;
  if (tier) tenant.tier = tier;
  if (status) tenant.status = status;
  if (settings) tenant.settings = { ...tenant.settings, ...settings };

  await repo.save(tenant);
  await logAudit(req.userId!, 'tenant.updated', 'tenant', tenant.id, tenant.id, { fields: Object.keys(req.body) });

  // Sync name change to Clerk
  if (name && tenant.clerkOrgId) {
    await updateClerkOrganization(tenant.clerkOrgId, { name });
  }

  sendSuccess(res, tenant);
}));

// POST /admin/tenants/:id/suspend
router.post('/tenants/:id/suspend', asyncHandler(async (req: Request, res: Response) => {
  const repo = AppDataSource.getRepository(Tenant);
  const tenant = await repo.findOne({ where: { id: req.params.id } });

  if (!tenant) throw new NotFoundError('Tenant not found');

  tenant.status = 'suspended';
  await repo.save(tenant);
  await logAudit(req.userId!, 'tenant.suspended', 'tenant', tenant.id, tenant.id);

  if (tenant.clerkOrgId) {
    await updateClerkOrganization(tenant.clerkOrgId, {
      publicMetadata: { suspended: true },
    });
  }

  sendSuccess(res, tenant);
}));

// POST /admin/tenants/:id/activate
router.post('/tenants/:id/activate', asyncHandler(async (req: Request, res: Response) => {
  const repo = AppDataSource.getRepository(Tenant);
  const tenant = await repo.findOne({ where: { id: req.params.id } });

  if (!tenant) throw new NotFoundError('Tenant not found');

  tenant.status = 'active';
  await repo.save(tenant);
  await logAudit(req.userId!, 'tenant.activated', 'tenant', tenant.id, tenant.id);

  if (tenant.clerkOrgId) {
    await updateClerkOrganization(tenant.clerkOrgId, {
      publicMetadata: { suspended: false },
    });
  }

  sendSuccess(res, tenant);
}));

// ==================
// User Management
// ==================

// GET /admin/users — list all users across tenants
router.get('/users', asyncHandler(async (req: Request, res: Response) => {
  const params = parsePaginationParams(req.query as Record<string, unknown>);
  const qb = AppDataSource.getRepository(User)
    .createQueryBuilder('user')
    .leftJoinAndSelect('user.tenant', 'tenant')
    .where('user.deletedAt IS NULL');

  const search = req.query.search as string;
  if (search) {
    qb.andWhere('(user.name ILIKE :search OR user.email ILIKE :search)', {
      search: `%${search}%`,
    });
  }

  const role = req.query.role as string;
  if (role) {
    qb.andWhere('user.role = :role', { role });
  }

  const tenantId = req.query.tenantId as string;
  if (tenantId) {
    qb.andWhere('user.tenantId = :tenantId', { tenantId });
  }

  const result = await applyPagination(qb, params);

  const data = result.data.map(u => ({
    id: u.id,
    email: u.email,
    name: u.name,
    role: u.role,
    isActive: u.isActive,
    tenantId: u.tenantId,
    tenantName: u.tenant?.name,
    lastLoginAt: u.lastLoginAt,
    createdAt: u.createdAt,
  }));

  sendSuccess(res, data, { pagination: result.meta });
}));

// GET /admin/users/:id — user details
router.get('/users/:id', asyncHandler(async (req: Request, res: Response) => {
  const user = await AppDataSource.getRepository(User).findOne({
    where: { id: req.params.id, deletedAt: IsNull() },
    relations: ['tenant'],
  });

  if (!user) throw new NotFoundError('User not found');

  sendSuccess(res, {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    isActive: user.isActive,
    tenantId: user.tenantId,
    tenantName: user.tenant?.name,
    emailVerified: user.emailVerified,
    lastLoginAt: user.lastLoginAt,
    createdAt: user.createdAt,
  });
}));

// PATCH /admin/users/:id — update user (with Clerk sync on deactivation)
router.patch('/users/:id', asyncHandler(async (req: Request, res: Response) => {
  const repo = AppDataSource.getRepository(User);
  const user = await repo.findOne({ where: { id: req.params.id, deletedAt: IsNull() } });

  if (!user) throw new NotFoundError('User not found');

  const { role } = req.body;
  const originalRole = user.role;
  if (role && ['admin', 'supervisor', 'agent'].includes(role)) {
    user.role = role;
  }
  await repo.save(user);

  if (role) {
    await logAudit(req.userId!, 'user.role_changed', 'user', user.id, user.tenantId, { previousRole: originalRole, newRole: role });
  }

  // Invalidate cache so changes take effect immediately
  if (user.clerkUserId) {
    const tenant = await AppDataSource.getRepository(Tenant).findOne({ where: { id: user.tenantId } });
    if (tenant?.clerkOrgId) {
      invalidateProvisionCache(tenant.clerkOrgId, user.clerkUserId);
    }
  }

  sendSuccess(res, user);
}));

// POST /admin/tenants/:id/invite — invite user to a tenant
router.post('/tenants/:id/invite', validate(inviteMemberSchema), asyncHandler(async (req: Request, res: Response) => {
  const { email, role } = req.body;

  const tenantRepo = AppDataSource.getRepository(Tenant);
  const tenant = await tenantRepo.findOne({ where: { id: req.params.id } });

  if (!tenant) throw new NotFoundError('Tenant not found');
  if (!tenant.clerkOrgId) throw new BadRequestError('Tenant has no Clerk organization linked');

  const invited = await inviteToClerkOrganization(
    tenant.clerkOrgId,
    email,
    req.user?.clerkUserId
  );
  if (!invited) {
    res.status(502).json({ success: false, error: { message: 'Failed to send invite via Clerk' } });
    return;
  }

  // Create or upsert PendingInvite
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
  await logAudit(req.userId!, 'invite.sent', 'invite', savedInvite?.id ?? tenant.id, tenant.id, { email, role });

  logger.info('Invited user to tenant', { tenantId: tenant.id, email, role, invitedBy: req.userId });
  sendSuccess(res, { message: 'Invitation sent' });
}));

// POST /admin/users/:id/deactivate — deactivate a user
router.post('/users/:id/deactivate', asyncHandler(async (req: Request, res: Response) => {
  const userRepo = AppDataSource.getRepository(User);
  const user = await userRepo.findOne({ where: { id: req.params.id, deletedAt: IsNull() } });

  if (!user) throw new NotFoundError('User not found');
  if (!user.isActive) throw new BadRequestError('User is already inactive');
  if (req.params.id === req.userId) throw new BadRequestError('Cannot deactivate yourself');

  // Wrap in transaction for atomicity
  let releaseResult = { releasedSessions: 0, returnedHandoffs: 0, affectedSessionIds: [] as string[] };
  await AppDataSource.transaction(async (manager) => {
    user.isActive = false;
    await manager.save(User, user);
    releaseResult = await releaseAgentSessions(user.id, user.tenantId, manager);
  });

  // Fetch tenant once for Clerk removal + cache invalidation
  const tenant = user.clerkUserId
    ? await AppDataSource.getRepository(Tenant).findOne({ where: { id: user.tenantId } })
    : null;

  // Remove from Clerk org if applicable
  if (user.clerkUserId && tenant?.clerkOrgId) {
    const removed = await removeFromClerkOrganization(tenant.clerkOrgId, user.clerkUserId);
    if (!removed) {
      logger.warn('Failed to remove user from Clerk org — deactivated locally only', {
        userId: user.id, tenantId: tenant.id,
      });
    }
  }

  await logAudit(req.userId!, 'user.deactivated', 'user', user.id, user.tenantId, {
    releasedSessions: releaseResult.releasedSessions,
    returnedHandoffs: releaseResult.returnedHandoffs,
  });

  // Invalidate cache so changes take effect immediately
  if (user.clerkUserId && tenant?.clerkOrgId) {
    invalidateProvisionCache(tenant.clerkOrgId, user.clerkUserId);
  }

  // Socket events — after transaction committed
  for (const sessionId of releaseResult.affectedSessionIds) {
    emitToSession(user.tenantId, sessionId, 'agent:removed', {
      sessionId,
      reason: 'agent_deactivated',
    });
  }
  if (releaseResult.releasedSessions > 0 || releaseResult.returnedHandoffs > 0) {
    emitToTenantAgents(user.tenantId, 'handoff:queue_updated', {
      reason: 'agent_deactivated',
    });
  }

  logger.info('Deactivated user', { userId: user.id, deactivatedBy: req.userId });
  sendSuccess(res, user);
}));

// POST /admin/users/:id/reactivate — reactivate a deactivated user
router.post('/users/:id/reactivate', asyncHandler(async (req: Request, res: Response) => {
  const { role } = req.body;
  const userRepo = AppDataSource.getRepository(User);
  const user = await userRepo.findOne({ where: { id: req.params.id, deletedAt: IsNull() } });

  if (!user) throw new NotFoundError('User not found');
  if (user.isActive) throw new BadRequestError('User is already active');

  user.isActive = true;
  if (role && ['admin', 'supervisor', 'agent'].includes(role)) {
    user.role = role;
  }
  await userRepo.save(user);
  await logAudit(req.userId!, 'user.reactivated', 'user', user.id, user.tenantId);

  // Re-invite to Clerk org
  if (user.clerkUserId) {
    const tenant = await AppDataSource.getRepository(Tenant).findOne({
      where: { id: user.tenantId },
    });
    if (tenant?.clerkOrgId) {
      await addMemberToClerkOrganization(tenant.clerkOrgId, user.clerkUserId!, 'org:member');
    }
  }

  logger.info('Reactivated user', { userId: user.id, role: user.role });
  sendSuccess(res, user);
}));

// POST /admin/users/:id/promote — promote to super admin
router.post('/users/:id/promote', asyncHandler(async (req: Request, res: Response) => {
  const repo = AppDataSource.getRepository(User);
  const user = await repo.findOne({ where: { id: req.params.id, deletedAt: IsNull() } });

  if (!user) throw new NotFoundError('User not found');
  if (user.role === 'super_admin') throw new BadRequestError('User is already a super admin');

  const previousRole = user.role;
  user.role = 'super_admin';
  user.notificationPreferences = { ...user.notificationPreferences, _previousRole: previousRole } as typeof user.notificationPreferences;
  await repo.save(user);
  await logAudit(req.userId!, 'user.promoted', 'user', user.id, user.tenantId, { previousRole });

  logger.info('User promoted to super_admin', { promotedBy: req.userId, userId: user.id });
  sendSuccess(res, user);
}));

// POST /admin/users/:id/demote — demote super admin
router.post('/users/:id/demote', asyncHandler(async (req: Request, res: Response) => {
  const repo = AppDataSource.getRepository(User);
  const user = await repo.findOne({ where: { id: req.params.id, deletedAt: IsNull() } });

  if (!user) throw new NotFoundError('User not found');
  if (user.role !== 'super_admin') throw new BadRequestError('User is not a super admin');

  const superAdminCount = await repo.count({ where: { role: 'super_admin' as const, deletedAt: IsNull() } });
  if (superAdminCount <= 1) throw new BadRequestError('Cannot demote the last super admin');

  const prefs = user.notificationPreferences as Record<string, unknown> | undefined;
  const previousRole = prefs?._previousRole as string | undefined;
  user.role = (previousRole && ['admin', 'supervisor', 'agent'].includes(previousRole))
    ? previousRole as typeof user.role
    : 'admin';

  if (prefs?._previousRole) {
    const { _previousRole: _, ...rest } = prefs;
    user.notificationPreferences = rest as typeof user.notificationPreferences;
  }
  await repo.save(user);
  await logAudit(req.userId!, 'user.demoted', 'user', user.id, user.tenantId, { newRole: user.role });

  logger.info('User demoted from super_admin', { demotedBy: req.userId, userId: user.id, newRole: user.role });
  sendSuccess(res, user);
}));

// DELETE /admin/users/:id — permanently anonymize and soft-delete a deactivated user
router.delete('/users/:id', asyncHandler(async (req: Request, res: Response) => {
  const userId = req.params.id;
  const userRepo = AppDataSource.getRepository(User);
  const user = await userRepo.findOne({ where: { id: userId, deletedAt: IsNull() } });

  if (!user) throw new NotFoundError('User not found');
  if (user.isActive) throw new BadRequestError('User must be deactivated before deletion');
  if (userId === req.userId) throw new BadRequestError('Cannot delete yourself');

  // Prevent deleting last super admin
  if (user.role === 'super_admin') {
    const superAdminCount = await userRepo.count({ where: { role: 'super_admin' as const, deletedAt: IsNull() } });
    if (superAdminCount <= 1) throw new BadRequestError('Cannot delete the last super admin');
  }

  // Store Clerk info before anonymization (needed for post-transaction cleanup)
  const clerkUserId = user.clerkUserId;
  const tenantId = user.tenantId;
  const tenant = await AppDataSource.getRepository(Tenant).findOne({ where: { id: tenantId } });

  // Find agent profile (if exists)
  const agentRepo = AppDataSource.getRepository(Agent);
  const agent = await agentRepo.findOne({ where: { userId, deletedAt: IsNull() } });

  // Single transaction: anonymize + soft-delete + cleanup references
  await AppDataSource.transaction(async (manager) => {
    // 1. Anonymize user PII
    user.name = 'Deleted User';
    user.email = `deleted_${user.id}@removed.local`;
    user.avatarUrl = null as unknown as string | undefined;
    user.clerkUserId = null as unknown as string | undefined;
    user.deletedAt = new Date();
    await manager.save(User, user);

    // 2. Soft-delete agent profile
    if (agent) {
      agent.status = 'offline';
      agent.deletedAt = new Date();
      await manager.save(Agent, agent);

      // 3. Release agent sessions + handoff requests
      await releaseAgentSessions(userId, tenantId!, manager);
    }

    // 5. Delete pending invites created by this user
    await manager
      .createQueryBuilder()
      .delete()
      .from(PendingInvite)
      .where('invited_by = :userId', { userId })
      .execute();
  });

  // Post-transaction: remove from Clerk org (non-blocking)
  if (clerkUserId && tenant?.clerkOrgId) {
    const removed = await removeFromClerkOrganization(tenant.clerkOrgId, clerkUserId);
    if (!removed) {
      logger.warn('Failed to remove deleted user from Clerk org', { userId, clerkUserId });
    }
    invalidateProvisionCache(tenant.clerkOrgId, clerkUserId);
  }

  await logAudit(req.userId!, 'user.deleted', 'user', userId, tenantId, {
    deletedUserEmail: `deleted_${userId}@removed.local`,
  });

  logger.info('Permanently deleted user', { deletedBy: req.userId, userId });
  sendSuccess(res, { deleted: true });
}));

// ==================
// Platform Analytics
// ==================

// GET /admin/analytics — cross-tenant metrics
router.get('/analytics', asyncHandler(async (_req: Request, res: Response) => {
  const tenantRepo = AppDataSource.getRepository(Tenant);
  const userRepo = AppDataSource.getRepository(User);
  const sessionRepo = AppDataSource.getRepository(ChatSession);
  const messageRepo = AppDataSource.getRepository(Message);

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const [totalTenants, totalUsers, totalSessions, activeSessions, messagesToday] = await Promise.all([
    tenantRepo.count({ where: { status: 'active' } }),
    userRepo.count({ where: { isActive: true } }),
    sessionRepo.count(),
    sessionRepo.count({ where: { status: 'active' } }),
    messageRepo.createQueryBuilder('m')
      .where('m.createdAt >= :today', { today })
      .getCount(),
  ]);

  // Per-tenant breakdown
  const tenantBreakdown = await tenantRepo
    .createQueryBuilder('t')
    .select('t.id', 'tenantId')
    .addSelect('t.name', 'name')
    .addSelect('t.tier', 'tier')
    .addSelect('COUNT(DISTINCT u.id)', 'userCount')
    .addSelect('COUNT(DISTINCT s.id)', 'sessionCount')
    .leftJoin(User, 'u', 'u.tenant_id = t.id')
    .leftJoin(ChatSession, 's', 's.tenant_id = t.id')
    .where('t.status = :status', { status: 'active' })
    .groupBy('t.id')
    .addGroupBy('t.name')
    .addGroupBy('t.tier')
    .orderBy('"sessionCount"', 'DESC')
    .getRawMany();

  sendSuccess(res, {
    totalTenants,
    totalUsers,
    totalSessions,
    activeSessions,
    messagesToday,
    tenantBreakdown,
  });
}));

// ==================
// Audit Logs
// ==================

// GET /admin/audit-logs — list audit logs with filters
router.get('/audit-logs', asyncHandler(async (req: Request, res: Response) => {
  const params = parsePaginationParams(req.query as Record<string, unknown>);
  const qb = AppDataSource.getRepository(AuditLog)
    .createQueryBuilder('log');

  const tenantId = req.query.tenantId as string;
  if (tenantId) {
    qb.andWhere('log.tenantId = :tenantId', { tenantId });
  }

  const action = req.query.action as string;
  if (action) {
    qb.andWhere('log.action = :action', { action });
  }

  const from = req.query.from as string;
  if (from) {
    qb.andWhere('log.createdAt >= :from', { from: new Date(from) });
  }

  const to = req.query.to as string;
  if (to) {
    qb.andWhere('log.createdAt <= :to', { to: new Date(to) });
  }

  qb.orderBy('log.createdAt', 'DESC');

  const result = await applyPagination(qb, params);

  // Resolve actor names
  const actorIds = [...new Set(result.data.map(l => l.actorId))];
  const actors = actorIds.length > 0
    ? await AppDataSource.getRepository(User)
        .createQueryBuilder('u')
        .select(['u.id', 'u.name', 'u.email'])
        .where('u.id IN (:...ids)', { ids: actorIds })
        .getMany()
    : [];
  const actorMap = new Map(actors.map(a => [a.id, { name: a.name, email: a.email }]));

  const data = result.data.map(log => ({
    id: log.id,
    tenantId: log.tenantId,
    actorId: log.actorId,
    actorName: actorMap.get(log.actorId)?.name ?? 'Unknown',
    actorEmail: actorMap.get(log.actorId)?.email ?? '',
    action: log.action,
    entityType: log.entityType,
    entityId: log.entityId,
    metadata: log.metadata,
    createdAt: log.createdAt,
  }));

  sendSuccess(res, data, { pagination: result.meta });
}));

// GET /admin/audit-logs/export — CSV export
router.get('/audit-logs/export', asyncHandler(async (req: Request, res: Response) => {
  const qb = AppDataSource.getRepository(AuditLog)
    .createQueryBuilder('log')
    .orderBy('log.createdAt', 'DESC');

  const tenantId = req.query.tenantId as string;
  if (tenantId) qb.andWhere('log.tenantId = :tenantId', { tenantId });

  const from = req.query.from as string;
  if (from) qb.andWhere('log.createdAt >= :from', { from: new Date(from) });

  const to = req.query.to as string;
  if (to) qb.andWhere('log.createdAt <= :to', { to: new Date(to) });

  const action = req.query.action as string;
  if (action) qb.andWhere('log.action = :action', { action });

  const logs = await qb.take(10000).getMany();

  const actorIds = [...new Set(logs.map(l => l.actorId))];
  const actors = actorIds.length > 0
    ? await AppDataSource.getRepository(User).createQueryBuilder('u')
        .select(['u.id', 'u.name', 'u.email'])
        .where('u.id IN (:...ids)', { ids: actorIds })
        .getMany()
    : [];
  const actorMap = new Map(actors.map(a => [a.id, a]));

  const header = 'timestamp,actor_name,actor_email,action,entity_type,entity_id,metadata\n';
  const rows = logs.map(l => {
    const actor = actorMap.get(l.actorId);
    const meta = l.metadata ? JSON.stringify(l.metadata).replace(/"/g, '""') : '';
    return `${l.createdAt.toISOString()},"${actor?.name ?? 'Unknown'}","${actor?.email ?? ''}",${l.action},${l.entityType},${l.entityId},"${meta}"`;
  }).join('\n');

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename=audit-logs-${new Date().toISOString().slice(0, 10)}.csv`);
  res.send(header + rows);
}));

export default router;
