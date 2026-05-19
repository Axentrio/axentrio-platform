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
import { resolveTenantContext } from '../middleware/super-admin.middleware';
import { cached, invalidate } from '../utils/cache';
import { parsePaginationParams, applyPagination } from '../utils/pagination';
import { asyncHandler, BadRequestError, NotFoundError, ConflictError } from '../middleware/error-handler';
import { validate } from '../middleware/validate';
import { sendSuccess, sendCreated } from '../utils/response';
import { createAgentSchema, updateAgentSchema, updateAgentStatusSchema } from '../schemas';
import { enforceCountLimit } from '../billing/enforce';

const router = Router();
const agentRepository = AppDataSource.getRepository(Agent);
const userRepository = AppDataSource.getRepository(User);

// All routes require agent authentication
router.use(requireClerkAuth, autoProvision, resolveTenantContext);

/**
 * GET /agents
 * List agents for tenant (paginated)
 */
router.get(
  '/',
  asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const authReq = req as ProvisionedRequest;
    const tenantId = authReq.user?.tenantId;
    const params = parsePaginationParams(req.query as Record<string, unknown>);
    const status = req.query.status as string;

    const isDefaultRequest = !status && params.page === 1 && params.limit === 20;
    const cacheKey = isDefaultRequest ? `agents:${tenantId}` : null;

    const getData = async () => {
      const qb = agentRepository.createQueryBuilder('agent')
        .leftJoinAndSelect('agent.user', 'user')
        .where('agent.tenantId = :tenantId', { tenantId });

      if (status && ['online', 'away', 'busy', 'offline'].includes(status)) {
        qb.andWhere('agent.status = :status', { status });
      }

      if (!params.sortBy) {
        qb.orderBy('agent.createdAt', 'DESC');
      }

      const result = await applyPagination(qb, params);

      return {
        agents: result.data.map((a) => ({
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
        meta: result.meta,
      };
    };

    const result = cacheKey
      ? await cached(cacheKey, 60, getData)
      : await getData();

    sendSuccess(res, result);
  })
);

/**
 * GET /agents/:id
 * Get agent by ID
 */
router.get(
  '/:id',
  asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const authReq = req as ProvisionedRequest;
    const { id } = req.params;

    const agent = await agentRepository.findOne({
      where: { id, tenantId: authReq.user?.tenantId },
      relations: ['user'],
    });

    if (!agent) {
      throw new NotFoundError('Agent not found');
    }

    sendSuccess(res, {
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
  })
);

/**
 * POST /agents
 * Create a new agent
 */
router.post(
  '/',
  validate(createAgentSchema),
  asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const authReq = req as ProvisionedRequest;
    const tenantId = authReq.user?.tenantId;
    const { userId, maxConcurrentChats, skills, languages } = req.body;

    if (!userId) {
      throw new BadRequestError('userId is required');
    }
    if (!tenantId) {
      throw new BadRequestError('Tenant context required');
    }

    // Verify user exists and belongs to tenant
    const user = await userRepository.findOne({
      where: { id: userId, tenantId },
    });

    if (!user) {
      throw new NotFoundError('User not found');
    }

    // Plan-gate (step 10, count 3) + create in one tx so a concurrent create
    // can't slip in past the count check. The enforceCountLimit helper takes
    // the tenants-row lock; the count query runs against the same manager
    // so it sees consistent state.
    const saved = await AppDataSource.transaction(async (manager) => {
      // Pre-check duplicate inside the tx (was outside; moved here so all
      // create-side guards share the same locked view of the tenant).
      const existing = await manager.findOne(Agent, { where: { userId } });
      if (existing) {
        throw new ConflictError('Agent profile already exists for this user');
      }

      await enforceCountLimit({
        manager,
        tenantId,
        capability: 'agents',
        errorCode: 'plan_limit_agents',
        countQuery: (m) => m.count(Agent, { where: { tenantId } }),
      });

      const agent = manager.create(Agent, {
        tenantId,
        userId,
        maxConcurrentChats: maxConcurrentChats || 5,
        skills: skills || [],
        languages: languages || ['en'],
      });
      return manager.save(Agent, agent);
    });

    await invalidate(`agents:${tenantId}`);

    logger.info('Agent created', { agentId: saved.id, userId });

    sendCreated(res, {
      agent: {
        id: saved.id,
        userId: saved.userId,
        status: saved.status,
        maxConcurrentChats: saved.maxConcurrentChats,
        skills: saved.skills,
        languages: saved.languages,
      },
    });
  })
);

/**
 * PATCH /agents/:id
 * Update agent details
 */
router.patch(
  '/:id',
  validate(updateAgentSchema),
  asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const authReq = req as ProvisionedRequest;
    const { id } = req.params;
    const { maxConcurrentChats, skills, languages } = req.body;

    const agent = await agentRepository.findOne({
      where: { id, tenantId: authReq.user?.tenantId },
    });

    if (!agent) {
      throw new NotFoundError('Agent not found');
    }

    if (maxConcurrentChats !== undefined) agent.maxConcurrentChats = maxConcurrentChats;
    if (skills !== undefined) agent.skills = skills;
    if (languages !== undefined) agent.languages = languages;

    await agentRepository.save(agent);

    sendSuccess(res, {
      agent: {
        id: agent.id,
        maxConcurrentChats: agent.maxConcurrentChats,
        skills: agent.skills,
        languages: agent.languages,
      },
    });
  })
);

/**
 * PATCH /agents/:id/status
 * Update agent online status
 */
router.patch(
  '/:id/status',
  validate(updateAgentStatusSchema),
  asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const authReq = req as ProvisionedRequest;
    const { id } = req.params;
    const { status } = req.body;

    if (!status || !['online', 'away', 'busy', 'offline'].includes(status)) {
      throw new BadRequestError('Valid status is required (online, away, busy, offline)');
    }

    const agent = await agentRepository.findOne({
      where: { id, tenantId: authReq.user?.tenantId },
    });

    if (!agent) {
      throw new NotFoundError('Agent not found');
    }

    agent.updateStatus(status);
    await agentRepository.save(agent);
    await invalidate(`agents:${authReq.user?.tenantId}`);

    sendSuccess(res, {
      agent: {
        id: agent.id,
        status: agent.status,
        lastStatusChangeAt: agent.lastStatusChangeAt,
      },
    });
  })
);

/**
 * GET /agents/:id/performance
 * Get agent performance metrics (stub)
 */
router.get(
  '/:id/performance',
  asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const authReq = req as ProvisionedRequest;
    const { id } = req.params;

    const agent = await agentRepository.findOne({
      where: { id, tenantId: authReq.user?.tenantId },
    });

    if (!agent) {
      throw new NotFoundError('Agent not found');
    }

    sendSuccess(res, {
      performance: {
        agentId: agent.id,
        totalChatsHandled: agent.totalChatsHandled,
        avgResponseTimeSeconds: agent.avgResponseTimeSeconds,
        satisfactionScore: agent.satisfactionScore,
        currentChatCount: agent.currentChatCount,
      },
    });
  })
);

/**
 * GET /agents/:id/shifts
 * Get agent shifts (stub)
 */
router.get(
  '/:id/shifts',
  asyncHandler(async (_req: Request, res: Response): Promise<void> => {
    sendSuccess(res, { shifts: [] });
  })
);

export default router;
