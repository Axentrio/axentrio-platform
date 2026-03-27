/**
 * Chat Routes
 * GET /chat/:sessionId/history - Get message history
 * POST /chat/:sessionId/message - Send message via HTTP
 * GET /chat/:sessionId/status - Get session status
 * POST /chat/:sessionId/close - Close session
 */
import { Router, Request, Response } from 'express';
import { IsNull, DeepPartial } from 'typeorm';
import { AppDataSource } from '../database/data-source';
import { ChatSession } from '../database/entities/ChatSession';
import { Message, MessageStatus } from '../database/entities/Message';
import { Agent } from '../database/entities/Agent';
import { Participant } from '../database/entities/Participant';
import { logger } from '../utils/logger';
import { authenticateWidget } from '../middleware/auth.middleware';
import { requireClerkAuth, autoProvision } from '../middleware/clerk.middleware';
import { resolveTenantContext } from '../middleware/super-admin.middleware';
import { validateTenant, TenantRequest } from '../middleware/tenant.middleware';
import { rateLimit } from '../middleware/rate-limit.middleware';
import { emitToSession } from '../websocket/socket.handler';
import { forwardMessageToN8n } from '../services/message-forwarding.service';
import { encrypt, decrypt, DecryptionError } from '../utils/encryption';
import { parsePaginationParams, applyPagination } from '../utils/pagination';
import { asyncHandler, BadRequestError, NotFoundError } from '../middleware/error-handler';
import { validate } from '../middleware/validate';
import { sendSuccess, sendPaginated, sendCreated } from '../utils/response';
import { sendMessageSchema, chatListQuerySchema } from '../schemas';

/** Safely serialise a message for API responses, decrypting content if needed. */
function serialiseMessage(m: Message) {
  let content: string;
  let decryptionFailed = false;

  if (m.contentEncrypted && m.content) {
    try {
      content = decrypt(m.content, m.id);
    } catch (error) {
      if (error instanceof DecryptionError) {
        content = '';
        decryptionFailed = true;
      } else {
        throw error;
      }
    }
  } else {
    content = m.content;
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
  asyncHandler(async (req: TenantRequest, res: Response) => {
    const { sessionId } = req.params;
    const tenantId = req.tenant?.id;
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 100);
    const offset = parseInt(req.query.offset as string) || 0;

    // Verify session belongs to tenant
    const session = await sessionRepository.findOne({
      where: { id: sessionId, tenantId },
    });

    if (!session) {
      throw new NotFoundError('Session not found');
    }

    // Get messages with pagination
    const [messages, total] = await messageRepository.findAndCount({
      where: { sessionId },
      order: { createdAt: 'DESC' },
      take: limit,
      skip: offset,
    });

    sendSuccess(res, {
      sessionId,
      messages: messages.reverse().map(serialiseMessage),
      pagination: {
        total,
        limit,
        offset,
        hasMore: offset + limit < total,
      },
    });
  })
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
  validate(sendMessageSchema),
  asyncHandler(async (req: TenantRequest, res: Response) => {
    const { sessionId } = req.params;
    const tenantId = req.tenant?.id;
    const user = req.user;
    const { content, type = 'text', metadata } = req.body as SendMessageRequest;

    // Verify session exists and belongs to tenant
    const session = await sessionRepository.findOne({
      where: { id: sessionId, tenantId },
    });

    if (!session) {
      throw new NotFoundError('Session not found');
    }

    if (session.isClosed()) {
      throw new BadRequestError('Session is closed');
    }

    // Encrypt message content before saving
    const plainContent = content.trim();
    const messageContent = encrypt(plainContent);

    // Save message + update session in a single transaction
    const message = messageRepository.create({
      sessionId,
      tenantId: tenantId!,
      participantId: user?.id || 'anonymous',
      type,
      content: messageContent,
      contentEncrypted: true,
      metadata: metadata || undefined,
    } as DeepPartial<Message>);

    const savedMessage = await AppDataSource.transaction(async (manager) => {
      const msg = await manager.save(message);
      session.updateActivity();
      await manager.save(session);
      return msg;
    });

    // Emit and forward AFTER transaction commits — use original plain text
    const messageData = {
      id: savedMessage.id,
      type: savedMessage.type,
      content: plainContent,
      status: savedMessage.status,
      createdAt: savedMessage.createdAt,
      timestamp: new Date().toISOString(),
    };

    emitToSession(tenantId!, sessionId, 'message:receive', messageData);

    forwardMessageToN8n(session, savedMessage).catch((err) => {
      logger.error('Error in n8n message forwarding:', err);
    });

    logger.debug(`Message sent via HTTP for session ${sessionId}`);

    sendCreated(res, { message: messageData });
  })
);

/**
 * GET /chat/:sessionId/status
 * Get session status
 */
router.get(
  '/:sessionId/status',
  authenticateWidget,
  validateTenant,
  asyncHandler(async (req: TenantRequest, res: Response) => {
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
      throw new NotFoundError('Session not found');
    }

    const unreadCount = parseInt(result.raw[0]?.unreadCount || '0');

    sendSuccess(res, {
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
  })
);

/**
 * POST /chat/:sessionId/close
 * Close a chat session
 */
router.post(
  '/:sessionId/close',
  authenticateWidget,
  validateTenant,
  asyncHandler(async (req: TenantRequest, res: Response) => {
    const { sessionId } = req.params;
    const tenantId = req.tenant?.id;
    const { reason } = req.body;

    const session = await sessionRepository.findOne({
      where: { id: sessionId, tenantId },
    });

    if (!session) {
      throw new NotFoundError('Session not found');
    }

    if (!session.isActive()) {
      throw new BadRequestError('Session is already closed');
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
    } as DeepPartial<Message>);
    await messageRepository.save(systemMessage);

    // Notify via WebSocket
    emitToSession(tenantId!, sessionId, 'session:closed', {
      sessionId,
      reason,
      endedAt: session.endedAt,
    });

    logger.info(`Session ${sessionId} closed`, { reason });

    sendSuccess(res, {
      message: 'Session closed successfully',
      session: {
        id: session.id,
        status: session.status,
        endedAt: session.endedAt,
      },
    });
  })
);

/**
 * GET /chat/sessions
 * Get active sessions (agent only)
 */
router.get(
  '/sessions',
  requireClerkAuth, autoProvision, resolveTenantContext,
  validateTenant,
  validate(chatListQuerySchema, 'query'),
  asyncHandler(async (req: TenantRequest, res: Response) => {
    const tenantId = req.tenant?.id;
    const status = req.query.status as string;
    const params = parsePaginationParams(req.query as Record<string, unknown>);

    const qb = sessionRepository
      .createQueryBuilder('session')
      .leftJoinAndSelect('session.assignedAgent', 'agent')
      .where('session.tenantId = :tenantId', { tenantId });

    if (status && ['active', 'closed', 'waiting', 'handoff'].includes(status)) {
      qb.andWhere('session.status = :status', { status });
    }

    if (!params.sortBy) {
      qb.orderBy('session.lastActivityAt', 'DESC');
    }

    const result = await applyPagination(qb, params);

    // Fetch last message for each session in one query
    const sessionIds = result.data.map(s => s.id);
    const lastMessages: Record<string, { content: string; senderType: string }> = {};
    if (sessionIds.length > 0) {
      const msgs = await messageRepository
        .createQueryBuilder('m')
        .leftJoin(Participant, 'p', 'p.id = m.participant_id')
        .select(['m.session_id AS session_id', 'm.content AS content', 'm.content_encrypted AS encrypted', 'm.id AS id', 'p.type AS sender_type'])
        .where('m.session_id IN (:...ids)', { ids: sessionIds })
        .distinctOn(['m.session_id'])
        .orderBy('m.session_id')
        .addOrderBy('m.created_at', 'DESC')
        .getRawMany();

      for (const row of msgs) {
        let content = row.content || '';
        if (row.encrypted && content) {
          try { content = decrypt(content, row.id); } catch { content = '[encrypted]'; }
        }
        lastMessages[row.session_id] = {
          content: content.substring(0, 80),
          senderType: row.sender_type || 'user',
        };
      }
    }

    sendPaginated(
      res,
      result.data.map((s) => ({
        id: s.id,
        sessionId: s.id,
        status: s.status,
        userName: `Visitor ${s.visitorId?.substring(0, 8) || 'Anonymous'}`,
        assignedAgent: s.assignedAgent ? { id: s.assignedAgent.id } : null,
        assignedAgentName: s.assignedAgent?.userId ?? null,
        messageCount: s.messageCount,
        lastMessage: lastMessages[s.id]?.content || null,
        lastMessageSender: lastMessages[s.id]?.senderType || null,
        lastMessageAt: s.lastActivityAt,
        lastActivityAt: s.lastActivityAt,
        source: s.source,
        createdAt: s.createdAt,
      })),
      result.meta
    );
  })
);

/**
 * GET /chat/:id
 * Get a single chat session detail (agent endpoint)
 */
router.get(
  '/:id',
  requireClerkAuth, autoProvision, resolveTenantContext,
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params;

    const session = await sessionRepository.findOne({
      where: { id, tenantId: req.user?.tenantId },
      relations: ['assignedAgent'],
    });

    if (!session) {
      throw new NotFoundError('Session not found');
    }

    // Get recent messages with participant info for sender identity
    const messages = await messageRepository.find({
      where: { sessionId: id },
      relations: ['participant'],
      order: { createdAt: 'DESC' },
      take: 50,
    });

    sendSuccess(res, {
      id: session.id,
      sessionId: session.id,
      tenantId: session.tenantId,
      status: session.status,
      visitorId: session.visitorId,
      assignedAgentId: session.assignedAgentId,
      assignedAgentName: session.assignedAgent?.userId ?? null,
      messages: messages.reverse().map((m) => ({
        ...serialiseMessage(m),
        sender: m.participant?.type ?? 'user',
        senderName: m.participant?.name ?? 'Unknown',
        participantId: m.participantId,
      })),
      metadata: {
        source: session.source,
      },
      createdAt: session.createdAt,
      updatedAt: session.lastActivityAt,
      lastMessageAt: session.lastActivityAt,
      closedAt: session.endedAt,
    });
  })
);

/**
 * POST /chat/:id/transfer
 * Transfer session to another agent
 */
router.post(
  '/:id/transfer',
  requireClerkAuth, autoProvision, resolveTenantContext,
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params;
    const { agentId: targetAgentId } = req.body;

    if (!targetAgentId) {
      throw new BadRequestError('Target agent ID is required');
    }

    const session = await sessionRepository.findOne({
      where: { id, tenantId: req.user?.tenantId },
    });

    if (!session) {
      throw new NotFoundError('Session not found');
    }

    // Verify target agent exists
    const targetAgent = await agentRepository.findOne({
      where: { id: targetAgentId },
    });

    if (!targetAgent) {
      throw new NotFoundError('Target agent not found');
    }

    session.assignedAgentId = targetAgentId;
    session.status = 'active';
    await sessionRepository.save(session);

    logger.info(`Session ${id} transferred to agent ${targetAgentId}`);

    sendSuccess(res, {
      message: 'Session transferred',
      session: {
        id: session.id,
        status: session.status,
        assignedAgentId: targetAgentId,
      },
    });
  })
);

/**
 * POST /chat/:id/close
 * Close a chat session (agent endpoint)
 */
router.post(
  '/:id/close',
  requireClerkAuth, autoProvision, resolveTenantContext,
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params;

    const session = await sessionRepository.findOne({
      where: { id, tenantId: req.user?.tenantId },
    });

    if (!session) {
      throw new NotFoundError('Session not found');
    }

    session.status = 'closed';
    session.endedAt = new Date();
    await sessionRepository.save(session);

    logger.info(`Session ${id} closed by agent`);

    sendSuccess(res, {
      message: 'Session closed',
      session: {
        id: session.id,
        status: session.status,
        endedAt: session.endedAt,
      },
    });
  })
);

/**
 * GET /chat/:id/history
 * Get message history with full pagination (agent endpoint)
 */
router.get(
  '/:id/history',
  requireClerkAuth, autoProvision, resolveTenantContext,
  validate(chatListQuerySchema, 'query'),
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params;
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 100);
    const offset = parseInt(req.query.offset as string) || 0;

    const session = await sessionRepository.findOne({
      where: { id, tenantId: req.user?.tenantId },
    });

    if (!session) {
      throw new NotFoundError('Session not found');
    }

    const [messages, total] = await messageRepository.findAndCount({
      where: { sessionId: id },
      order: { createdAt: 'DESC' },
      take: limit,
      skip: offset,
    });

    sendSuccess(res, {
      sessionId: id,
      messages: messages.reverse().map(serialiseMessage),
      pagination: {
        total,
        limit,
        offset,
        hasMore: offset + limit < total,
      },
    });
  })
);

/**
 * POST /chat/:id/read
 * Mark messages as read for a session
 */
router.post(
  '/:id/read',
  requireClerkAuth, autoProvision, resolveTenantContext,
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params;

    const session = await sessionRepository.findOne({
      where: { id, tenantId: req.user?.tenantId },
    });

    if (!session) {
      throw new NotFoundError('Session not found');
    }

    // Mark all unread messages in the session as read
    await messageRepository.update(
      { sessionId: id, readAt: IsNull() },
      { readAt: new Date(), status: 'read' as MessageStatus }
    );

    logger.info(`Messages marked as read for session ${id}`);

    sendSuccess(res, { message: 'Messages marked as read' });
  })
);

router.delete(
  '/:sessionId/participants/:participantId',
  requireClerkAuth, autoProvision, resolveTenantContext,
  asyncHandler(async (req: Request, res: Response) => {
    const { sessionId, participantId } = req.params;
    const tenantId = req.user?.tenantId;
    const participantRepo = AppDataSource.getRepository(Participant);

    const session = await sessionRepository.findOne({
      where: { id: sessionId, tenantId },
    });

    if (!session) {
      throw new NotFoundError('Session not found');
    }

    const participant = await participantRepo.findOne({
      where: { id: participantId, sessionId, isDeleted: false },
    });

    if (!participant) {
      throw new NotFoundError('Participant not found');
    }

    participant.softDelete();
    await participantRepo.save(participant);

    sendSuccess(res, { message: 'Participant deleted' });
  })
);

export default router;
