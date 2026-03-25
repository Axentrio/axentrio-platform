/**
 * Agent Routes
 * CRUD and status management for agents
 */
import { Router, Request, Response } from 'express';
import { AppDataSource } from '../database/data-source';
import { Agent } from '../database/entities/Agent';
import { User } from '../database/entities/User';
import { logger } from '../utils/logger';
import { requireClerkAuth, autoProvision, ProvisionedRequest } from '../middleware/clerk.middleware';
import { cached, invalidate } from '../utils/cache';

const router = Router();
const agentRepository = AppDataSource.getRepository(Agent);
const userRepository = AppDataSource.getRepository(User);

// All routes require agent authentication
router.use(requireClerkAuth, autoProvision);

/**
 * GET /agents
 * List agents for tenant (paginated)
 */
router.get(
  '/',
  async (req: Request, res: Response): Promise<void> => {
    try {
      const authReq = req as ProvisionedRequest;
      const tenantId = authReq.user?.tenantId;
      const limit = Math.min(parseInt(req.query.limit as string) || 20, 50);
      const offset = parseInt(req.query.offset as string) || 0;
      const status = req.query.status as string;

      const where: any = { tenantId };
      if (status && ['online', 'away', 'busy', 'offline'].includes(status)) {
        where.status = status;
      }

      // Only cache the default (unfiltered, first page) request
      const isDefaultRequest = !status && offset === 0 && limit === 20;
      const cacheKey = isDefaultRequest ? `agents:${tenantId}` : null;

      const getData = async () => {
        const [agents, total] = await agentRepository.findAndCount({
          where,
          relations: ['user'],
          order: { createdAt: 'DESC' },
          take: limit,
          skip: offset,
        });

        return {
          agents: agents.map((a) => ({
            id: a.id,
            name: a.user?.name,
            email: a.user?.email,
            role: a.user?.role,
            status: a.status,
            maxConcurrentChats: a.maxConcurrentChats,
            currentChatCount: a.currentChatCount,
            skills: a.skills,
            languages: a.languages,
            lastActiveAt: a.lastActiveAt,
            createdAt: a.createdAt,
          })),
          pagination: {
            total,
            limit,
            offset,
            hasMore: offset + limit < total,
          },
        };
      };

      const result = cacheKey
        ? await cached(cacheKey, 60, getData)
        : await getData();

      res.json({ success: true, ...result });
    } catch (error) {
      logger.error('Error listing agents:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

/**
 * GET /agents/:id
 * Get agent by ID
 */
router.get(
  '/:id',
  async (req: Request, res: Response): Promise<void> => {
    try {
      const authReq = req as ProvisionedRequest;
      const { id } = req.params;

      const agent = await agentRepository.findOne({
        where: { id, tenantId: authReq.user?.tenantId },
        relations: ['user'],
      });

      if (!agent) {
        res.status(404).json({ error: 'Agent not found' });
        return;
      }

      res.json({
        success: true,
        agent: {
          id: agent.id,
          name: agent.user?.name,
          email: agent.user?.email,
          role: agent.user?.role,
          status: agent.status,
          maxConcurrentChats: agent.maxConcurrentChats,
          currentChatCount: agent.currentChatCount,
          skills: agent.skills,
          languages: agent.languages,
          totalChatsHandled: agent.totalChatsHandled,
          avgResponseTimeSeconds: agent.avgResponseTimeSeconds,
          satisfactionScore: agent.satisfactionScore,
          lastActiveAt: agent.lastActiveAt,
          createdAt: agent.createdAt,
        },
      });
    } catch (error) {
      logger.error('Error fetching agent:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

/**
 * POST /agents
 * Create a new agent
 */
router.post(
  '/',
  async (req: Request, res: Response): Promise<void> => {
    try {
      const authReq = req as ProvisionedRequest;
      const tenantId = authReq.user?.tenantId;
      const { userId, maxConcurrentChats, skills, languages } = req.body;

      if (!userId) {
        res.status(400).json({ error: 'userId is required' });
        return;
      }

      // Verify user exists and belongs to tenant
      const user = await userRepository.findOne({
        where: { id: userId, tenantId },
      });

      if (!user) {
        res.status(404).json({ error: 'User not found' });
        return;
      }

      // Check if agent profile already exists
      const existing = await agentRepository.findOne({
        where: { userId },
      });

      if (existing) {
        res.status(409).json({ error: 'Agent profile already exists for this user' });
        return;
      }

      const agent = agentRepository.create({
        tenantId: tenantId!,
        userId,
        maxConcurrentChats: maxConcurrentChats || 5,
        skills: skills || [],
        languages: languages || ['en'],
      });

      const saved = await agentRepository.save(agent);
      await invalidate(`agents:${tenantId}`);

      logger.info('Agent created', { agentId: saved.id, userId });

      res.status(201).json({
        success: true,
        agent: {
          id: saved.id,
          userId: saved.userId,
          status: saved.status,
          maxConcurrentChats: saved.maxConcurrentChats,
          skills: saved.skills,
          languages: saved.languages,
        },
      });
    } catch (error) {
      logger.error('Error creating agent:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

/**
 * PATCH /agents/:id
 * Update agent details
 */
router.patch(
  '/:id',
  async (req: Request, res: Response): Promise<void> => {
    try {
      const authReq = req as ProvisionedRequest;
      const { id } = req.params;
      const { maxConcurrentChats, skills, languages } = req.body;

      const agent = await agentRepository.findOne({
        where: { id, tenantId: authReq.user?.tenantId },
      });

      if (!agent) {
        res.status(404).json({ error: 'Agent not found' });
        return;
      }

      if (maxConcurrentChats !== undefined) agent.maxConcurrentChats = maxConcurrentChats;
      if (skills !== undefined) agent.skills = skills;
      if (languages !== undefined) agent.languages = languages;

      await agentRepository.save(agent);

      res.json({
        success: true,
        agent: {
          id: agent.id,
          maxConcurrentChats: agent.maxConcurrentChats,
          skills: agent.skills,
          languages: agent.languages,
        },
      });
    } catch (error) {
      logger.error('Error updating agent:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

/**
 * PATCH /agents/:id/status
 * Update agent online status
 */
router.patch(
  '/:id/status',
  async (req: Request, res: Response): Promise<void> => {
    try {
      const authReq = req as ProvisionedRequest;
      const { id } = req.params;
      const { status } = req.body;

      if (!status || !['online', 'away', 'busy', 'offline'].includes(status)) {
        res.status(400).json({ error: 'Valid status is required (online, away, busy, offline)' });
        return;
      }

      const agent = await agentRepository.findOne({
        where: { id, tenantId: authReq.user?.tenantId },
      });

      if (!agent) {
        res.status(404).json({ error: 'Agent not found' });
        return;
      }

      agent.updateStatus(status);
      await agentRepository.save(agent);
      await invalidate(`agents:${authReq.user?.tenantId}`);

      res.json({
        success: true,
        agent: {
          id: agent.id,
          status: agent.status,
          lastStatusChangeAt: agent.lastStatusChangeAt,
        },
      });
    } catch (error) {
      logger.error('Error updating agent status:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

/**
 * GET /agents/:id/performance
 * Get agent performance metrics (stub)
 */
router.get(
  '/:id/performance',
  async (req: Request, res: Response): Promise<void> => {
    try {
      const authReq = req as ProvisionedRequest;
      const { id } = req.params;

      const agent = await agentRepository.findOne({
        where: { id, tenantId: authReq.user?.tenantId },
      });

      if (!agent) {
        res.status(404).json({ error: 'Agent not found' });
        return;
      }

      res.json({
        success: true,
        performance: {
          agentId: agent.id,
          totalChatsHandled: agent.totalChatsHandled,
          avgResponseTimeSeconds: agent.avgResponseTimeSeconds,
          satisfactionScore: agent.satisfactionScore,
          currentChatCount: agent.currentChatCount,
        },
      });
    } catch (error) {
      logger.error('Error fetching agent performance:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

/**
 * GET /agents/:id/shifts
 * Get agent shifts (stub)
 */
router.get(
  '/:id/shifts',
  async (_req: Request, res: Response): Promise<void> => {
    res.json({
      success: true,
      shifts: [],
    });
  }
);

export default router;
