import { Router, Request, Response } from 'express';
import { AppDataSource } from '../../database/data-source';
import { Tenant } from '../../database/entities/Tenant';
import { User } from '../../database/entities/User';
import { ChatSession } from '../../database/entities/ChatSession';
import { Message } from '../../database/entities/Message';
import { parsePaginationParams, applyPagination } from '../../utils/pagination';
import { AuditLog } from '../../database/entities/AuditLog';
import { asyncHandler } from '../../middleware/error-handler';
import { sendSuccess } from '../../utils/response';

const router = Router();


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
    // Normalize to end-of-day: use exclusive next-day comparison
    const nextDay = new Date(to);
    nextDay.setDate(nextDay.getDate() + 1);
    qb.andWhere('log.createdAt < :toExclusive', { toExclusive: nextDay });
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

  // Resolve tenant names
  const tenantIds = [...new Set(result.data.map(l => l.tenantId).filter(Boolean))];
  const tenantNames = tenantIds.length > 0
    ? await AppDataSource.getRepository(Tenant)
        .createQueryBuilder('t')
        .select(['t.id', 't.name'])
        .where('t.id IN (:...ids)', { ids: tenantIds })
        .getMany()
    : [];
  const tenantMap = new Map(tenantNames.map(t => [t.id, t.name]));

  const data = result.data.map(log => ({
    id: log.id,
    tenantId: log.tenantId,
    tenantName: log.tenantId ? (tenantMap.get(log.tenantId) ?? null) : null,
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
  if (to) {
    const nextDay = new Date(to);
    nextDay.setDate(nextDay.getDate() + 1);
    qb.andWhere('log.createdAt < :toExclusive', { toExclusive: nextDay });
  }

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

  const tenantIds = [...new Set(logs.map(l => l.tenantId).filter(Boolean))];
  const tenantEntities = tenantIds.length > 0
    ? await AppDataSource.getRepository(Tenant).createQueryBuilder('t')
        .select(['t.id', 't.name'])
        .where('t.id IN (:...ids)', { ids: tenantIds })
        .getMany()
    : [];
  const tenantMap = new Map(tenantEntities.map(t => [t.id, t.name]));

  const header = 'timestamp,actor_name,actor_email,tenant_name,action,entity_type,entity_id,metadata\n';
  const rows = logs.map(l => {
    const actor = actorMap.get(l.actorId);
    const tName = l.tenantId ? (tenantMap.get(l.tenantId) ?? '') : '';
    const meta = l.metadata ? JSON.stringify(l.metadata).replace(/"/g, '""') : '';
    return `${l.createdAt.toISOString()},"${actor?.name ?? 'Unknown'}","${actor?.email ?? ''}","${tName}",${l.action},${l.entityType},${l.entityId},"${meta}"`;
  }).join('\n');

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename=audit-logs-${new Date().toISOString().slice(0, 10)}.csv`);
  res.send(header + rows);
}));

export default router;
