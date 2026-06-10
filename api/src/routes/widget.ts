/**
 * Widget Routes
 * Public endpoints for chat widget integration
 */

import { Router, Request, Response, NextFunction } from 'express';
import { AppDataSource } from '../database/data-source';
import { ChatSession } from '../database/entities/ChatSession';
import { Participant } from '../database/entities/Participant';
import { Message } from '../database/entities/Message';
import { Tenant } from '../database/entities/Tenant';
import { Bot } from '../database/entities/Bot';
import { resolveBotKeyStrict, BotPausedError, BotNotFoundError } from '../services/bot-resolution.service';
import { authenticateWidget, asyncHandler, ValidationError, NotFoundError, RateLimitError, ForbiddenError } from '../middleware';
import { widgetRateLimiter } from '../middleware/rate-limit';
import { emitToSession } from '../websocket/socket.handler';
import { forwardMessageToN8n } from '../services/message-forwarding.service';
import { decrypt, encrypt } from '../utils/encryption';
import { generateWidgetToken } from '../middleware/auth.middleware';
import { logger } from '../utils/logger';
import { sendSuccess, sendCreated } from '../utils/response';
import { widgetVersionHash } from '../widget/widget-version';
import { enforceCountLimit, requireFeature } from '../billing/enforce';
import { getEntitlements } from '../billing/entitlements';
import { Not } from 'typeorm';

// Simple in-memory rate limiter for unauthenticated widget endpoints
// (Redis-based widgetRateLimiter caused crashes when Redis is unavailable)
const ipHits = new Map<string, { count: number; resetAt: number }>();

// Sweep expired entries every 60 seconds to prevent memory leak
setInterval(() => {
  const now = Date.now();
  for (const [ip, data] of ipHits) {
    if (now > data.resetAt) ipHits.delete(ip);
  }
}, 60_000).unref(); // .unref() so it doesn't keep the process alive
function simpleRateLimit(maxRequests: number, windowMs: number) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const ip = req.ip || 'unknown';
    const now = Date.now();
    const entry = ipHits.get(ip);
    if (!entry || now > entry.resetAt) {
      ipHits.set(ip, { count: 1, resetAt: now + windowMs });
      return next();
    }
    if (entry.count >= maxRequests) {
      next(new RateLimitError('Too many requests, please try again later'));
      return;
    }
    entry.count++;
    next();
  };
}
const widgetInitRateLimit = simpleRateLimit(30, 60000); // 30 per minute

// Inline API key validation. Resolves either a Bot.publicKey or a legacy
// Tenant.apiKey via the shared resolver so the widget knows which bot it's
// talking to. Paused bots are rejected here (#16b) — `paused: true` signals
// the caller to return HTTP 403 instead of 401.
interface ApiKeyValidationResult {
  valid: boolean;
  tenant?: Tenant;
  bot?: Bot;
  error?: string;
  paused?: boolean;
}

async function validateApiKey(apiKey: string): Promise<ApiKeyValidationResult> {
  if (!apiKey) {
    return { valid: false, error: 'API key is required' };
  }
  try {
    // #16b: paused bots are rejected at the widget surface. The strict resolver
    // throws `BotPausedError` when the matched bot is paused — surface that
    // distinctly from "invalid key" so the caller can return HTTP 403 with a
    // user-facing message instead of 401.
    const resolved = await resolveBotKeyStrict(apiKey);
    return { valid: true, tenant: resolved.tenant, bot: resolved.bot };
  } catch (error) {
    if (error instanceof BotPausedError) {
      return { valid: false, error: 'This chatbot is currently paused', paused: true };
    }
    if (error instanceof BotNotFoundError) {
      return { valid: false, error: 'Invalid API key' };
    }
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

    if (result.paused) {
      // #16b: paused bot → 403, not 400. The widget can show a friendly
      // "this chatbot is unavailable" state.
      throw new ForbiddenError(result.error || 'This chatbot is currently paused');
    }
    if (!result.valid || !result.tenant || !result.bot) {
      throw new ValidationError(result.error || 'Invalid API key');
    }

    const tenant = result.tenant;
    const bot = result.bot;

    // #16d completion: widget appearance + behavioural config lives on
    // bot.settings. Tenant is only consulted for tier (entitlement gates)
    // and the LLM-provider apiKey (read elsewhere, not exposed here).
    const botSettings = bot.settings ?? {};
    const widgetSettings = (botSettings.widget ?? {}) as {
      avatarUrl?: string | null;
      launcherPosition?: 'bottom-right' | 'bottom-left';
      launcherLabel?: string | null;
    };
    const appearance = {
      avatarUrl: widgetSettings.avatarUrl || null,
      launcherPosition: widgetSettings.launcherPosition || 'bottom-right',
      launcherLabel: widgetSettings.launcherLabel || null,
    };

    // D33/D34: the "Powered by Axentrio" footer is hidden on Pro+ and
    // shown on Essential. The widget client reads `attribution.hide` and
    // renders the footer when false. Fail closed on unknown tier so a
    // malformed DB row defaults to showing the attribution.
    let hideAttribution = false;
    try {
      hideAttribution = (await getEntitlements(tenant.id)).features.hideWidgetAttribution;
    } catch {
      hideAttribution = false;
    }

    sendSuccess(res, {
      tenantId: tenant.id,
      name: tenant.name,
      bot: {
        id: bot.id,
        name: bot.name,
        status: bot.status,
      },
      theme: botSettings.theme || {
        primaryColor: '#007bff',
        backgroundColor: '#ffffff',
        textColor: '#333333',
      },
      features: {
        fileUploadEnabled: botSettings.features?.fileUploadEnabled ?? false,
        handoffEnabled: botSettings.features?.handoffEnabled ?? true,
        aiEnabled: botSettings.ai?.enabled ?? false,
      },
      businessHours: botSettings.businessHours || {
        enabled: false,
        timezone: 'UTC',
      },
      appearance,
      attribution: { hide: hideAttribution },
      widgetVersion: widgetVersionHash,
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

    if (result.paused) {
      // #16b: paused bot → 403, not 400. The widget can show a friendly
      // "this chatbot is unavailable" state.
      throw new ForbiddenError(result.error || 'This chatbot is currently paused');
    }
    if (!result.valid || !result.tenant || !result.bot) {
      throw new ValidationError(result.error || 'Invalid API key');
    }

    const tenant = result.tenant;
    const resolvedBot = result.bot;

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
      // Bind a botId to legacy sessions that pre-date the column.
      if (!existingSession.botId) {
        existingSession.botId = resolvedBot.id;
        await sessionRepository.save(existingSession);
      }
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

    // Determine initial status based on AI settings — #16d: read from
    // bot.settings, not tenant.settings. Issue #3: an AI-enabled bot is answered
    // by the platform agent (or a custom webhook), so it starts in 'bot' — no
    // longer keyed off the legacy usePlatformAgent flag or the dead default URL.
    const aiEnabled = resolvedBot.settings?.ai?.enabled;
    const initialStatus = aiEnabled ? 'bot' : 'waiting';

    // Plan-gate (step 10, count 2). Wrap session create in a tx that locks
    // the tenants row, counts non-closed sessions, throws 402 on cap.
    // The plan calls for `tenants.current_sessions`, but that counter is
    // not actually maintained anywhere in this codebase — we use a live
    // COUNT(*) on chat_sessions filtered by tenant + non-closed status
    // instead. Cost is one indexed count per widget /init (index on
    // (tenant_id, status) already exists for other queries).
    const session = await AppDataSource.transaction(async (manager) => {
      await enforceCountLimit({
        manager,
        tenantId: tenant.id,
        capability: 'sessions',
        errorCode: 'plan_limit_sessions',
        countQuery: (m) =>
          m.count(ChatSession, {
            where: { tenantId: tenant.id, status: Not('closed') },
          }),
      });
      const draft = manager.create(ChatSession, {
        tenantId: tenant.id,
        botId: resolvedBot.id,
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
      return manager.save(ChatSession, draft);
    });

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
          content: encrypt(greetingMessage),
          contentEncrypted: true,
          status: 'sent' as Message['status'],
          sentAt: new Date(),
          metadata: {
            quickReplies: ['Book appointment', 'Our services', 'Pricing', 'Talk to someone'],
          },
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
      content: msg.contentEncrypted ? decrypt(msg.content) : msg.content,
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
    const { content: plainContent, type = 'text', metadata } = req.body;
    const content = plainContent;
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
      content: encrypt(content),
      contentEncrypted: true,
      metadata: metadata || {},
      status: 'sent',
      sentAt: new Date(),
    });

    await messageRepository.save(message);

    // Update session
    session.incrementMessageCount();
    await sessionRepository.save(session);

    // Emit to WebSocket — use original plaintext content
    emitToSession(tenantId, sessionId, 'message:receive', {
      id: message.id,
      sessionId: message.sessionId,
      participantId: message.participantId,
      participantType: 'user',
      type: message.type,
      content,
      metadata: message.metadata,
      timestamp: message.createdAt.toISOString(),
    });

    forwardMessageToN8n(session, message).catch((err) => {
      logger.error('Error in n8n message forwarding (widget):', err);
    });

    sendCreated(res, {
      message: {
        id: message.id,
        content,
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

// ── File upload (P5e) ────────────────────────────────────────────────────────
// Visitor-authenticated (widget session, NOT Clerk) wrappers over the SAME upload
// service + virus scan the owner/portal path uses. Tenant + chat session come from
// the server-trusted widget token, never the client.

const UPLOAD_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

router.post(
  '/files/upload',
  widgetRateLimiter,
  authenticateWidget,
  asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const w = req.widget!;
    if (!w.tenantId || !w.sessionId) throw new ValidationError('Widget session required');
    await requireFeature(w.tenantId, 'fileUpload', 'plan_limit_file_upload');
    const { fileName, fileSize, mimeType } = req.body;
    if (!fileName || !fileSize || !mimeType) {
      throw new ValidationError('fileName, fileSize, and mimeType are required');
    }
    const { getUploadService } = await import('../file-handling/upload.service');
    // generateUploadUrl runs the existing size/mime/quota validation; fileKey is
    // server-derived and the presigned PUT pins ContentLength/Content-Type.
    const session = await getUploadService().generateUploadUrl({
      fileName,
      fileSize,
      mimeType,
      tenantId: w.tenantId, // server-trusted
      userId: '',
      chatSessionId: w.sessionId, // binds the upload to THIS chat
    });
    sendSuccess(res, {
      upload: { sessionId: session.sessionId, uploadUrl: session.uploadUrl, expiresAt: session.expiresAt },
    });
  })
);

router.post(
  '/files/:sessionId/upload-complete',
  authenticateWidget,
  asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const w = req.widget!;
    if (!w.tenantId || !w.sessionId) throw new ValidationError('Widget session required');
    const { sessionId } = req.params;
    if (!UPLOAD_UUID_RE.test(sessionId)) throw new ValidationError('Invalid sessionId');
    const { getUploadService } = await import('../file-handling/upload.service');
    const uploadService = getUploadService();
    const session = await uploadService.getSession(sessionId);
    // Ownership: a widget session may only complete/probe ITS OWN upload. A
    // missing session AND a foreign-tenant/foreign-chat session both throw the
    // SAME 404 so a visitor can't use this endpoint as a cross-tenant existence
    // oracle for upload-session ids.
    if (
      !session ||
      session.tenantId !== w.tenantId ||
      session.chatSessionId !== w.sessionId
    ) {
      throw new NotFoundError('Upload session not found');
    }
    // Terminal-state idempotency (never re-scan / re-transition).
    if (session.status === 'ready' || session.status === 'quarantined') {
      sendSuccess(res, { sessionId, status: session.status, scanResult: session.scanResult ?? null });
      return;
    }
    const exists = await uploadService.fileExists(session.fileKey);
    if (!exists) throw new NotFoundError('File not yet uploaded');
    const { performScan } = await import('../file-handling/virus-scan-trigger');
    const scanResult = await performScan(sessionId, session.fileKey);
    sendSuccess(res, { sessionId, status: scanResult.clean ? 'ready' : 'quarantined', scanResult });
  })
);

export { router as widgetRouter };
