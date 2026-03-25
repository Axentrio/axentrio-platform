/**
 * Analytics Routes
 * Dashboard metrics and reporting
 */
import { Router, Request, Response } from 'express';
import { AppDataSource } from '../database/data-source';
import { ChatSession } from '../database/entities/ChatSession';
import { Agent } from '../database/entities/Agent';
import { logger } from '../utils/logger';
import { requireClerkAuth, autoProvision, ProvisionedRequest } from '../middleware/clerk.middleware';

const router = Router();
const sessionRepository = AppDataSource.getRepository(ChatSession);
const agentRepository = AppDataSource.getRepository(Agent);

// All routes require agent authentication
router.use(requireClerkAuth, autoProvision);

/**
 * GET /analytics/dashboard
 * Aggregate metrics for the dashboard
 */
router.get(
  '/dashboard',
  async (req: Request, res: Response): Promise<void> => {
    try {
      const authReq = req as ProvisionedRequest;
      const tenantId = authReq.user?.tenantId;

      // Total sessions
      const totalSessions = await sessionRepository.count({
        where: { tenantId },
      });

      // Active sessions
      const activeSessions = await sessionRepository.count({
        where: { tenantId, status: 'active' as const },
      });

      // Waiting sessions
      const waitingSessions = await sessionRepository.count({
        where: { tenantId, status: 'waiting' as const },
      });

      // Handoff sessions
      const handoffSessions = await sessionRepository.count({
        where: { tenantId, status: 'handoff' as const },
      });

      // Bot sessions (active AI conversations)
      const botSessions = await sessionRepository.count({
        where: { tenantId, status: 'bot' as const },
      });

      // Total agents
      const totalAgents = await agentRepository.count({
        where: { tenantId },
      });

      // Online agents
      const onlineAgents = await agentRepository.count({
        where: { tenantId, status: 'online' as const },
      });

      // Average response time across agents
      const agents = await agentRepository.find({
        where: { tenantId },
        select: ['avgResponseTimeSeconds'],
      });

      const avgResponseTime = agents.length > 0
        ? Math.round(agents.reduce((sum, a) => sum + a.avgResponseTimeSeconds, 0) / agents.length)
        : 0;

      // CSAT score (average satisfaction rating)
      const csatResult = await sessionRepository
        .createQueryBuilder('session')
        .select('AVG(session.satisfaction_rating)', 'avgCsat')
        .where('session.tenant_id = :tenantId', { tenantId })
        .andWhere('session.satisfaction_rating IS NOT NULL')
        .getRawOne();

      const csatScore = csatResult?.avgCsat
        ? parseFloat(parseFloat(csatResult.avgCsat).toFixed(1))
        : null;

      // Bot resolution rate (sessions that closed without ever reaching handoff/active)
      const closedSessions = await sessionRepository.count({
        where: { tenantId, status: 'closed' as const },
      });

      // Sessions that were closed and had an agent assigned = human-resolved
      const humanResolved = await sessionRepository
        .createQueryBuilder('session')
        .where('session.tenant_id = :tenantId', { tenantId })
        .andWhere('session.status = :status', { status: 'closed' })
        .andWhere('session.assigned_agent_id IS NOT NULL')
        .getCount();

      const botResolved = closedSessions - humanResolved;
      const botResolutionRate = closedSessions > 0
        ? Math.round((botResolved / closedSessions) * 100)
        : null;

      res.json({
        success: true,
        dashboard: {
          sessions: {
            total: totalSessions,
            active: activeSessions,
            waiting: waitingSessions,
            handoff: handoffSessions,
            bot: botSessions,
          },
          agents: {
            total: totalAgents,
            online: onlineAgents,
          },
          avgResponseTimeSeconds: avgResponseTime,
          csatScore,
          botResolutionRate,
        },
      });
    } catch (error) {
      logger.error('Error fetching dashboard metrics:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

/**
 * GET /analytics/chats
 * Chat metrics with date range
 */
router.get(
  '/chats',
  async (req: Request, res: Response): Promise<void> => {
    try {
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

      // Average duration for closed sessions
      const avgResult = await qb.clone()
        .select('AVG(session.duration_seconds)', 'avgDuration')
        .andWhere('session.status = :status', { status: 'closed' })
        .andWhere('session.duration_seconds IS NOT NULL')
        .getRawOne();

      res.json({
        success: true,
        metrics: {
          total,
          closed,
          open: total - closed,
          avgDurationSeconds: Math.round(avgResult?.avgDuration || 0),
        },
      });
    } catch (error) {
      logger.error('Error fetching chat metrics:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

/**
 * GET /analytics/agents
 * Agent performance metrics
 */
router.get(
  '/agents',
  async (req: Request, res: Response): Promise<void> => {
    try {
      const authReq = req as ProvisionedRequest;
      const tenantId = authReq.user?.tenantId;

      const agents = await agentRepository.find({
        where: { tenantId },
        relations: ['user'],
      });

      res.json({
        success: true,
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
    } catch (error) {
      logger.error('Error fetching agent metrics:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

/**
 * GET /analytics/chats/timeseries
 * Daily chat volume grouped by status category
 */
router.get(
  '/chats/timeseries',
  async (req: Request, res: Response): Promise<void> => {
    try {
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
        .getRawMany();

      const timeseries = rawData.map((row: any) => ({
        date: row.date,
        bot: parseInt(row.bot, 10) || 0,
        human: parseInt(row.human, 10) || 0,
        handoff: parseInt(row.handoff, 10) || 0,
      }));

      res.json({
        success: true,
        timeseries,
      });
    } catch (error) {
      logger.error('Error fetching chat timeseries:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

/**
 * POST /analytics/export
 * Export analytics data (stub)
 */
router.post(
  '/export',
  (_req: Request, res: Response): void => {
    res.status(501).json({ error: 'Analytics export not yet implemented' });
  }
);

export default router;
