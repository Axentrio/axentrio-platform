import { Router, Request, Response } from 'express';
import { IsNull } from 'typeorm';
import { AppDataSource } from '../../database/data-source';
import { Tenant } from '../../database/entities/Tenant';
import { User } from '../../database/entities/User';
import { PendingInvite } from '../../database/entities/PendingInvite';
import { Agent } from '../../database/entities/Agent';
import { invalidateProvisionCache } from '../../middleware/clerk.middleware';
import { parsePaginationParams, applyPagination } from '../../utils/pagination';
import { logger } from '../../utils/logger';
import { logAudit } from '../../utils/audit';
import {
  addMemberToClerkOrganization,
  inviteToClerkOrganization,
  removeFromClerkOrganization,
} from '../../services/clerk-sync.service';
import { ApiError, asyncHandler, BadRequestError, NotFoundError } from '../../middleware/error-handler';
import { ERROR_CODES } from '../../middleware/error-codes';
import { validate } from '../../middleware/validate';
import { sendSuccess } from '../../utils/response';
import { inviteMemberSchema } from '../../schemas';
import { releaseAgentSessions } from '../../utils/releaseAgentSessions';
import { emitToSession, emitToTenantAgents } from '../../websocket/socket.handler';

const router = Router();


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
    throw new ApiError('Failed to send invite via Clerk', 502, ERROR_CODES.CLERK_UPSTREAM_FAILED);
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

export default router;
