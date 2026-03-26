import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { AppDataSource } from '../database/data-source';
import { Tenant } from '../database/entities/Tenant';
import { User } from '../database/entities/User';
import { ChatSession } from '../database/entities/ChatSession';
import { Message } from '../database/entities/Message';
import { requireClerkAuth, autoProvision } from '../middleware/clerk.middleware';
import { requireSuperAdmin } from '../middleware/super-admin.middleware';
import { parsePaginationParams, applyPagination } from '../utils/pagination';
import { logger } from '../utils/logger';

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

// POST /admin/tenants — create tenant
router.post('/tenants', async (req: Request, res: Response) => {
  try {
    const { name, tier, settings } = req.body;
    if (!name) {
      return res.status(400).json({ error: 'Name is required' });
    }

    const repo = AppDataSource.getRepository(Tenant);
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const apiKey = `ak_${crypto.randomUUID().replace(/-/g, '')}`;

    const tenant = repo.create({ name, slug, apiKey, tier: tier || 'free', settings });
    await repo.save(tenant);

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

// PATCH /admin/users/:id — update user
router.patch('/users/:id', async (req: Request, res: Response) => {
  try {
    const repo = AppDataSource.getRepository(User);
    const user = await repo.findOne({ where: { id: req.params.id } });

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const { role, isActive } = req.body;
    if (role && ['admin', 'supervisor', 'agent'].includes(role)) {
      user.role = role;
    }
    if (typeof isActive === 'boolean') {
      user.isActive = isActive;
    }

    await repo.save(user);
    return res.json({ success: true, data: user });
  } catch (error) {
    logger.error('Failed to update user', { error });
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

export default router;
