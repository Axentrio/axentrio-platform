/**
 * Widget Routes
 * Public endpoints for chat widget integration
 */

import { Router, Request, Response } from 'express';
import { AppDataSource } from '../database/data-source';
import { ChatSession } from '../database/entities/ChatSession';
import { Participant } from '../database/entities/Participant';
import { Message } from '../database/entities/Message';
import { Tenant } from '../database/entities/Tenant';
import { KnowledgeBase } from '../database/entities/KnowledgeBase';
import { authenticateWidget, asyncHandler, ValidationError, NotFoundError } from '../middleware';
import { widgetRateLimiter } from '../middleware/rate-limit';
import { emitToSession } from '../websocket/socket.handler';
import { generateWidgetToken } from '../middleware/auth.middleware';
import { logger } from '../utils/logger';
import { sendSuccess, sendCreated } from '../utils/response';

// Simple in-memory rate limiter for unauthenticated widget endpoints
// (Redis-based widgetRateLimiter caused crashes when Redis is unavailable)
const ipHits = new Map<string, { count: number; resetAt: number }>();
function simpleRateLimit(maxRequests: number, windowMs: number) {
  return (req: Request, res: Response, next: Function) => {
    const ip = req.ip || 'unknown';
    const now = Date.now();
    const entry = ipHits.get(ip);
    if (!entry || now > entry.resetAt) {
      ipHits.set(ip, { count: 1, resetAt: now + windowMs });
      return next();
    }
    if (entry.count >= maxRequests) {
      res.status(429).json({ error: 'Too many requests, please try again later' });
      return;
    }
    entry.count++;
    next();
  };
}
const widgetInitRateLimit = simpleRateLimit(30, 60000); // 30 per minute

// Inline API key validation (looks up tenant by apiKey in DB)
interface ApiKeyValidationResult {
  valid: boolean;
  tenant?: Tenant;
  error?: string;
}

async function validateApiKey(apiKey: string): Promise<ApiKeyValidationResult> {
  if (!apiKey) {
    return { valid: false, error: 'API key is required' };
  }
  try {
    const tenantRepository = AppDataSource.getRepository(Tenant);
    const tenant = await tenantRepository.findOne({ where: { apiKey } });
    if (!tenant) {
      return { valid: false, error: 'Invalid API key' };
    }
    if (tenant.status === 'suspended' || tenant.status === 'cancelled') {
      return { valid: false, error: `Tenant account is ${tenant.status}` };
    }
    return { valid: true, tenant };
  } catch (error) {
    return { valid: false, error: 'Internal error during validation' };
  }
}

const router = Router();

/**
 * Get widget configuration
 * GET /api/v1/widget/config
 */
router.get(
  '/config',
  widgetInitRateLimit,
  asyncHandler(async (req: Request, res: Response) => {
    const apiKey = req.query.apiKey as string;

    if (!apiKey) {
      throw new ValidationError('API key is required');
    }

    const result = await validateApiKey(apiKey);

    if (!result.valid || !result.tenant) {
      throw new ValidationError(result.error || 'Invalid API key');
    }

    const tenant = result.tenant;

    sendSuccess(res, {
      tenantId: tenant.id,
      name: tenant.name,
      theme: tenant.settings?.theme || {
        primaryColor: '#007bff',
        backgroundColor: '#ffffff',
        textColor: '#333333',
      },
      features: {
        fileUploadEnabled: tenant.settings?.features?.fileUploadEnabled ?? false,
        handoffEnabled: tenant.settings?.features?.handoffEnabled ?? true,
        aiEnabled: tenant.settings?.ai?.enabled ?? false,
      },
      businessHours: tenant.settings?.businessHours || {
        enabled: false,
        timezone: 'UTC',
      },
    });
  })
);

/**
 * Initialize widget session
 * POST /api/v1/widget/init
 */
router.post(
  '/init',
  widgetInitRateLimit,
  asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const { apiKey, visitorId, metadata } = req.body;

    if (!apiKey || !visitorId) {
      throw new ValidationError('API key and visitor ID are required');
    }

    const result = await validateApiKey(apiKey);

    if (!result.valid || !result.tenant) {
      throw new ValidationError(result.error || 'Invalid API key');
    }

    const tenant = result.tenant;

    // Check if visitor already has an active session
    const sessionRepository = AppDataSource.getRepository(ChatSession);
    const existingSession = await sessionRepository.findOne({
      where: {
        tenantId: tenant.id,
        visitorId,
        status: 'active',
      },
      order: { createdAt: 'DESC' },
    });

    if (existingSession) {
      const token = generateWidgetToken(existingSession.id, tenant.id, visitorId);

      sendSuccess(res, {
        session: {
          id: existingSession.id,
          status: existingSession.status,
          startedAt: existingSession.startedAt,
        },
        token,
        isNew: false,
      });
      return;
    }

    // Determine initial status based on AI settings
    const aiEnabled = tenant.settings?.ai?.enabled;
    let kb = null;
    if (aiEnabled) {
      try {
        kb = await AppDataSource.getRepository(KnowledgeBase).findOne({ where: { tenantId: tenant.id, status: 'active' } });
      } catch {
        // knowledge_bases table may not exist yet — fall back to waiting
        logger.warn('KnowledgeBase query failed, defaulting to waiting status');
      }
    }
    const initialStatus = (aiEnabled && kb) ? 'bot' : 'waiting';

    // Create new session
    const session = sessionRepository.create({
      tenantId: tenant.id,
      visitorId,
      source: 'widget',
      metadata: {
        ...metadata,
        ipAddress: req.ip,
        userAgent: req.get('user-agent'),
        pageUrl: metadata?.pageUrl,
        referrer: metadata?.referrer,
      },
      status: initialStatus,
      startedAt: new Date(),
      lastActivityAt: new Date(),
    });

    await sessionRepository.save(session);

    // Create participant
    const participantRepository = AppDataSource.getRepository(Participant);
    const participant = participantRepository.create({
      sessionId: session.id,
      type: 'user',
      name: metadata?.name || 'Visitor',
      isAnonymous: true,
      joinedAt: new Date(),
      metadata: {
        ipAddress: req.ip,
        userAgent: req.get('user-agent'),
      },
    });

    await participantRepository.save(participant);

    // Send bot greeting if session starts in bot mode
    if (initialStatus === 'bot') {
      const greetingMessage = tenant.settings?.ai?.guardrails?.greetingMessage;
      if (greetingMessage) {
        const messageRepository = AppDataSource.getRepository(Message);
        const botParticipant = participantRepository.create({
          sessionId: session.id,
          type: 'bot',
          name: tenant.settings?.ai?.brandVoice?.name || 'AI Assistant',
          isAnonymous: false,
          joinedAt: new Date(),
        });
        await participantRepository.save(botParticipant);

        const greeting = messageRepository.create({
          sessionId: session.id,
          tenantId: tenant.id,
          participantId: botParticipant.id,
          type: 'text' as Message['type'],
          content: greetingMessage,
          status: 'sent' as Message['status'],
          sentAt: new Date(),
        });
        await messageRepository.save(greeting);
      }
    }

    // Generate token
    const token = generateWidgetToken(session.id, tenant.id, visitorId);

    logger.info('Widget session initialized', {
      sessionId: session.id,
      tenantId: tenant.id,
      visitorId,
    });

    sendSuccess(res, {
      session: {
        id: session.id,
        status: session.status,
        startedAt: session.startedAt,
      },
      token,
      isNew: true,
    });
  })
);

/**
 * Get session history
 * GET /api/v1/widget/history
 */
router.get(
  '/history',
  authenticateWidget,
  asyncHandler(async (req: Request, res: Response) => {
    const sessionId = req.widget!.sessionId;
    const tenantId = req.widget!.tenantId;

    if (!sessionId) {
      throw new ValidationError('Session ID is required');
    }

    const messageRepository = AppDataSource.getRepository(Message);

    const messages = await messageRepository.find({
      where: { sessionId, tenantId, isDeleted: false },
      relations: ['participant'],
      order: { createdAt: 'ASC' },
      take: 100,
    });

    sendSuccess(res, messages.map((msg) => ({
      id: msg.id,
      type: msg.type,
      content: msg.content,
      sender: {
        id: msg.participantId,
        type: msg.participant?.type,
        name: msg.participant?.name,
      },
      metadata: msg.metadata,
      createdAt: msg.createdAt,
    })));
  })
);

/**
 * Send message from widget
 * POST /api/v1/widget/message
 */
router.post(
  '/message',
  widgetRateLimiter,
  authenticateWidget,
  asyncHandler(async (req: Request, res: Response) => {
    const { content, type = 'text', metadata } = req.body;
    const sessionId = req.widget!.sessionId;
    const tenantId = req.widget!.tenantId;
    void req.widget!.visitorId; // visitorId available but not needed here

    if (!sessionId) {
      throw new ValidationError('Session not initialized');
    }

    if (!content) {
      throw new ValidationError('Message content is required');
    }

    const sessionRepository = AppDataSource.getRepository(ChatSession);
    const messageRepository = AppDataSource.getRepository(Message);
    const participantRepository = AppDataSource.getRepository(Participant);

    // Verify session
    const session = await sessionRepository.findOne({
      where: { id: sessionId, tenantId },
    });

    if (!session) {
      throw new NotFoundError('Session not found');
    }

    if (session.status === 'closed') {
      throw new ValidationError('Session is closed');
    }

    // Get or create participant
    let participant = await participantRepository.findOne({
      where: { sessionId, type: 'user', isDeleted: false },
    });

    if (!participant) {
      participant = participantRepository.create({
        sessionId,
        type: 'user',
        name: 'Visitor',
        isAnonymous: true,
        joinedAt: new Date(),
      });
      await participantRepository.save(participant);
    }

    // Create message
    const message = messageRepository.create({
      sessionId,
      tenantId,
      participantId: participant.id,
      type,
      content,
      metadata: metadata || {},
      status: 'sent',
      sentAt: new Date(),
    });

    await messageRepository.save(message);

    // Update session
    session.incrementMessageCount();
    await sessionRepository.save(session);

    // Emit to WebSocket
    emitToSession(tenantId, sessionId, 'message:receive', {
      id: message.id,
      sessionId: message.sessionId,
      participantId: message.participantId,
      participantType: 'user',
      type: message.type,
      content: message.content,
      metadata: message.metadata,
      timestamp: message.createdAt.toISOString(),
    });

    sendCreated(res, {
      message: {
        id: message.id,
        content: message.content,
        type: message.type,
        createdAt: message.createdAt,
      },
    });
  })
);

/**
 * Request handoff to human agent
 * POST /api/v1/widget/handoff
 */
router.post(
  '/handoff',
  authenticateWidget,
  asyncHandler(async (req: Request, res: Response) => {
    const { reason = 'user_request', priority = 'medium' } = req.body;
    const sessionId = req.widget!.sessionId;
    const tenantId = req.widget!.tenantId;

    if (!sessionId) {
      throw new ValidationError('Session not initialized');
    }

    const sessionRepository = AppDataSource.getRepository(ChatSession);
    const session = await sessionRepository.findOne({
      where: { id: sessionId, tenantId },
    });

    if (!session) {
      throw new NotFoundError('Session not found');
    }

    // Update session status
    session.status = 'handoff';
    await sessionRepository.save(session);

    // Emit handoff request to tenant
    emitToSession(tenantId, sessionId, 'handoff:requested', {
      sessionId,
      reason,
      priority,
      timestamp: new Date().toISOString(),
    });

    logger.info('Handoff requested from widget', {
      sessionId,
      tenantId,
      reason,
      priority,
    });

    sendSuccess(res, {
      sessionId,
      status: 'handoff_requested',
      message: 'An agent will be with you shortly',
    });
  })
);

/**
 * Rate conversation
 * POST /api/v1/widget/rate
 */
router.post(
  '/rate',
  authenticateWidget,
  asyncHandler(async (req: Request, res: Response) => {
    const { rating, feedback } = req.body;
    const sessionId = req.widget!.sessionId;
    const tenantId = req.widget!.tenantId;

    if (!sessionId) {
      throw new ValidationError('Session not initialized');
    }

    if (!rating || rating < 1 || rating > 5) {
      throw new ValidationError('Rating must be between 1 and 5');
    }

    const sessionRepository = AppDataSource.getRepository(ChatSession);
    const session = await sessionRepository.findOne({
      where: { id: sessionId, tenantId },
    });

    if (!session) {
      throw new NotFoundError('Session not found');
    }

    session.satisfactionRating = rating;
    session.satisfactionFeedback = feedback;
    await sessionRepository.save(session);

    logger.info('Session rated', {
      sessionId,
      tenantId,
      rating,
    });

    sendSuccess(res, {
      message: 'Thank you for your feedback!',
    });
  })
);

export { router as widgetRouter };
