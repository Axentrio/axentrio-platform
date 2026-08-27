/**
 * Widget Routes
 * Public endpoints for chat widget integration
 */

import express, { Router, Request, Response, NextFunction } from 'express';
import { AppDataSource } from '../database/data-source';
import { ChatSession } from '../database/entities/ChatSession';
import { Message } from '../database/entities/Message';
import { Tenant } from '../database/entities/Tenant';
import { Bot } from '../database/entities/Bot';
import { assertUploadEnabledForSession } from '../file-handling/widget-upload-gate';
import { resolveBotKeyStrict, BotPausedError, BotNotFoundError } from '../services/bot-resolution.service';
import { authenticateWidget, asyncHandler, ValidationError, NotFoundError, RateLimitError, ForbiddenError } from '../middleware';
import { MAX_MESSAGE_CONTENT_CHARS } from '../guardrails/classify';
import { ApiError } from '../middleware/error-handler';
import { widgetRateLimiter } from '../middleware/rate-limit.middleware';
import { emitToSession } from '../websocket/socket.handler';
import { emitConversationUpsertForSession } from '../realtime/conversation-events';
import { computeCustomerThreadId } from '../realtime/conversation-serializer';
import {
  acquireWidgetIdentityLock,
  resolveOpenWidgetSession,
  createWidgetSessionInTx,
  announceWidgetSession,
  ensureWidgetGreeting,
  assertValidVisitorId,
} from '../services/widget-session-identity';
import { ingestWidgetCustomerMessage } from '../services/widget-ingest';
import { enqueueChatDocument } from '../services/chat-documents';
import { conversationCommands } from '../services/conversation-command.service';
import { deliverHandoffNotification } from '../notifications/notification-outbox.worker';
import type { HandoffReason } from '../database/entities/HandoffRequest';
import { autocompleteAddress } from '../booking/travel/places.service';
import { resolvePlaceId } from '../booking/travel/geocoding.service';
import {
  bindAddress,
  confirmCorrection,
  rejectCorrection,
} from '../booking/travel/address-binding';
import { placesRateLimiter } from '../middleware/rate-limit.middleware';
import { addressConfirmSchema, placesQuerySchema, placesSelectSchema } from '../schemas/scheduler.schema';
import { decrypt } from '../utils/encryption';
import { generateWidgetToken } from '../middleware/auth.middleware';
import { logger } from '../utils/logger';
import { sendSuccess, sendCreated } from '../utils/response';
import { widgetVersionHash } from '../widget/widget-version';
import { requireFeature } from '../billing/enforce';
import { getEntitlements } from '../billing/entitlements';

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

type WidgetBotSettings = NonNullable<Bot['settings']>;

function buildWidgetAppearance(botSettings: WidgetBotSettings) {
  const widgetSettings = (botSettings.widget ?? {}) as {
    avatarUrl?: string | null;
    launcherPosition?: 'bottom-right' | 'bottom-left';
    launcherLabel?: string | null;
  };
  return {
    avatarUrl: widgetSettings.avatarUrl || null,
    launcherPosition: widgetSettings.launcherPosition || 'bottom-right',
    launcherLabel: widgetSettings.launcherLabel || null,
  };
}

function buildWidgetFeatureFlags(botSettings: WidgetBotSettings) {
  return {
    fileUploadEnabled: botSettings.features?.fileUploadEnabled ?? false,
    handoffEnabled: botSettings.features?.handoffEnabled ?? true,
    aiEnabled: botSettings.ai?.enabled ?? false,
  };
}

// Display fact only. The timezone shown is the DERIVED bot value (PR 1a):
// legacy rows may still store a browser-written timezone the server no
// longer honours anywhere.
function buildWidgetBusinessHours(
  botSettings: WidgetBotSettings,
  businessTimezone: string | null | undefined,
) {
  return botSettings.businessHours
    ? { ...botSettings.businessHours, timezone: businessTimezone || botSettings.businessHours.timezone }
    : { enabled: false, timezone: businessTimezone || 'UTC' };
}

const router = Router();

// ── Stable widget identity (B-PR4a) ─────────────────────────────────────────
// One real customer = one (tenantId, botId, visitorId) = at most ONE non-closed
// widget session, enforced by the partial unique index
// uq_chat_sessions_widget_open (migration 1791500000000). Every resolve-or-
// create and every close-and-open runs under the SAME transaction-level
// advisory lock on that identity, so concurrent inits (two tabs) serialize:
// the first creates, the rest resolve the winner - nobody 500s on the index.
// The helpers live in services/widget-session-identity so the legacy
// /auth/widget creator shares the EXACT same seam (review fix B1).

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
    const appearance = buildWidgetAppearance(botSettings);

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
      features: buildWidgetFeatureFlags(botSettings),
      businessHours: buildWidgetBusinessHours(botSettings, bot.businessTimezone),
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
    // 422 for non-string / oversized / control-character ids (S3) - they feed
    // varchar(255) and the advisory-lock key, and must never become a DB 500.
    assertValidVisitorId(visitorId);

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

    // Resolve-or-create by stable identity, race-safe (B-PR4a). The whole
    // decision runs in ONE transaction under the identity advisory lock, so a
    // two-tab race serializes: the first request creates, the second resolves
    // the winner - it can never double-create and 500 on the unique index.
    const { session, isNew } = await AppDataSource.transaction(async (manager) => {
      await acquireWidgetIdentityLock(manager, tenant.id, resolvedBot.id, visitorId);

      const existing = await resolveOpenWidgetSession(manager, tenant.id, resolvedBot.id, visitorId);
      if (existing) {
        return { session: existing, isNew: false };
      }

      const created = await createWidgetSessionInTx(manager, {
        tenant,
        bot: resolvedBot,
        visitorId,
        metadata,
        req,
      });
      return { session: created, isNew: true };
    });

    if (isNew) {
      // Post-commit: upsert announce + idempotent greeting. The participant
      // committed WITH the session (S1); nothing here can throw.
      await announceWidgetSession(session, tenant, resolvedBot);
      logger.info('Widget session initialized', {
        sessionId: session.id,
        tenantId: tenant.id,
        visitorId,
      });
    } else {
      // Resolve-retry healing (S1): if a prior create committed but its
      // greeting write failed, this re-announces the missing greeting.
      // Idempotent - it no-ops when the session already has any message.
      await ensureWidgetGreeting(session, tenant, resolvedBot);
    }

    // Fresh token either way - a resolve is how a returning tab (or a
    // recovering widget) re-arms an expired token for the SAME session.
    const token = generateWidgetToken(session.id, tenant.id, visitorId);

    sendSuccess(res, {
      session: {
        id: session.id,
        status: session.status,
        startedAt: session.startedAt,
        // The widget's stored-session guard requires tenantId; the old
        // response never carried it, which silently disabled blob restore.
        tenantId: tenant.id,
      },
      token,
      isNew,
      customerThreadId: computeCustomerThreadId(session),
    });
  })
);

/**
 * Start a new conversation for the SAME stable identity (B-PR4a §3).
 * POST /api/v1/widget/new-conversation  (widget token auth)
 *
 * ONE transaction under the SAME identity advisory lock: close the visitor's
 * current non-closed widget session THROUGH the conversation-command service
 * (ownership -> 'closed', handoff bookkeeping, the system event), then open a
 * fresh session for the same visitorId. Replaces the widget's client-only
 * localStorage clear, which with a durable visitorId would just resolve the
 * old session again.
 */
router.post(
  '/new-conversation',
  widgetInitRateLimit,
  authenticateWidget,
  asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const tokenSessionId = req.widget!.sessionId;
    const tenantId = req.widget!.tenantId;
    if (!tokenSessionId) {
      throw new ValidationError('Session not initialized');
    }
    const metadata = (req.body?.metadata ?? undefined) as
      | { name?: string; pageUrl?: string; referrer?: string }
      | undefined;

    const outcome = await AppDataSource.transaction(async (manager) => {
      // The token's session anchors the identity; the SERVER's stored
      // (tenant_id, bot_id, visitor_id) is what gets closed and reopened -
      // never anything client-supplied.
      const anchor = await manager.findOne(ChatSession, {
        where: { id: tokenSessionId, tenantId },
      });
      if (!anchor) throw new NotFoundError('Session not found');
      if (anchor.source !== 'widget') {
        throw new ValidationError('Not a widget session');
      }

      const tenant = await manager.findOne(Tenant, { where: { id: tenantId } });
      if (!tenant) throw new NotFoundError('Tenant not found');
      const bot = await manager.findOne(Bot, { where: { id: anchor.botId } });
      if (!bot) throw new NotFoundError('Bot not found');
      if (bot.status === 'paused') {
        // Same surface rule as /init (#16b): a paused bot opens nothing new.
        throw new ForbiddenError('This chatbot is currently paused');
      }

      await acquireWidgetIdentityLock(manager, tenantId, anchor.botId, anchor.visitorId);

      // Lock-order note: this transaction takes the SESSION row lock (inside
      // closeConversation below) BEFORE the tenants row lock (inside
      // createWidgetSessionInTx), while /init and the inbound pipeline take
      // the tenants lock first. Reviewed: no live cycle exists, because no
      // path holds the tenants lock while locking an EXISTING session row -
      // the tenants-lock holders only INSERT new rows.

      // The identity's CURRENT open session (the token's may already be
      // closed and superseded). Under the invariant there is at most one.
      const current = await resolveOpenWidgetSession(
        manager,
        tenantId,
        anchor.botId,
        anchor.visitorId,
      );
      let closedSessionId: string | null = null;
      if (current) {
        await conversationCommands.closeConversation(
          current.id,
          { kind: 'customer' },
          undefined,
          { tenantId, manager, reason: 'Customer started a new conversation' },
        );
        closedSessionId = current.id;
      }

      const created = await createWidgetSessionInTx(manager, {
        tenant,
        bot,
        visitorId: anchor.visitorId,
        metadata,
        req,
      });
      return { closedSessionId, session: created, tenant, bot };
    });

    // Post-commit fan-out, same order the command routes use: the close's
    // normalized upsert first, then the new session's announce + greeting.
    // The participant committed WITH the session (S1); nothing here throws.
    if (outcome.closedSessionId) {
      await emitConversationUpsertForSession(outcome.closedSessionId, tenantId);
    }
    await announceWidgetSession(outcome.session, outcome.tenant, outcome.bot);

    const token = generateWidgetToken(outcome.session.id, tenantId, outcome.session.visitorId);

    logger.info('Widget conversation replaced', {
      tenantId,
      closedSessionId: outcome.closedSessionId,
      newSessionId: outcome.session.id,
      visitorId: outcome.session.visitorId,
    });

    sendSuccess(res, {
      session: {
        id: outcome.session.id,
        status: outcome.session.status,
        startedAt: outcome.session.startedAt,
        tenantId,
      },
      token,
      isNew: true,
      closedSessionId: outcome.closedSessionId,
      customerThreadId: computeCustomerThreadId(outcome.session),
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
    const content = typeof plainContent === 'string' ? plainContent : '';
    const sessionId = req.widget!.sessionId;
    const tenantId = req.widget!.tenantId;
    void req.widget!.visitorId; // visitorId available but not needed here

    if (!sessionId) {
      throw new ValidationError('Session not initialized');
    }

    if (type !== 'file' && !content) {
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
    if (type === 'file' && metadata && typeof metadata.uploadSessionId === 'string') {
      await enqueueChatDocument(session, ingested.entity, 'widget');
    }

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

    // The ONE transactional handoff-creation path (B-PR2b): ownership + legacy
    // status + the open HandoffRequest row + the system event move together.
    // The old handler wrote status='handoff' directly and created NO
    // HandoffRequest row, so this path was invisible to the /handoffs/queue.
    const validReasons: HandoffReason[] = ['user_request', 'bot_confidence_low', 'escalation_trigger', 'business_hours'];
    const handoffReason = validReasons.includes(reason as HandoffReason) ? (reason as HandoffReason) : 'user_request';
    const result = await conversationCommands.requestHandoff(
      sessionId,
      handoffReason,
      'widget',
      undefined,
      { tenantId, notify: true },
    );

    if (result.outcome === 'handoff_disabled') {
      // Deployed widgets expect a 200 envelope; a disabled bot simply reports
      // that nobody is coming instead of silently parking the customer forever.
      sendSuccess(res, {
        sessionId,
        status: 'handoff_unavailable',
        message: 'Human handoff is not available for this assistant',
      });
      return;
    }

    // Emit only for a genuinely open request — a human already owning the
    // conversation must not re-ring the operator bell.
    if (result.outcome === 'requested' || result.outcome === 'already_requested') {
      emitToSession(tenantId, sessionId, 'handoff:requested', {
        sessionId,
        reason,
        priority,
        timestamp: new Date().toISOString(),
      });
    }

    // B-PR3a: normalized ownership event, post-commit, only when the state moved.
    if (result.outcome === 'requested') {
      await emitConversationUpsertForSession(sessionId, tenantId);
      void deliverHandoffNotification({
        tenantId,
        handoffId: result.handoffId!,
        sessionId,
        reason: handoffReason,
        requestedAt: new Date(),
      }).catch((error) => {
        logger.warn('Handoff notification backstop failed', {
          tenantId,
          sessionId,
          handoffId: result.handoffId!,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }

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

    // Targeted UPDATE, never save(session) — B-PR2b fix B1.
    await sessionRepository.update(session.id, {
      satisfactionRating: rating,
      satisfactionFeedback: feedback,
    });

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
  const { FileValidationError, QuotaExceededError, UploadSessionError } = await import('../file-handling/upload.service');
  if (err instanceof FileValidationError) throw new ApiError(err.message, 400, 'FILE_VALIDATION_FAILED');
  if (err instanceof QuotaExceededError) throw new ApiError(err.message, 429, 'QUOTA_EXCEEDED');
  if (err instanceof UploadSessionError) throw new NotFoundError(err.message);
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
  '/files/:sessionId/content',
  widgetRateLimiter,
  authenticateWidget,
  express.raw({ type: '*/*', limit: '25mb' }),
  asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const w = req.widget!;
    if (!w.tenantId || !w.sessionId) throw new ValidationError('Widget session required');
    const { sessionId } = req.params;
    if (!UPLOAD_UUID_RE.test(sessionId)) throw new ValidationError('Invalid sessionId');
    await assertUploadEnabledForSession(w.tenantId, w.sessionId);
    if (!isS3Configured()) {
      throw new ApiError('File uploads are not available right now', 503, 'STORAGE_UNAVAILABLE');
    }
    const buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (buffer.length === 0) throw new ValidationError('File body is required');
    const { getUploadService } = await import('../file-handling/upload.service');
    await getUploadService()
      .writeWidgetObject(sessionId, buffer, w.tenantId, w.sessionId)
      .catch(asUploadApiError);
    sendSuccess(res, { sessionId, bytes: buffer.length });
  }),
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
