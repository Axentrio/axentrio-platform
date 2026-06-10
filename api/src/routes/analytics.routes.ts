/**
 * Analytics Routes
 * Dashboard metrics and reporting
 */
import { Router, Request, Response } from 'express';
import { AppDataSource } from '../database/data-source';
import { ChatSession } from '../database/entities/ChatSession';
import { Agent } from '../database/entities/Agent';
import { requireClerkAuth, autoProvision, ProvisionedRequest } from '../middleware/clerk.middleware';
import { resolveTenantContext } from '../middleware/super-admin.middleware';
import { cached } from '../utils/cache';
import { asyncHandler, ApiError } from '../middleware/error-handler';
import { ERROR_CODES } from '../middleware/error-codes';
import { validate } from '../middleware/validate';
import { sendSuccess } from '../utils/response';
import { analyticsQuerySchema } from '../schemas';

const router = Router();
const sessionRepository = AppDataSource.getRepository(ChatSession);
const agentRepository = AppDataSource.getRepository(Agent);

// All routes require agent authentication
router.use(requireClerkAuth, autoProvision, resolveTenantContext);

/**
 * GET /analytics/dashboard
 * Aggregate metrics for the dashboard
 */
router.get(
  '/dashboard',
  asyncHandler(async (req: Request, res: Response) => {
    const authReq = req as ProvisionedRequest;
    const tenantId = authReq.user?.tenantId;

    const dashboard = await cached(
      `dashboard:${tenantId}`,
      30,
      async () => {
        // Two consolidated queries run in parallel
        const [sessionStats, agentStats] = await Promise.all([
          // Query 1: All session counts + CSAT in one pass
          sessionRepository
            .createQueryBuilder('s')
            .select('COUNT(*)', 'total')
            .addSelect("COUNT(*) FILTER (WHERE s.status = 'active')", 'active')
            .addSelect("COUNT(*) FILTER (WHERE s.status = 'waiting')", 'waiting')
            .addSelect("COUNT(*) FILTER (WHERE s.status = 'handoff')", 'handoff')
            .addSelect("COUNT(*) FILTER (WHERE s.status = 'bot')", 'bot')
            .addSelect("COUNT(*) FILTER (WHERE s.status = 'closed')", 'closed')
            .addSelect("COUNT(*) FILTER (WHERE s.status = 'closed' AND s.assigned_agent_id IS NOT NULL)", 'humanResolved')
            .addSelect('AVG(s.satisfaction_rating) FILTER (WHERE s.satisfaction_rating IS NOT NULL)', 'csatAvg')
            .addSelect('COUNT(s.satisfaction_rating)', 'csatCount')
            .where('s.tenant_id = :tenantId', { tenantId })
            .getRawOne(),

          // Query 2: Agent counts + avg response time in one pass
          agentRepository
            .createQueryBuilder('a')
            .select('COUNT(*)', 'total')
            .addSelect("COUNT(*) FILTER (WHERE a.status = 'online')", 'online')
            .addSelect('AVG(a.avg_response_time_seconds)', 'avgResponseTime')
            .where('a.tenant_id = :tenantId', { tenantId })
            .getRawOne(),
        ]);

        const closed = parseInt(sessionStats?.closed || '0');
        const humanResolved = parseInt(sessionStats?.humanResolved || '0');
        const botResolved = closed - humanResolved;
        const csatAvg = sessionStats?.csatAvg ? parseFloat(parseFloat(sessionStats.csatAvg).toFixed(1)) : null;
        const botResolutionRate = closed > 0 ? Math.round((botResolved / closed) * 100) : null;

        return {
          sessions: {
            total: parseInt(sessionStats?.total || '0'),
            active: parseInt(sessionStats?.active || '0'),
            waiting: parseInt(sessionStats?.waiting || '0'),
            handoff: parseInt(sessionStats?.handoff || '0'),
            bot: parseInt(sessionStats?.bot || '0'),
          },
          agents: {
            total: parseInt(agentStats?.total || '0'),
            online: parseInt(agentStats?.online || '0'),
          },
          avgResponseTimeSeconds: Math.round(parseFloat(agentStats?.avgResponseTime || '0')),
          csatScore: csatAvg,
          botResolutionRate,
        };
      }
    );

    sendSuccess(res, { dashboard });
  })
);

/**
 * GET /analytics/chats
 * Chat metrics with date range
 */
router.get(
  '/chats',
  validate(analyticsQuerySchema, 'query'),
  asyncHandler(async (req: Request, res: Response) => {
    const authReq = req as ProvisionedRequest;
    const tenantId = authReq.user?.tenantId;
    const from = req.query.from as string;
    const to = req.query.to as string;

    const qb = sessionRepository.createQueryBuilder('session')
      .where('session.tenant_id = :tenantId', { tenantId });

    if (from) {
      qb.andWhere('session.created_at >= :from', { from: new Date(from) });
    }
    if (to) {
      qb.andWhere('session.created_at <= :to', { to: new Date(to) });
    }

    const total = await qb.getCount();

    const closed = await qb.clone()
      .andWhere('session.status = :status', { status: 'closed' })
      .getCount();

    // Closed sessions resolved by a human agent — same definition as the
    // dashboard endpoint (closed AND an agent was assigned).
    const humanResolved = await qb.clone()
      .andWhere('session.status = :status', { status: 'closed' })
      .andWhere('session.assigned_agent_id IS NOT NULL')
      .getCount();

    // Average duration for closed sessions
    const avgResult = await qb.clone()
      .select('AVG(session.duration_seconds)', 'avgDuration')
      .andWhere('session.status = :status', { status: 'closed' })
      .andWhere('session.duration_seconds IS NOT NULL')
      .getRawOne();

    sendSuccess(res, {
      metrics: {
        total,
        closed,
        open: total - closed,
        humanResolved,
        avgDurationSeconds: Math.round(avgResult?.avgDuration || 0),
      },
    });
  })
);

/**
 * GET /analytics/agents
 * Agent performance metrics
 */
router.get(
  '/agents',
  asyncHandler(async (req: Request, res: Response) => {
    const authReq = req as ProvisionedRequest;
    const tenantId = authReq.user?.tenantId;

    const agents = await agentRepository.find({
      where: { tenantId },
      relations: ['user'],
    });

    sendSuccess(res, {
      agents: agents.map((a) => ({
        id: a.id,
        name: a.user?.name,
        status: a.status,
        totalChatsHandled: a.totalChatsHandled,
        avgResponseTimeSeconds: a.avgResponseTimeSeconds,
        satisfactionScore: a.satisfactionScore,
        currentChatCount: a.currentChatCount,
      })),
    });
  })
);

/**
 * GET /analytics/chats/timeseries
 * Daily chat volume grouped by status category
 */
router.get(
  '/chats/timeseries',
  validate(analyticsQuerySchema, 'query'),
  asyncHandler(async (req: Request, res: Response) => {
    const authReq = req as ProvisionedRequest;
    const tenantId = authReq.user?.tenantId;
    const startDate = req.query.startDate as string;
    const endDate = req.query.endDate as string;

    // Default to last 7 days
    const end = endDate ? new Date(endDate) : new Date();
    const start = startDate ? new Date(startDate) : new Date(end.getTime() - 7 * 24 * 60 * 60 * 1000);

    const rawData = await sessionRepository
      .createQueryBuilder('session')
      .select("DATE(session.created_at)", 'date')
      .addSelect("COUNT(CASE WHEN session.assigned_agent_id IS NULL AND session.status = 'closed' THEN 1 END)", 'bot')
      .addSelect("COUNT(CASE WHEN session.assigned_agent_id IS NOT NULL THEN 1 END)", 'human')
      .addSelect("COUNT(CASE WHEN session.status IN ('handoff') THEN 1 END)", 'handoff')
      .where('session.tenant_id = :tenantId', { tenantId })
      .andWhere('session.created_at >= :start', { start })
      .andWhere('session.created_at <= :end', { end })
      .groupBy("DATE(session.created_at)")
      .orderBy("DATE(session.created_at)", 'ASC')
      .limit(366)
      .getRawMany();

    const timeseries = rawData.map((row: Record<string, string>) => ({
      date: row.date,
      bot: parseInt(row.bot, 10) || 0,
      human: parseInt(row.human, 10) || 0,
      handoff: parseInt(row.handoff, 10) || 0,
    }));

    sendSuccess(res, { timeseries });
  })
);

/**
 * POST /analytics/export
 * Export analytics data (stub)
 */
router.post(
  '/export',
  asyncHandler(async (_req: Request, _res: Response) => {
    throw new ApiError('Analytics export not yet implemented', 501, ERROR_CODES.NOT_IMPLEMENTED);
  })
);

export default router;
