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
import { assertUploadEnabledForSession } from '../file-handling/widget-upload-gate';
import { resolveBotKeyStrict, BotPausedError, BotNotFoundError } from '../services/bot-resolution.service';
import { authenticateWidget, asyncHandler, ValidationError, NotFoundError, RateLimitError, ForbiddenError } from '../middleware';
import { MAX_MESSAGE_CONTENT_CHARS } from '../guardrails/classify';
import { ApiError } from '../middleware/error-handler';
import { widgetRateLimiter } from '../middleware/rate-limit';
import { emitToSession } from '../websocket/socket.handler';
import { ingestWidgetCustomerMessage } from '../services/widget-ingest';
import { autocompleteAddress } from '../booking/travel/places.service';
import { resolvePlaceId } from '../booking/travel/geocoding.service';
import {
  bindAddress,
  confirmCorrection,
  rejectCorrection,
} from '../booking/travel/address-binding';
import { questionWasAsked } from '../booking/travel/question-delivery';
import { placesRateLimiter } from '../middleware/rate-limit';
import { addressConfirmSchema, placesQuerySchema, placesSelectSchema } from '../schemas/scheduler.schema';
import { decrypt, encrypt } from '../utils/encryption';
import { generateWidgetToken } from '../middleware/auth.middleware';
import { logger } from '../utils/logger';
import { sendSuccess, sendCreated } from '../utils/response';
import { widgetVersionHash } from '../widget/widget-version';
import { enforceCountLimit, requireFeature } from '../billing/enforce';
import { getEntitlements } from '../billing/entitlements';
import { Not } from 'typeorm';
import { effectiveBotConfig, withEffectiveConfig } from '../templates/template-resolver';
import { substituteVariables } from '../llm/prompt-builder';
import { defaultBotAi } from '../config/default-bot-settings';

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

    // Send bot greeting if session starts in bot mode. The greeting comes from
    // the effective config (template-owned when bound, else the bot's own stored
    // value), with placeholders like {botName}/{businessName} substituted.
    if (initialStatus === 'bot') {
      const eff = await effectiveBotConfig(resolvedBot);
      const botAi = resolvedBot.settings?.ai ?? defaultBotAi(resolvedBot.name);
      const aiForGreeting = withEffectiveConfig(botAi, eff);
      const rawGreeting = aiForGreeting.guardrails?.greetingMessage ?? '';
      const greetingMessage = rawGreeting
        ? substituteVariables(rawGreeting, aiForGreeting, { businessName: tenant.name })
        : '';
      if (greetingMessage) {
        const messageRepository = AppDataSource.getRepository(Message);
        const botParticipant = participantRepository.create({
          sessionId: session.id,
          type: 'bot',
          name: resolvedBot.settings?.ai?.brandVoice?.name || 'AI Assistant',
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

    if (typeof content !== 'string' || !content) {
      throw new ValidationError('Message content is required');
    }

    // Hard length cap == the guardrails scan window, so no ingress path forwards
    // an unscanned tail to the AI (closes the prefix-evasion). See chat.schema.
    if (content.length > MAX_MESSAGE_CONTENT_CHARS) {
      throw new ValidationError('Message too long');
    }

    const sessionRepository = AppDataSource.getRepository(ChatSession);

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

    const ingested = await ingestWidgetCustomerMessage(session, content, { type, metadata });

    sendCreated(res, {
      message: {
        id: ingested.id,
        content: ingested.content,
        type: ingested.type,
        createdAt: ingested.createdAt,
      },
    });
  })
);

/**
 * Address suggestions while a customer types.
 *
 * POST, not GET: the body is a partly-typed home address, and a GET would put it in the URL,
 * the access log and the referrer header of anything the page loads next.
 *
 * Rate-limited because it costs a billable element per call and fires on a debounce. An
 * unavailable Google returns an empty list and a 200 - the customer types their address exactly
 * as they do today, which is the same fail-open every travel gate keeps.
 */
router.post(
  '/places/autocomplete',
  authenticateWidget,
  placesRateLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const tenantId = req.widget!.tenantId;
    // The same schema the portal route parses with. Hand-rolling the bound here is how the two
    // surfaces come to disagree about what a valid query is.
    const { query } = placesQuerySchema.parse(req.body ?? {});

    const result = await autocompleteAddress(tenantId, query);
    sendSuccess(res, { suggestions: result.status === 'ok' ? result.suggestions : [] });
  })
);

/**
 * The customer picked one. THIS is where an address becomes the address.
 *
 * Two things happen, and both are necessary. The place is bound to the session, so every later
 * tool call is about it rather than about whatever text the model reconstructs. And the choice is
 * spoken INTO THE CONVERSATION through the same ingestion path a typed message takes - because a
 * selection that only updated server state would leave the model believing no address was ever
 * given, and it would ask again.
 */
router.post(
  '/places/select',
  authenticateWidget,
  placesRateLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const tenantId = req.widget!.tenantId;
    const sessionId = req.widget!.sessionId;
    if (!sessionId) throw new ValidationError('Session not initialized');

    const { placeId } = placesSelectSchema.parse(req.body ?? {});

    const resolved = await resolvePlaceId(tenantId, placeId);
    if (resolved.status !== 'placed') {
      // The id came from our own suggestion list, so this is Google or the tenant's cap - never
      // something the customer did wrong. 503 keeps that distinction, and the widget falls back
      // to letting them type.
      throw new ApiError(
        'That address could not be confirmed right now. Please type it instead.',
        503,
        'PLACE_UNAVAILABLE'
      );
    }

    const session = await AppDataSource.getRepository(ChatSession).findOne({
      where: { id: sessionId, tenantId },
    });
    if (!session) throw new NotFoundError('Session not found');
    if (session.status === 'closed') throw new ValidationError('Session is closed');

    await bindAddress(sessionId, {
      placeId: resolved.place.placeId,
      formattedAddress: resolved.place.formattedAddress,
    });

    // THE ADDRESS ALONE, with no sentence wrapped around it.
    //
    // The obvious version is `My address is ${...}`, and it is a trap: this conversation may be
    // in Dutch, French or German, and an English sentence appearing as something the CUSTOMER
    // said is exactly the kind of thing that has made this platform's model answer in the wrong
    // language before. Translating it is worse - a canned string round-tripped through a
    // translator is how the off-hours message once reached a customer mistranslated.
    //
    // An address on its own needs no language. It is also what a customer typing one usually
    // sends, so the model reads the same shape either way.
    await ingestWidgetCustomerMessage(session, resolved.place.formattedAddress);

    sendSuccess(res, {
      placeId: resolved.place.placeId,
      formattedAddress: resolved.place.formattedAddress,
    });
  })
);

/**
 * Request handoff to human agent
 * POST /api/v1/widget/handoff
 */
/**
 * The customer answers "should the address be X instead of Y?" (#95).
 *
 * Until this existed the answer went nowhere. `proposeCorrection` recorded the question,
 * `confirmCorrection` and `rejectCorrection` were implemented and unit-tested, and NOTHING in
 * production called them - so a customer who said "yes, Kerkstraat 12 is correct" was booked at
 * the address they had just moved away from, and told otherwise. Reproduced on production the day
 * address suggestions were enabled, which is what made the path reachable at all.
 *
 * A SERVER-OBSERVED EVENT, never a model relay. The binding exists precisely because tool
 * arguments are LLM-written and cannot be trusted to move it; a boolean from the model would be
 * the same claim wearing a smaller hat. This is a button press, the same class of evidence as
 * `/places/select`, and it carries the `proposalId` the SERVER issued - so a late "yes" cannot
 * confirm a question the customer has already moved past. `confirmCorrection` returns false on a
 * proposal that is no longer outstanding, and that is reported rather than swallowed.
 */
router.post(
  '/address/confirm',
  authenticateWidget,
  asyncHandler(async (req: Request, res: Response) => {
    const tenantId = req.widget!.tenantId;
    const sessionId = req.widget!.sessionId;
    if (!sessionId) throw new ValidationError('Session not initialized');

    const { proposalId, confirmed } = addressConfirmSchema.parse(req.body ?? {});

    const session = await AppDataSource.getRepository(ChatSession).findOne({
      where: { id: sessionId, tenantId },
    });
    if (!session) throw new NotFoundError('Session not found');
    if (session.status === 'closed') throw new ValidationError('Session is closed');

    // THE QUESTION MUST HAVE REACHED THEM, not merely been claimed.
    //
    // `presented` is set when the tool decides to ask, and the reply carrying the control is
    // written later - so a run that dies in between leaves the flag set with nothing on screen.
    // The Lua transition only sees the flag, and the proposalId is a hash of two addresses the
    // customer knows, so without this an answer could be posted for a question that was never
    // shown. Checking the persisted bot reply is what makes the flag mean what it says.
    //
    // `null` is "cannot tell" and proceeds, matching the tool's own fallback: an unavailable check
    // must not strand a customer holding a button that legitimately exists.
    const asked = await questionWasAsked(AppDataSource, sessionId, proposalId);
    if (asked === false) {
      sendSuccess(res, { applied: false, reason: 'no_longer_outstanding', current: { bound: null, proposed: null, proposalId: null } });
      return;
    }

    // ONE call, and no pre-read. There used to be a `getPendingCorrection` here whose value was
    // then ingested below - a value read BEFORE the transition, so under contention the model
    // could be told an address the store had not committed. The transition returns what it
    // actually wrote, which is the only answer that cannot disagree with the record.
    const result = confirmed
      ? await confirmCorrection(sessionId, proposalId)
      : await rejectCorrection(sessionId, proposalId);

    // Not an error the customer caused: the question may have been superseded or have expired
    // while the button sat on their screen. `current` carries BOTH addresses so the client can
    // re-render the question that IS outstanding rather than the one that is not - handed only a
    // reason, it could show nothing or show the stale choice, and the stale choice is worse.
    if (!result.applied) {
      sendSuccess(res, {
        applied: false,
        reason: 'no_longer_outstanding',
        current: {
          bound: result.current.active?.formattedAddress ?? null,
          proposed: result.current.pending?.formattedAddress ?? null,
          proposalId: result.current.pending?.proposalId ?? null,
        },
      });
      return;
    }

    // The address the conversation is now about, spoken INTO it the same way a picked address is.
    // A state change the model never hears about is one it will contradict in its next sentence.
    //
    // BOTH outcomes ingest, which a rejection did not used to do - so a customer who said "no" got
    // silence, and the model, never told, would ask again or carry on against the wrong address.
    // `address` is null only when a booking cleared the binding between the question and the tap;
    // there is nothing true to say then, so nothing is said.
    if (result.address) await ingestWidgetCustomerMessage(session, result.address);

    sendSuccess(res, { applied: true, confirmed, address: result.address });
  })
);

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

/** Storage isn't configured everywhere; without this the visitor gets a 500. */
function isS3Configured(): boolean {
  return !!(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY && process.env.AWS_S3_BUCKET);
}

/**
 * Map the upload service's own error types onto real statuses.
 *
 * Both reached the global handler as 500/INTERNAL_ERROR, so "your file is too big" and
 * "you are over quota" — the two things a visitor can actually act on — arrived as
 * "something went wrong on our end". The portal path has had this adapter all along.
 */
async function asUploadApiError(err: unknown): Promise<never> {
  const { FileValidationError, QuotaExceededError } = await import('../file-handling/upload.service');
  if (err instanceof FileValidationError) throw new ApiError(err.message, 400, 'FILE_VALIDATION_FAILED');
  if (err instanceof QuotaExceededError) throw new ApiError(err.message, 429, 'QUOTA_EXCEEDED');
  throw err;
}

router.post(
  '/files/upload',
  widgetRateLimiter,
  authenticateWidget,
  asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const w = req.widget!;
    if (!w.tenantId || !w.sessionId) throw new ValidationError('Widget session required');
    await requireFeature(w.tenantId, 'fileUpload', 'plan_limit_file_upload');
    // Entitlement is the ceiling; the owner's own switch is what actually decides.
    await assertUploadEnabledForSession(w.tenantId, w.sessionId);
    if (!isS3Configured()) {
      throw new ApiError('File uploads are not available right now', 503, 'STORAGE_UNAVAILABLE');
    }
    const { fileName, fileSize, mimeType } = req.body;
    if (!fileName || !fileSize || !mimeType) {
      throw new ValidationError('fileName, fileSize, and mimeType are required');
    }
    const { getUploadService } = await import('../file-handling/upload.service');
    // generateUploadUrl runs the existing size/mime/quota validation; fileKey is
    // server-derived and the presigned PUT pins ContentLength/Content-Type.
    const session = await getUploadService()
      .generateUploadUrl({
        fileName,
        fileSize,
        mimeType,
        tenantId: w.tenantId, // server-trusted
        userId: '',
        chatSessionId: w.sessionId, // binds the upload to THIS chat
      })
      .catch(asUploadApiError);
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
    // Also gated: completing an upload started before the owner switched uploads off must
    // not slip a file through the back half of the flow.
    await assertUploadEnabledForSession(w.tenantId, w.sessionId);
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
