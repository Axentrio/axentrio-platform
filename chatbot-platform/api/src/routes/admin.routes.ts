import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { AppDataSource } from '../database/data-source';
import { Tenant } from '../database/entities/Tenant';
import { User } from '../database/entities/User';
import { ChatSession } from '../database/entities/ChatSession';
import { Message } from '../database/entities/Message';
import { PendingInvite } from '../database/entities/PendingInvite';
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

const router = Router();

// All routes require Clerk auth + autoProvision + super admin
router.use(requireClerkAuth, autoProvision, requireSuperAdmin);

// ==================
// Tenant Management
// ==================

// GET /admin/tenants — list all tenants
router.get('/tenants', async (req: Request, res: Response) => {
  try {
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
    return res.json({ success: true, ...result });
  } catch (error) {
    logger.error('Failed to list tenants', { error });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /admin/tenants/:id — tenant details
router.get('/tenants/:id', async (req: Request, res: Response) => {
  try {
    const tenant = await AppDataSource.getRepository(Tenant).findOne({
      where: { id: req.params.id },
    });

    if (!tenant) {
      return res.status(404).json({ error: 'Tenant not found' });
    }

    const userCount = await AppDataSource.getRepository(User).count({
      where: { tenantId: tenant.id },
    });
    const sessionCount = await AppDataSource.getRepository(ChatSession).count({
      where: { tenantId: tenant.id },
    });

    return res.json({
      success: true,
      data: { ...tenant, userCount, sessionCount },
    });
  } catch (error) {
    logger.error('Failed to get tenant', { error });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /admin/tenants — create tenant with Clerk org
router.post('/tenants', async (req: Request, res: Response) => {
  try {
    const { name, tier, settings, adminEmail } = req.body;
    if (!name) {
      return res.status(400).json({ error: 'Name is required' });
    }

    // Step 1: Create Clerk org first
    const clerkOrg = await createClerkOrganization(name);
    if (!clerkOrg) {
      return res.status(502).json({ error: 'Failed to create organization in Clerk' });
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
      return res.status(500).json({ error: 'Failed to create tenant' });
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

    return res.status(201).json({ success: true, data: tenant });
  } catch (error) {
    logger.error('Failed to create tenant', { error });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// PATCH /admin/tenants/:id — update tenant
router.patch('/tenants/:id', async (req: Request, res: Response) => {
  try {
    const repo = AppDataSource.getRepository(Tenant);
    const tenant = await repo.findOne({ where: { id: req.params.id } });

    if (!tenant) {
      return res.status(404).json({ error: 'Tenant not found' });
    }

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

    return res.json({ success: true, data: tenant });
  } catch (error) {
    logger.error('Failed to update tenant', { error });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /admin/tenants/:id/suspend
router.post('/tenants/:id/suspend', async (req: Request, res: Response) => {
  try {
    const repo = AppDataSource.getRepository(Tenant);
    const tenant = await repo.findOne({ where: { id: req.params.id } });

    if (!tenant) {
      return res.status(404).json({ error: 'Tenant not found' });
    }

    tenant.status = 'suspended';
    await repo.save(tenant);
    await logAudit(req.userId!, 'tenant.suspended', 'tenant', tenant.id, tenant.id);

    if (tenant.clerkOrgId) {
      await updateClerkOrganization(tenant.clerkOrgId, {
        publicMetadata: { suspended: true },
      });
    }

    return res.json({ success: true, data: tenant });
  } catch (error) {
    logger.error('Failed to suspend tenant', { error });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /admin/tenants/:id/activate
router.post('/tenants/:id/activate', async (req: Request, res: Response) => {
  try {
    const repo = AppDataSource.getRepository(Tenant);
    const tenant = await repo.findOne({ where: { id: req.params.id } });

    if (!tenant) {
      return res.status(404).json({ error: 'Tenant not found' });
    }

    tenant.status = 'active';
    await repo.save(tenant);
    await logAudit(req.userId!, 'tenant.activated', 'tenant', tenant.id, tenant.id);

    if (tenant.clerkOrgId) {
      await updateClerkOrganization(tenant.clerkOrgId, {
        publicMetadata: { suspended: false },
      });
    }

    return res.json({ success: true, data: tenant });
  } catch (error) {
    logger.error('Failed to activate tenant', { error });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ==================
// User Management
// ==================

// GET /admin/users — list all users across tenants
router.get('/users', async (req: Request, res: Response) => {
  try {
    const params = parsePaginationParams(req.query as Record<string, unknown>);
    const qb = AppDataSource.getRepository(User)
      .createQueryBuilder('user')
      .leftJoinAndSelect('user.tenant', 'tenant');

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

    return res.json({ success: true, data, meta: result.meta });
  } catch (error) {
    logger.error('Failed to list users', { error });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /admin/users/:id — user details
router.get('/users/:id', async (req: Request, res: Response) => {
  try {
    const user = await AppDataSource.getRepository(User).findOne({
      where: { id: req.params.id },
      relations: ['tenant'],
    });

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    return res.json({
      success: true,
      data: {
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
      },
    });
  } catch (error) {
    logger.error('Failed to get user', { error });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// PATCH /admin/users/:id — update user (with Clerk sync on deactivation)
router.patch('/users/:id', async (req: Request, res: Response) => {
  try {
    const repo = AppDataSource.getRepository(User);
    const user = await repo.findOne({ where: { id: req.params.id } });

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const { role, isActive } = req.body;
    const originalRole = user.role;
    if (role && ['admin', 'supervisor', 'agent'].includes(role)) {
      user.role = role;
    }
    if (typeof isActive === 'boolean') {
      user.isActive = isActive;

      // If deactivating and user has Clerk ID, remove from Clerk org
      if (!isActive && user.clerkUserId) {
        const tenant = await AppDataSource.getRepository(Tenant).findOne({
          where: { id: user.tenantId },
        });
        if (tenant?.clerkOrgId) {
          const removed = await removeFromClerkOrganization(tenant.clerkOrgId, user.clerkUserId);
          if (!removed) {
            logger.warn('Failed to remove user from Clerk org — deactivated locally only', {
              userId: user.id, tenantId: tenant.id,
            });
          }
        }
      }
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

    return res.json({ success: true, data: user });
  } catch (error) {
    logger.error('Failed to update user', { error });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /admin/tenants/:id/invite — invite user to a tenant
router.post('/tenants/:id/invite', async (req: Request, res: Response) => {
  try {
    const { email, role } = req.body;
    if (!email || !role) {
      return res.status(400).json({ error: 'Email and role are required' });
    }

    if (!['admin', 'supervisor', 'agent'].includes(role)) {
      return res.status(400).json({ error: 'Invalid role. Must be admin, supervisor, or agent' });
    }

    const tenantRepo = AppDataSource.getRepository(Tenant);
    const tenant = await tenantRepo.findOne({ where: { id: req.params.id } });

    if (!tenant) {
      return res.status(404).json({ error: 'Tenant not found' });
    }

    if (!tenant.clerkOrgId) {
      return res.status(400).json({ error: 'Tenant has no Clerk organization linked' });
    }

    const invited = await inviteToClerkOrganization(
      tenant.clerkOrgId,
      email,
      req.user?.clerkUserId
    );
    if (!invited) {
      return res.status(502).json({ error: 'Failed to send invite via Clerk' });
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
    return res.json({ success: true, message: 'Invitation sent' });
  } catch (error) {
    logger.error('Failed to invite user', { error });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /admin/users/:id/reactivate — reactivate a deactivated user
router.post('/users/:id/reactivate', async (req: Request, res: Response) => {
  try {
    const { role } = req.body;
    const userRepo = AppDataSource.getRepository(User);
    const user = await userRepo.findOne({ where: { id: req.params.id } });

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    if (user.isActive) {
      return res.status(400).json({ error: 'User is already active' });
    }

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
    return res.json({ success: true, data: user });
  } catch (error) {
    logger.error('Failed to reactivate user', { error });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /admin/users/:id/promote — promote to super admin
router.post('/users/:id/promote', async (req: Request, res: Response) => {
  try {
    const repo = AppDataSource.getRepository(User);
    const user = await repo.findOne({ where: { id: req.params.id } });

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    if (user.role === 'super_admin') {
      return res.status(400).json({ error: 'User is already a super admin' });
    }

    const previousRole = user.role;
    user.role = 'super_admin';
    user.notificationPreferences = { ...user.notificationPreferences, _previousRole: previousRole } as typeof user.notificationPreferences;
    await repo.save(user);
    await logAudit(req.userId!, 'user.promoted', 'user', user.id, user.tenantId, { previousRole });

    logger.info('User promoted to super_admin', { promotedBy: req.userId, userId: user.id });
    return res.json({ success: true, data: user });
  } catch (error) {
    logger.error('Failed to promote user', { error });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /admin/users/:id/demote — demote super admin
router.post('/users/:id/demote', async (req: Request, res: Response) => {
  try {
    const repo = AppDataSource.getRepository(User);
    const user = await repo.findOne({ where: { id: req.params.id } });

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    if (user.role !== 'super_admin') {
      return res.status(400).json({ error: 'User is not a super admin' });
    }

    const superAdminCount = await repo.count({ where: { role: 'super_admin' as const } });
    if (superAdminCount <= 1) {
      return res.status(400).json({ error: 'Cannot demote the last super admin' });
    }

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
    return res.json({ success: true, data: user });
  } catch (error) {
    logger.error('Failed to demote user', { error });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ==================
// Platform Analytics
// ==================

// GET /admin/analytics — cross-tenant metrics
router.get('/analytics', async (_req: Request, res: Response) => {
  try {
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

    return res.json({
      success: true,
      data: {
        totalTenants,
        totalUsers,
        totalSessions,
        activeSessions,
        messagesToday,
        tenantBreakdown,
      },
    });
  } catch (error) {
    logger.error('Failed to get platform analytics', { error });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ==================
// Audit Logs
// ==================

// GET /admin/audit-logs — list audit logs with filters
router.get('/audit-logs', async (req: Request, res: Response) => {
  try {
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

    return res.json({ success: true, data, meta: result.meta });
  } catch (error) {
    logger.error('Failed to list audit logs', { error });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /admin/audit-logs/export — CSV export
router.get('/audit-logs/export', async (req: Request, res: Response) => {
  try {
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
    return res.send(header + rows);
  } catch (error) {
    logger.error('Failed to export audit logs', { error });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /admin/tenants/:id/pending-invites — list pending invites for a tenant
router.get('/tenants/:id/pending-invites', async (req: Request, res: Response) => {
  try {
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

    return res.json({ success: true, data });
  } catch (error) {
    logger.error('Failed to list tenant pending invites', { error });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
