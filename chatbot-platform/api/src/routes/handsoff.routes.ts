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
import { authenticateWidget, AuthenticatedRequest } from '../middleware/auth.middleware';
import { requireClerkAuth, autoProvision } from '../middleware/clerk.middleware';
import { validateTenant, TenantRequest } from '../middleware/tenant.middleware';
import { rateLimit } from '../middleware/rate-limit.middleware';
import { emitToSession, emitToTenantAgents } from '../websocket/socket.handler';
import { parsePaginationParams, applyPagination } from '../utils/pagination';

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
  async (req: TenantRequest, res: Response): Promise<void> => {
    try {
      const tenantId = req.tenant?.id;
      const { sessionId, reason } = req.body;

      if (!sessionId) {
        res.status(400).json({ error: 'Session ID is required' });
        return;
      }

      // Find session
      const session = await sessionRepository.findOne({
        where: { id: sessionId, tenantId },
      });

      if (!session) {
        res.status(404).json({ error: 'Session not found' });
        return;
      }

      if (!session.isActive() && session.status !== 'waiting') {
        res.status(400).json({ error: 'Session is closed' });
        return;
      }

      // Check if already in handoff mode
      if (session.status === 'handoff') {
        res.status(400).json({ error: 'Session is already in handoff mode' });
        return;
      }

      // Update session status to handoff
      session.requestHandoff();
      if (session.metadata) {
        (session.metadata as any).handoffReason = reason || 'User requested';
      }
      await sessionRepository.save(session);

      // Add system message
      const systemMessage = messageRepository.create({
        sessionId,
        tenantId: tenantId!,
        participantId: 'system',
        type: 'system',
        content: `Handoff requested: ${reason || 'User requested human assistance'}`,
      } as any);
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

      res.json({
        success: true,
        message: 'Handoff request submitted',
        session: {
          id: session.id,
          status: session.status,
        },
      });
    } catch (error) {
      logger.error('Error requesting handoff:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

/**
 * POST /handoff/accept
 * Accept handoff request (agent only)
 */
router.post(
  '/accept',
  requireClerkAuth, autoProvision,
  validateTenant,
  async (req: TenantRequest, res: Response): Promise<void> => {
    try {
      const tenantId = req.tenant?.id;
      const agent = (req as any).user;
      const { sessionId } = req.body;

      if (!sessionId) {
        res.status(400).json({ error: 'Session ID is required' });
        return;
      }

      // Find session
      const session = await sessionRepository.findOne({
        where: { id: sessionId, tenantId },
        relations: ['assignedAgent'],
      });

      if (!session) {
        res.status(404).json({ error: 'Session not found' });
        return;
      }

      if (session.status !== 'handoff') {
        res.status(400).json({ error: 'Session is not pending handoff' });
        return;
      }

      // Get agent details
      const agentDetails = await agentRepository.findOne({
        where: { id: agent.id },
      });

      if (!agentDetails) {
        res.status(404).json({ error: 'Agent not found' });
        return;
      }

      // Update session - assign agent
      session.assignAgent(agent.id);
      await sessionRepository.save(session);

      // Update agent status
      agentDetails.incrementChatCount();
      await agentRepository.save(agentDetails);

      // Add system message
      const systemMessage = messageRepository.create({
        sessionId,
        tenantId: tenantId!,
        participantId: agent.id,
        type: 'system',
        content: `An agent has joined the conversation`,
      } as any);
      await messageRepository.save(systemMessage);

      // Notify session
      emitToSession(tenantId!, sessionId, 'handoff:accepted', {
        sessionId,
        agent: {
          id: agent.id,
        },
        acceptedAt: new Date().toISOString(),
      });

      // Notify other agents
      emitToTenantAgents(tenantId!, 'handoff:assigned', {
        sessionId,
        agentId: agent.id,
      });

      logger.info(`Handoff accepted for session ${sessionId}`, {
        agentId: agent.id,
      });

      res.json({
        success: true,
        message: 'Handoff accepted',
        session: {
          id: session.id,
          status: session.status,
          assignedAgent: {
            id: agent.id,
          },
        },
      });
    } catch (error) {
      logger.error('Error accepting handoff:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

/**
 * POST /handoff/reject
 * Reject handoff request (agent only)
 */
router.post(
  '/reject',
  requireClerkAuth, autoProvision,
  validateTenant,
  async (req: TenantRequest, res: Response): Promise<void> => {
    try {
      const tenantId = req.tenant?.id;
      const agent = (req as any).user;
      const { sessionId } = req.body;

      if (!sessionId) {
        res.status(400).json({ error: 'Session ID is required' });
        return;
      }

      // Just notify other agents about rejection
      emitToTenantAgents(tenantId!, 'handoff:rejected', {
        sessionId,
        rejectedBy: agent.id,
        rejectedAt: new Date().toISOString(),
      });

      logger.info(`Handoff rejected for session ${sessionId}`, {
        agentId: agent.id,
      });

      res.json({
        success: true,
        message: 'Handoff rejected',
      });
    } catch (error) {
      logger.error('Error rejecting handoff:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

/**
 * POST /handoff/return
 * Return session to bot (agent only)
 */
router.post(
  '/return',
  requireClerkAuth, autoProvision,
  validateTenant,
  async (req: TenantRequest, res: Response): Promise<void> => {
    try {
      const tenantId = req.tenant?.id;
      const agent = (req as any).user;
      const { sessionId, reason } = req.body;

      if (!sessionId) {
        res.status(400).json({ error: 'Session ID is required' });
        return;
      }

      // Find session
      const session = await sessionRepository.findOne({
        where: { id: sessionId, tenantId },
      });

      if (!session) {
        res.status(404).json({ error: 'Session not found' });
        return;
      }

      if (session.status !== 'active') {
        res.status(400).json({ error: 'Session is not actively handled by an agent' });
        return;
      }

      // Verify agent is assigned to session
      if (session.assignedAgentId !== agent.id) {
        res.status(403).json({ error: 'You are not assigned to this session' });
        return;
      }

      // Update session - return to waiting
      session.status = 'waiting';
      session.assignedAgentId = undefined;
      await sessionRepository.save(session);

      // Add system message
      const systemMessage = messageRepository.create({
        sessionId,
        tenantId: tenantId!,
        participantId: agent.id,
        type: 'system',
        content: `Agent has left the conversation. ${reason || ''}`,
      } as any);
      await messageRepository.save(systemMessage);

      // Notify session
      emitToSession(tenantId!, sessionId, 'handoff:returned', {
        sessionId,
        reason,
        returnedAt: new Date().toISOString(),
      });

      logger.info(`Session ${sessionId} returned to waiting`, {
        agentId: agent.id,
        reason,
      });

      res.json({
        success: true,
        message: 'Session returned to waiting',
        session: {
          id: session.id,
          status: session.status,
        },
      });
    } catch (error) {
      logger.error('Error returning session to bot:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

/**
 * GET /handoff/pending
 * Get pending handoff requests (agent only)
 */
router.get(
  '/pending',
  requireClerkAuth, autoProvision,
  validateTenant,
  async (req: TenantRequest, res: Response): Promise<void> => {
    try {
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

      res.json({
        success: true,
        pendingRequests: sessionsWithPreview,
        meta: result.meta,
      });
    } catch (error) {
      logger.error('Error fetching pending handoffs:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

/**
 * POST /handoff/:id/accept
 * Accept a handoff request by ID
 */
router.post(
  '/:id/accept',
  requireClerkAuth, autoProvision,
  async (req: Request, res: Response): Promise<void> => {
    try {
      const authReq = req as AuthenticatedRequest;
      const { id } = req.params;
      const agentId = authReq.user?.id;

      if (!agentId) {
        res.status(401).json({ error: 'Not authenticated' });
        return;
      }

      const handoff = await handoffRepository.findOne({
        where: { id },
      });

      if (!handoff) {
        res.status(404).json({ error: 'Handoff request not found' });
        return;
      }

      if (handoff.status !== 'requested') {
        res.status(400).json({ error: 'Handoff request is no longer pending' });
        return;
      }

      handoff.accept(agentId);
      await handoffRepository.save(handoff);

      // Also update the session
      const session = await sessionRepository.findOne({
        where: { id: handoff.sessionId },
      });
      if (session) {
        session.assignAgent(agentId);
        await sessionRepository.save(session);
      }

      logger.info(`Handoff ${id} accepted by agent ${agentId}`);

      res.json({
        success: true,
        message: 'Handoff accepted',
        handoff: {
          id: handoff.id,
          status: handoff.status,
          assignedAgentId: handoff.assignedAgentId,
          acceptedAt: handoff.acceptedAt,
        },
      });
    } catch (error) {
      logger.error('Error accepting handoff:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

/**
 * POST /handoff/:id/decline
 * Decline a handoff request by ID
 */
router.post(
  '/:id/decline',
  requireClerkAuth, autoProvision,
  async (req: Request, res: Response): Promise<void> => {
    try {
      const authReq = req as AuthenticatedRequest;
      const { id } = req.params;
      const { reason } = req.body;

      const handoff = await handoffRepository.findOne({
        where: { id },
      });

      if (!handoff) {
        res.status(404).json({ error: 'Handoff request not found' });
        return;
      }

      if (handoff.status !== 'requested') {
        res.status(400).json({ error: 'Handoff request is no longer pending' });
        return;
      }

      handoff.status = 'rejected';
      handoff.rejectionReason = reason || 'Declined by agent';
      await handoffRepository.save(handoff);

      logger.info(`Handoff ${id} declined by agent ${authReq.user?.id}`);

      res.json({
        success: true,
        message: 'Handoff declined',
        handoff: {
          id: handoff.id,
          status: handoff.status,
        },
      });
    } catch (error) {
      logger.error('Error declining handoff:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

/**
 * GET /handoff/queue
 * Get pending handoff requests for tenant
 */
router.get(
  '/queue',
  requireClerkAuth, autoProvision,
  async (req: Request, res: Response): Promise<void> => {
    try {
      const authReq = req as AuthenticatedRequest;
      const tenantId = authReq.user?.tenantId;

      if (!tenantId) {
        res.status(401).json({ error: 'Not authenticated' });
        return;
      }

      const params = parsePaginationParams(req.query as Record<string, unknown>);

      const qb = handoffRepository.createQueryBuilder('handoff')
        .where('handoff.tenantId = :tenantId', { tenantId })
        .andWhere('handoff.status = :status', { status: 'requested' });

      if (!params.sortBy) {
        qb.orderBy('handoff.requestedAt', 'ASC');
      }

      const result = await applyPagination(qb, params);

      res.json({
        success: true,
        queue: result.data.map((r) => ({
          id: r.id,
          sessionId: r.sessionId,
          status: r.status,
          reason: r.reason,
          priority: r.priority,
          requestedAt: r.requestedAt,
          waitTimeSeconds: r.getWaitTime(),
        })),
        meta: result.meta,
      });
    } catch (error) {
      logger.error('Error fetching handoff queue:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

export default router;
