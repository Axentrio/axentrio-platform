/**
 * Handoff Routes
 * POST /handoff/request - Request human handoff
 * POST /handoff/accept - Accept handoff request (agent)
 * POST /handoff/reject - Reject handoff request (agent)
 * POST /handoff/return - Return session to bot (agent)
 * GET /handoff/pending - Get pending handoff requests (agent)
 */
import { Router, Request, Response } from 'express';
import { AppDataSource } from '../database/data-source';
import { ChatSession } from '../database/entities/ChatSession';
import { Message } from '../database/entities/Message';
import { Agent } from '../database/entities/Agent';
import { HandoffRequest } from '../database/entities/HandoffRequest';
import { logger } from '../utils/logger';
import { authenticateWidget } from '../middleware/auth.middleware';
import { requireClerkAuth, autoProvision } from '../middleware/clerk.middleware';
import { resolveTenantContext } from '../middleware/super-admin.middleware';
import { validateTenant, TenantRequest } from '../middleware/tenant.middleware';
import { rateLimit } from '../middleware/rate-limit.middleware';
import { emitToSession, emitToTenantAgents } from '../websocket/socket.handler';
import { parsePaginationParams, applyPagination } from '../utils/pagination';
import { asyncHandler, BadRequestError, NotFoundError, ForbiddenError } from '../middleware/error-handler';
import { validate } from '../middleware/validate';
import { sendSuccess } from '../utils/response';
import { requestHandoffSchema } from '../schemas';

const router = Router();
const sessionRepository = AppDataSource.getRepository(ChatSession);
const messageRepository = AppDataSource.getRepository(Message);
const agentRepository = AppDataSource.getRepository(Agent);
const handoffRepository = AppDataSource.getRepository(HandoffRequest);

/**
 * POST /handoff/request
 * Request human handoff for a session
 */
router.post(
  '/request',
  authenticateWidget,
  validateTenant,
  rateLimit(),
  validate(requestHandoffSchema),
  asyncHandler(async (req: TenantRequest, res: Response) => {
    const tenantId = req.tenant?.id;
    const { sessionId, reason } = req.body;

    if (!sessionId) {
      throw new BadRequestError('Session ID is required');
    }

    // Find session
    const session = await sessionRepository.findOne({
      where: { id: sessionId, tenantId },
    });

    if (!session) {
      throw new NotFoundError('Session not found');
    }

    if (!session.isActive() && session.status !== 'waiting') {
      throw new BadRequestError('Session is closed');
    }

    // Check if already in handoff mode
    if (session.status === 'handoff') {
      throw new BadRequestError('Session is already in handoff mode');
    }

    // Update session status to handoff
    session.requestHandoff();
    if (session.metadata) {
      (session.metadata as Record<string, unknown>).handoffReason = reason || 'User requested';
    }
    await sessionRepository.save(session);

    // Add system message
    const systemMessage = messageRepository.create({
      sessionId,
      tenantId: tenantId!,
      participantId: 'system',
      type: 'system',
      content: `Handoff requested: ${reason || 'User requested human assistance'}`,
    } as Partial<Message>);
    await messageRepository.save(systemMessage);

    // Notify agents via WebSocket
    emitToTenantAgents(tenantId!, 'handoff:requested', {
      sessionId,
      reason: reason || 'User requested',
      requestedAt: new Date().toISOString(),
    });

    // Notify session
    emitToSession(tenantId!, sessionId, 'handoff:pending', {
      sessionId,
      status: 'handoff',
      message: 'Waiting for an agent to join...',
    });

    logger.info(`Handoff requested for session ${sessionId}`, {
      tenantId,
      reason,
    });

    sendSuccess(res, {
      message: 'Handoff request submitted',
      session: {
        id: session.id,
        status: session.status,
      },
    });
  })
);

/**
 * POST /handoff/accept
 * Accept handoff request (agent only)
 */
router.post(
  '/accept',
  requireClerkAuth, autoProvision, resolveTenantContext,
  validateTenant,
  asyncHandler(async (req: TenantRequest, res: Response) => {
    const tenantId = req.tenant?.id;
    const agent = req.user;
    const { sessionId } = req.body;

    if (!sessionId) {
      throw new BadRequestError('Session ID is required');
    }

    // Find session
    const session = await sessionRepository.findOne({
      where: { id: sessionId, tenantId },
      relations: ['assignedAgent'],
    });

    if (!session) {
      throw new NotFoundError('Session not found');
    }

    if (session.status !== 'handoff') {
      throw new BadRequestError('Session is not pending handoff');
    }

    // Get agent details
    const agentDetails = await agentRepository.findOne({
      where: { id: agent!.id },
    });

    if (!agentDetails) {
      throw new NotFoundError('Agent not found');
    }

    // Update session - assign agent
    session.assignAgent(agent!.id);
    await sessionRepository.save(session);

    // Update agent status
    agentDetails.incrementChatCount();
    await agentRepository.save(agentDetails);

    // Add system message
    const systemMessage = messageRepository.create({
      sessionId,
      tenantId: tenantId!,
      participantId: agent!.id,
      type: 'system',
      content: `An agent has joined the conversation`,
    } as Partial<Message>);
    await messageRepository.save(systemMessage);

    // Notify session
    emitToSession(tenantId!, sessionId, 'handoff:accepted', {
      sessionId,
      agent: {
        id: agent!.id,
      },
      acceptedAt: new Date().toISOString(),
    });

    // Notify other agents
    emitToTenantAgents(tenantId!, 'handoff:assigned', {
      sessionId,
      agentId: agent!.id,
    });

    logger.info(`Handoff accepted for session ${sessionId}`, {
      agentId: agent!.id,
    });

    sendSuccess(res, {
      message: 'Handoff accepted',
      session: {
        id: session.id,
        status: session.status,
        assignedAgent: {
          id: agent!.id,
        },
      },
    });
  })
);

/**
 * POST /handoff/reject
 * Reject handoff request (agent only)
 */
router.post(
  '/reject',
  requireClerkAuth, autoProvision, resolveTenantContext,
  validateTenant,
  asyncHandler(async (req: TenantRequest, res: Response) => {
    const tenantId = req.tenant?.id;
    const agent = req.user;
    const { sessionId } = req.body;

    if (!sessionId) {
      throw new BadRequestError('Session ID is required');
    }

    // Just notify other agents about rejection
    emitToTenantAgents(tenantId!, 'handoff:rejected', {
      sessionId,
      rejectedBy: agent!.id,
      rejectedAt: new Date().toISOString(),
    });

    logger.info(`Handoff rejected for session ${sessionId}`, {
      agentId: agent!.id,
    });

    sendSuccess(res, { message: 'Handoff rejected' });
  })
);

/**
 * POST /handoff/return
 * Return session to bot (agent only)
 */
router.post(
  '/return',
  requireClerkAuth, autoProvision, resolveTenantContext,
  validateTenant,
  asyncHandler(async (req: TenantRequest, res: Response) => {
    const tenantId = req.tenant?.id;
    const agent = req.user;
    const { sessionId, reason } = req.body;

    if (!sessionId) {
      throw new BadRequestError('Session ID is required');
    }

    // Find session
    const session = await sessionRepository.findOne({
      where: { id: sessionId, tenantId },
    });

    if (!session) {
      throw new NotFoundError('Session not found');
    }

    if (session.status !== 'active') {
      throw new BadRequestError('Session is not actively handled by an agent');
    }

    // Verify agent is assigned to session
    if (session.assignedAgentId !== agent!.id) {
      throw new ForbiddenError('You are not assigned to this session');
    }

    // Update session - return to waiting
    session.status = 'waiting';
    session.assignedAgentId = undefined;
    await sessionRepository.save(session);

    // Add system message
    const systemMessage = messageRepository.create({
      sessionId,
      tenantId: tenantId!,
      participantId: agent!.id,
      type: 'system',
      content: `Agent has left the conversation. ${reason || ''}`,
    } as Partial<Message>);
    await messageRepository.save(systemMessage);

    // Notify session
    emitToSession(tenantId!, sessionId, 'handoff:returned', {
      sessionId,
      reason,
      returnedAt: new Date().toISOString(),
    });

    logger.info(`Session ${sessionId} returned to waiting`, {
      agentId: agent!.id,
      reason,
    });

    sendSuccess(res, {
      message: 'Session returned to waiting',
      session: {
        id: session.id,
        status: session.status,
      },
    });
  })
);

/**
 * GET /handoff/pending
 * Get pending handoff requests (agent only)
 */
router.get(
  '/pending',
  requireClerkAuth, autoProvision, resolveTenantContext,
  validateTenant,
  asyncHandler(async (req: TenantRequest, res: Response) => {
    const tenantId = req.tenant?.id;
    const params = parsePaginationParams(req.query as Record<string, unknown>);

    const qb = sessionRepository.createQueryBuilder('session')
      .where('session.tenantId = :tenantId', { tenantId })
      .andWhere('session.status = :status', { status: 'handoff' });

    if (!params.sortBy) {
      qb.orderBy('session.createdAt', 'ASC');
    }

    const result = await applyPagination(qb, params);

    const sessionsWithPreview = await Promise.all(
      result.data.map(async (session) => {
        const lastMessage = await messageRepository.findOne({
          where: { sessionId: session.id },
          order: { createdAt: 'DESC' },
        });

        return {
          id: session.id,
          status: session.status,
          metadata: session.metadata,
          createdAt: session.createdAt,
          lastMessage: lastMessage
            ? {
                content: lastMessage.content?.substring(0, 100) || '',
                type: lastMessage.type,
                createdAt: lastMessage.createdAt,
              }
            : null,
        };
      })
    );

    sendSuccess(res, { pendingRequests: sessionsWithPreview }, { pagination: result.meta });
  })
);

/**
 * POST /handoff/:id/accept
 * Accept a handoff request by ID
 */
router.post(
  '/:id/accept',
  requireClerkAuth, autoProvision, resolveTenantContext,
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params;
    const agentId = req.user?.id;

    const handoff = await handoffRepository.findOne({
      where: { id },
    });

    if (!handoff) {
      throw new NotFoundError('Handoff request not found');
    }

    if (handoff.status !== 'requested') {
      throw new BadRequestError('Handoff request is no longer pending');
    }

    handoff.accept(agentId!);
    await handoffRepository.save(handoff);

    // Also update the session
    const session = await sessionRepository.findOne({
      where: { id: handoff.sessionId },
    });
    if (session) {
      session.assignAgent(agentId!);
      await sessionRepository.save(session);
    }

    logger.info(`Handoff ${id} accepted by agent ${agentId}`);

    sendSuccess(res, {
      message: 'Handoff accepted',
      handoff: {
        id: handoff.id,
        status: handoff.status,
        assignedAgentId: handoff.assignedAgentId,
        acceptedAt: handoff.acceptedAt,
      },
    });
  })
);

/**
 * POST /handoff/:id/decline
 * Decline a handoff request by ID
 */
router.post(
  '/:id/decline',
  requireClerkAuth, autoProvision, resolveTenantContext,
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params;
    const { reason } = req.body;

    const handoff = await handoffRepository.findOne({
      where: { id },
    });

    if (!handoff) {
      throw new NotFoundError('Handoff request not found');
    }

    if (handoff.status !== 'requested') {
      throw new BadRequestError('Handoff request is no longer pending');
    }

    handoff.status = 'rejected';
    handoff.rejectionReason = reason || 'Declined by agent';
    await handoffRepository.save(handoff);

    logger.info(`Handoff ${id} declined by agent ${req.user?.id}`);

    sendSuccess(res, {
      message: 'Handoff declined',
      handoff: {
        id: handoff.id,
        status: handoff.status,
      },
    });
  })
);

/**
 * GET /handoff/queue
 * Get pending handoff requests for tenant
 */
router.get(
  '/queue',
  requireClerkAuth, autoProvision, resolveTenantContext,
  asyncHandler(async (req: Request, res: Response) => {
    const tenantId = req.user?.tenantId;

    const params = parsePaginationParams(req.query as Record<string, unknown>);

    const qb = handoffRepository.createQueryBuilder('handoff')
      .where('handoff.tenantId = :tenantId', { tenantId })
      .andWhere('handoff.status = :status', { status: 'requested' });

    if (!params.sortBy) {
      qb.orderBy('handoff.requestedAt', 'ASC');
    }

    const result = await applyPagination(qb, params);

    sendSuccess(res, {
      queue: result.data.map((r) => ({
        id: r.id,
        sessionId: r.sessionId,
        status: r.status,
        reason: r.reason,
        priority: r.priority,
        requestedAt: r.requestedAt,
        waitTimeSeconds: r.getWaitTime(),
      })),
    }, { pagination: result.meta });
  })
);

export default router;
