/**
 * Chat Routes
 * GET /chat/:sessionId/history - Get message history
 * POST /chat/:sessionId/message - Send message via HTTP
 * GET /chat/:sessionId/status - Get session status
 * POST /chat/:sessionId/close - Close session
 */
import { Router, Request, Response } from 'express';
import { IsNull } from 'typeorm';
import { AppDataSource } from '../database/data-source';
import { ChatSession } from '../database/entities/ChatSession';
import { Message } from '../database/entities/Message';
import { Agent } from '../database/entities/Agent';
import { logger } from '../utils/logger';
import { authenticateWidget, AuthenticatedRequest } from '../middleware/auth.middleware';
import { requireClerkAuth, autoProvision } from '../middleware/clerk.middleware';
import { validateTenant, TenantRequest } from '../middleware/tenant.middleware';
import { rateLimit } from '../middleware/rate-limit.middleware';
import { emitToSession } from '../websocket/socket.handler';
import { forwardMessageToN8n } from '../services/message-forwarding.service';
import { DecryptionError } from '../utils/encryption';

/** Safely serialise a message for API responses, handling decryption failures. */
function serialiseMessage(m: Message) {
  let content: string;
  let decryptionFailed = false;
  try {
    content = m.content;
  } catch (error) {
    if (error instanceof DecryptionError) {
      content = '';
      decryptionFailed = true;
    } else {
      throw error;
    }
  }
  return {
    id: m.id,
    type: m.type,
    content,
    status: m.status,
    createdAt: m.createdAt,
    metadata: m.metadata,
    ...(decryptionFailed ? { decryptionFailed: true } : {}),
  };
}

const router = Router();
const sessionRepository = AppDataSource.getRepository(ChatSession);
const messageRepository = AppDataSource.getRepository(Message);
const agentRepository = AppDataSource.getRepository(Agent);

// Message request body
interface SendMessageRequest {
  content: string;
  type?: 'text' | 'image' | 'file';
  metadata?: Record<string, unknown>;
}

/**
 * GET /chat/:sessionId/history
 * Get message history for a session
 */
router.get(
  '/:sessionId/history',
  authenticateWidget,
  validateTenant,
  async (req: TenantRequest, res: Response): Promise<void> => {
    try {
      const { sessionId } = req.params;
      const tenantId = req.tenant?.id;
      const limit = Math.min(parseInt(req.query.limit as string) || 50, 100);
      const offset = parseInt(req.query.offset as string) || 0;

      // Verify session belongs to tenant
      const session = await sessionRepository.findOne({
        where: { id: sessionId, tenantId },
      });

      if (!session) {
        res.status(404).json({ error: 'Session not found' });
        return;
      }

      // Get messages with pagination
      const [messages, total] = await messageRepository.findAndCount({
        where: { sessionId },
        order: { createdAt: 'DESC' },
        take: limit,
        skip: offset,
      });

      res.json({
        success: true,
        sessionId,
        messages: messages.reverse().map(serialiseMessage),
        pagination: {
          total,
          limit,
          offset,
          hasMore: offset + limit < total,
        },
      });
    } catch (error) {
      logger.error('Error fetching message history:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

/**
 * POST /chat/:sessionId/message
 * Send message via HTTP (alternative to WebSocket)
 */
router.post(
  '/:sessionId/message',
  authenticateWidget,
  validateTenant,
  rateLimit(),
  async (req: TenantRequest, res: Response): Promise<void> => {
    try {
      const { sessionId } = req.params;
      const tenantId = req.tenant?.id;
      const user = (req as any).user;
      const { content, type = 'text', metadata } = req.body as SendMessageRequest;

      if (!content || content.trim().length === 0) {
        res.status(400).json({ error: 'Message content is required' });
        return;
      }

      // Verify session exists and belongs to tenant
      const session = await sessionRepository.findOne({
        where: { id: sessionId, tenantId },
      });

      if (!session) {
        res.status(404).json({ error: 'Session not found' });
        return;
      }

      if (session.isClosed()) {
        res.status(400).json({ error: 'Session is closed' });
        return;
      }

      // Save message + update session in a single transaction
      const message = messageRepository.create({
        sessionId,
        tenantId: tenantId!,
        participantId: user?.id || 'anonymous',
        type,
        content: content.trim(),
        metadata: metadata || undefined,
      } as any);

      const savedMessage = await AppDataSource.transaction(async (manager) => {
        const msg = await manager.save(message) as unknown as Message;
        session.updateActivity();
        await manager.save(session);
        return msg;
      });

      // Emit and forward AFTER transaction commits
      const messageData = {
        id: savedMessage.id,
        type: savedMessage.type,
        content: savedMessage.content,
        status: savedMessage.status,
        createdAt: savedMessage.createdAt,
        timestamp: new Date().toISOString(),
      };

      emitToSession(tenantId!, sessionId, 'message:receive', messageData);

      forwardMessageToN8n(session, savedMessage).catch((err) => {
        logger.error('Error in n8n message forwarding:', err);
      });

      logger.debug(`Message sent via HTTP for session ${sessionId}`);

      res.status(201).json({
        success: true,
        message: messageData,
      });
    } catch (error) {
      logger.error('Error sending message:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

/**
 * GET /chat/:sessionId/status
 * Get session status
 */
router.get(
  '/:sessionId/status',
  authenticateWidget,
  validateTenant,
  async (req: TenantRequest, res: Response): Promise<void> => {
    try {
      const { sessionId } = req.params;
      const tenantId = req.tenant?.id;

      // Single query: session + unread count via subquery
      const result = await sessionRepository
        .createQueryBuilder('s')
        .leftJoinAndSelect('s.assignedAgent', 'agent')
        .addSelect((qb) =>
          qb.select('COUNT(*)')
            .from(Message, 'm')
            .where('m.session_id = s.id')
            .andWhere("m.status = 'sent'"),
          'unreadCount'
        )
        .where('s.id = :sessionId', { sessionId })
        .andWhere('s.tenant_id = :tenantId', { tenantId })
        .getRawAndEntities();

      const session = result.entities[0];
      if (!session) {
        res.status(404).json({ error: 'Session not found' });
        return;
      }

      const unreadCount = parseInt(result.raw[0]?.unreadCount || '0');

      res.json({
        success: true,
        session: {
          id: session.id,
          status: session.status,
          assignedAgent: session.assignedAgent
            ? { id: session.assignedAgent.id }
            : null,
          lastActivityAt: session.lastActivityAt,
          createdAt: session.createdAt,
        },
        unreadCount,
      });
    } catch (error) {
      logger.error('Error fetching session status:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

/**
 * POST /chat/:sessionId/close
 * Close a chat session
 */
router.post(
  '/:sessionId/close',
  authenticateWidget,
  validateTenant,
  async (req: TenantRequest, res: Response): Promise<void> => {
    try {
      const { sessionId } = req.params;
      const tenantId = req.tenant?.id;
      const { reason } = req.body;

      const session = await sessionRepository.findOne({
        where: { id: sessionId, tenantId },
      });

      if (!session) {
        res.status(404).json({ error: 'Session not found' });
        return;
      }

      if (!session.isActive()) {
        res.status(400).json({ error: 'Session is already closed' });
        return;
      }

      // Close session
      session.close();
      await sessionRepository.save(session);

      // Add system message
      const systemMessage = messageRepository.create({
        sessionId,
        tenantId: tenantId!,
        participantId: 'system',
        type: 'system',
        content: `Session closed: ${reason || 'User closed the chat'}`,
      } as any);
      await messageRepository.save(systemMessage);

      // Notify via WebSocket
      emitToSession(tenantId!, sessionId, 'session:closed', {
        sessionId,
        reason,
        endedAt: session.endedAt,
      });

      logger.info(`Session ${sessionId} closed`, { reason });

      res.json({
        success: true,
        message: 'Session closed successfully',
        session: {
          id: session.id,
          status: session.status,
          endedAt: session.endedAt,
        },
      });
    } catch (error) {
      logger.error('Error closing session:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

/**
 * GET /chat/sessions
 * Get active sessions (agent only)
 */
router.get(
  '/sessions',
  requireClerkAuth, autoProvision,
  validateTenant,
  async (req: TenantRequest, res: Response): Promise<void> => {
    try {
      const tenantId = req.tenant?.id;
      const status = req.query.status as string;
      const limit = Math.min(parseInt(req.query.limit as string) || 20, 50);
      const offset = parseInt(req.query.offset as string) || 0;

      const where: any = { tenantId };
      if (status && ['active', 'closed', 'waiting', 'handoff'].includes(status)) {
        where.status = status;
      }

      const [sessions, total] = await sessionRepository.findAndCount({
        where,
        relations: ['assignedAgent'],
        order: { lastActivityAt: 'DESC' },
        take: limit,
        skip: offset,
      });

      res.json({
        success: true,
        sessions: sessions.map((s) => ({
          id: s.id,
          status: s.status,
          assignedAgent: s.assignedAgent
            ? {
                id: s.assignedAgent.id,
              }
            : null,
          lastActivityAt: s.lastActivityAt,
          createdAt: s.createdAt,
        })),
        pagination: {
          total,
          limit,
          offset,
          hasMore: offset + limit < total,
        },
      });
    } catch (error) {
      logger.error('Error fetching sessions:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

/**
 * POST /chat/:id/transfer
 * Transfer session to another agent
 */
router.post(
  '/:id/transfer',
  requireClerkAuth, autoProvision,
  async (req: Request, res: Response): Promise<void> => {
    try {
      const authReq = req as AuthenticatedRequest;
      const { id } = req.params;
      const { agentId: targetAgentId } = req.body;

      if (!targetAgentId) {
        res.status(400).json({ error: 'Target agent ID is required' });
        return;
      }

      const session = await sessionRepository.findOne({
        where: { id, tenantId: authReq.user?.tenantId },
      });

      if (!session) {
        res.status(404).json({ error: 'Session not found' });
        return;
      }

      // Verify target agent exists
      const targetAgent = await agentRepository.findOne({
        where: { id: targetAgentId },
      });

      if (!targetAgent) {
        res.status(404).json({ error: 'Target agent not found' });
        return;
      }

      session.assignedAgentId = targetAgentId;
      session.status = 'active';
      await sessionRepository.save(session);

      logger.info(`Session ${id} transferred to agent ${targetAgentId}`);

      res.json({
        success: true,
        message: 'Session transferred',
        session: {
          id: session.id,
          status: session.status,
          assignedAgentId: targetAgentId,
        },
      });
    } catch (error) {
      logger.error('Error transferring session:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

/**
 * POST /chat/:id/close
 * Close a chat session (agent endpoint)
 */
router.post(
  '/:id/close',
  requireClerkAuth, autoProvision,
  async (req: Request, res: Response): Promise<void> => {
    try {
      const authReq = req as AuthenticatedRequest;
      const { id } = req.params;

      const session = await sessionRepository.findOne({
        where: { id, tenantId: authReq.user?.tenantId },
      });

      if (!session) {
        res.status(404).json({ error: 'Session not found' });
        return;
      }

      session.status = 'closed';
      session.endedAt = new Date();
      await sessionRepository.save(session);

      logger.info(`Session ${id} closed by agent`);

      res.json({
        success: true,
        message: 'Session closed',
        session: {
          id: session.id,
          status: session.status,
          endedAt: session.endedAt,
        },
      });
    } catch (error) {
      logger.error('Error closing session:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

/**
 * GET /chat/:id/history
 * Get message history with full pagination (agent endpoint)
 */
router.get(
  '/:id/history',
  requireClerkAuth, autoProvision,
  async (req: Request, res: Response): Promise<void> => {
    try {
      const authReq = req as AuthenticatedRequest;
      const { id } = req.params;
      const limit = Math.min(parseInt(req.query.limit as string) || 50, 100);
      const offset = parseInt(req.query.offset as string) || 0;

      const session = await sessionRepository.findOne({
        where: { id, tenantId: authReq.user?.tenantId },
      });

      if (!session) {
        res.status(404).json({ error: 'Session not found' });
        return;
      }

      const [messages, total] = await messageRepository.findAndCount({
        where: { sessionId: id },
        order: { createdAt: 'DESC' },
        take: limit,
        skip: offset,
      });

      res.json({
        success: true,
        sessionId: id,
        messages: messages.reverse().map((m) => ({
          id: m.id,
          type: m.type,
          content: m.content,
          status: m.status,
          createdAt: m.createdAt,
          metadata: m.metadata,
        })),
        pagination: {
          total,
          limit,
          offset,
          hasMore: offset + limit < total,
        },
      });
    } catch (error) {
      logger.error('Error fetching message history:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

/**
 * POST /chat/:id/read
 * Mark messages as read for a session
 */
router.post(
  '/:id/read',
  requireClerkAuth, autoProvision,
  async (req: Request, res: Response): Promise<void> => {
    try {
      const authReq = req as AuthenticatedRequest;
      const { id } = req.params;

      const session = await sessionRepository.findOne({
        where: { id, tenantId: authReq.user?.tenantId },
      });

      if (!session) {
        res.status(404).json({ error: 'Session not found' });
        return;
      }

      // Mark all unread messages in the session as read
      await messageRepository.update(
        { sessionId: id, readAt: IsNull() },
        { readAt: new Date(), status: 'read' as any }
      );

      logger.info(`Messages marked as read for session ${id}`);

      res.json({
        success: true,
        message: 'Messages marked as read',
      });
    } catch (error) {
      logger.error('Error marking messages as read:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

export default router;
