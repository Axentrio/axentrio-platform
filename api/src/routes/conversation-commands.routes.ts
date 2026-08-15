/**
 * Conversation command routes (B-PR2b) — the acknowledged REST surface for
 * operator takeover / reply / release / cancel / close (plan §B1/D4).
 *
 * POST /chats/:sessionId/takeover  { idempotencyKey, mode, hours? }
 * POST /chats/:sessionId/release   { idempotencyKey }
 * POST /chats/:sessionId/cancel    { idempotencyKey }   // HANDOFF_REQUESTED -> BOT_OWNED
 * POST /chats/:sessionId/close     { idempotencyKey }
 * POST /chats/:sessionId/messages  { clientMessageId, content }
 *
 * Every mutation goes through the conversation command service (one DB
 * transaction, row locks, idempotency replay); this layer does auth,
 * validation, and post-commit socket fan-out only (D4: commands mutate,
 * sockets distribute committed facts).
 *
 * Mounted at /chats BEFORE chat.routes. The one path collision is
 * POST /:sessionId/close, which the WIDGET also uses (widget-token authed, in
 * chat.routes): a request carrying a widget JWT is passed through to that
 * router untouched.
 */
import { Router, Request, Response, NextFunction } from 'express';
import { logger } from '../utils/logger';
import { requireClerkAuth, autoProvision } from '../middleware/clerk.middleware';
import { resolveTenantContext } from '../middleware/super-admin.middleware';
import { validateTenant, TenantRequest } from '../middleware/tenant.middleware';
import { verifyToken } from '../middleware/auth.middleware';
import { asyncHandler, BadRequestError } from '../middleware/error-handler';
import { sendSuccess, sendCreated } from '../utils/response';
import { emitToSession, emitToTenantAgents } from '../websocket/socket.handler';
import {
  emitConversationUpsertForSession,
  emitMessageCreatedForSession,
} from '../realtime/conversation-events';
import { routeOutboundMessage } from '../channels/outbound-router';
import { MAX_MESSAGE_CONTENT_CHARS } from '../guardrails/classify';
import { conversationCommands } from '../services/conversation-command.service';

const router = Router();

/** Pass widget-token requests through to the legacy widget close route in
 *  chat.routes (same mount). Anything else is treated as an operator command. */
function forwardWidgetTokens(req: Request, _res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) {
    try {
      const payload = verifyToken(header.substring(7));
      if (payload.type === 'widget') return next('router');
    } catch {
      // Not a local widget JWT (e.g. a Clerk token) — operator path.
    }
  }
  next();
}

const agentAuth = [requireClerkAuth, autoProvision, resolveTenantContext, validateTenant] as const;

function requireIdempotencyKey(body: unknown): string {
  const key = (body as { idempotencyKey?: unknown })?.idempotencyKey;
  if (typeof key !== 'string' || !key.trim() || key.length > 128) {
    throw new BadRequestError('idempotencyKey is required (max 128 chars)');
  }
  return key;
}

/**
 * Backward-compat variant for the routes the SHIPPED portal already posts to
 * with an empty body (Inbox.tsx: /takeover, /close, /release). Absent key ⇒
 * the command executes non-idempotently (transactional state change only, no
 * conversation_commands replay row). New clients (PR 3) always send a key.
 */
function optionalIdempotencyKey(body: unknown): string | undefined {
  const key = (body as { idempotencyKey?: unknown })?.idempotencyKey;
  if (key === undefined || key === null) return undefined;
  if (typeof key !== 'string' || !key.trim() || key.length > 128) {
    throw new BadRequestError('idempotencyKey must be a non-empty string (max 128 chars)');
  }
  return key;
}

/**
 * POST /chats/:sessionId/takeover
 * Claim the conversation for the calling operator. Only `mode: "indefinite"` is
 * exposed: the timed-expiry worker ships in PR 5, and a timed control that can
 * never expire must not exist (codex-locked ordering).
 *
 * Backward compat (B2 fix): the SHIPPED portal posts here with an EMPTY body
 * (Inbox.tsx:198), so key and mode are optional — absent mode defaults to
 * 'indefinite', absent key executes non-idempotently.
 */
router.post(
  '/:sessionId/takeover',
  ...agentAuth,
  asyncHandler(async (req: TenantRequest, res: Response) => {
    const idempotencyKey = optionalIdempotencyKey(req.body);
    const { mode = 'indefinite', hours } = req.body as { mode?: string; hours?: number };

    if (mode !== 'indefinite' && mode !== 'timed') {
      throw new BadRequestError("mode must be 'indefinite' or 'timed'");
    }
    if (mode === 'timed') {
      throw new BadRequestError(
        'Timed takeover is not available yet',
        { code: 'timed_takeover_not_available', hours },
      );
    }

    const result = await conversationCommands.claimConversation(
      req.params.sessionId,
      req.user!.id,
      { mode: 'indefinite' },
      idempotencyKey,
      { tenantId: req.tenant!.id },
    );

    if (result.outcome === 'claimed' && !result.replayed) {
      emitToSession(req.tenant!.id, req.params.sessionId, 'handoff:accepted', {
        sessionId: req.params.sessionId,
        agent: { id: req.user!.id },
        acceptedAt: new Date().toISOString(),
      });
      emitToTenantAgents(req.tenant!.id, 'handoff:assigned', {
        sessionId: req.params.sessionId,
        agentId: req.user!.id,
      });
      // B-PR3a: normalized ownership event to BOTH rooms, post-commit.
      await emitConversationUpsertForSession(req.params.sessionId, req.tenant!.id);
    }

    sendSuccess(res, { outcome: result.outcome, conversation: result.conversation });
  })
);

/**
 * POST /chats/:sessionId/release — HUMAN_OWNED -> BOT_OWNED by the assigned operator.
 * Key optional (B2 fix): the shipped portal posts here with an empty body (Inbox.tsx:289).
 */
router.post(
  '/:sessionId/release',
  ...agentAuth,
  asyncHandler(async (req: TenantRequest, res: Response) => {
    const idempotencyKey = optionalIdempotencyKey(req.body);
    const { reason } = req.body as { reason?: string };

    const result = await conversationCommands.releaseConversation(
      req.params.sessionId,
      req.user!.id,
      idempotencyKey,
      { tenantId: req.tenant!.id, reason },
    );

    if (result.outcome === 'released' && !result.replayed) {
      emitToSession(req.tenant!.id, req.params.sessionId, 'handoff:returned', {
        sessionId: req.params.sessionId,
        reason,
        returnedAt: new Date().toISOString(),
      });
      // B-PR3a: a release previously reached ONLY the session room — the
      // agents-room gap this PR closes.
      await emitConversationUpsertForSession(req.params.sessionId, req.tenant!.id);
    }

    sendSuccess(res, { outcome: result.outcome, conversation: result.conversation });
  })
);

/**
 * POST /chats/:sessionId/cancel — HANDOFF_REQUESTED -> BOT_OWNED (operator decline).
 */
router.post(
  '/:sessionId/cancel',
  ...agentAuth,
  asyncHandler(async (req: TenantRequest, res: Response) => {
    const idempotencyKey = requireIdempotencyKey(req.body);
    const { reason } = req.body as { reason?: string };

    const result = await conversationCommands.cancelHandoff(
      req.params.sessionId,
      { kind: 'agent', agentId: req.user!.id },
      idempotencyKey,
      { tenantId: req.tenant!.id, reason },
    );

    if (result.outcome === 'cancelled' && !result.replayed) {
      emitToTenantAgents(req.tenant!.id, 'handoff:rejected', {
        sessionId: req.params.sessionId,
        rejectedBy: req.user!.id,
        rejectedAt: new Date().toISOString(),
      });
      // B-PR3a: normalized ownership event to BOTH rooms, post-commit.
      await emitConversationUpsertForSession(req.params.sessionId, req.tenant!.id);
    }

    sendSuccess(res, { outcome: result.outcome, conversation: result.conversation });
  })
);

/**
 * POST /chats/:sessionId/close — any -> CLOSED (operator). Widget-token
 * requests fall through to the legacy widget close route.
 * Key optional (B2 fix): the shipped portal posts here with an empty body (Inbox.tsx:272).
 */
router.post(
  '/:sessionId/close',
  forwardWidgetTokens,
  ...agentAuth,
  asyncHandler(async (req: TenantRequest, res: Response) => {
    const idempotencyKey = optionalIdempotencyKey(req.body);
    const { reason } = req.body as { reason?: string };

    const result = await conversationCommands.closeConversation(
      req.params.sessionId,
      { kind: 'agent', agentId: req.user!.id },
      idempotencyKey,
      { tenantId: req.tenant!.id, reason },
    );

    if (result.outcome === 'closed' && !result.replayed) {
      emitToSession(req.tenant!.id, req.params.sessionId, 'session:closed', {
        sessionId: req.params.sessionId,
        endedAt: new Date().toISOString(),
        closedBy: 'agent',
      });
      // B-PR3a: a close previously reached ONLY the session room — the
      // agents-room gap this PR closes.
      await emitConversationUpsertForSession(req.params.sessionId, req.tenant!.id);
    }

    sendSuccess(res, { outcome: result.outcome, conversation: result.conversation });
  })
);

/**
 * POST /chats/:sessionId/messages — acknowledged operator reply (B2).
 * First reply auto-claims an unclaimed conversation in the same transaction;
 * a duplicate clientMessageId returns the original message; another operator's
 * ownership is a 409 (the client keeps the draft).
 */
router.post(
  '/:sessionId/messages',
  ...agentAuth,
  asyncHandler(async (req: TenantRequest, res: Response) => {
    const { clientMessageId, content } = req.body as { clientMessageId?: string; content?: string };
    if (typeof clientMessageId !== 'string' || !clientMessageId.trim()) {
      throw new BadRequestError('clientMessageId is required');
    }
    if (typeof content !== 'string' || !content.trim()) {
      throw new BadRequestError('content is required');
    }
    if (content.length > MAX_MESSAGE_CONTENT_CHARS) {
      throw new BadRequestError('Message too long');
    }

    const result = await conversationCommands.sendHumanMessage(
      req.params.sessionId,
      req.user!.id,
      clientMessageId,
      content,
      { tenantId: req.tenant!.id },
    );

    if (result.outcome === 'sent') {
      const sessionId = req.params.sessionId;
      const messageData = {
        id: result.message.id,
        sessionId,
        chatId: sessionId,
        type: 'text',
        content,
        status: 'sent',
        createdAt: result.message.createdAt,
        sender: 'agent',
        senderType: 'agent',
        timestamp: new Date().toISOString(),
      };
      emitToSession(req.tenant!.id, sessionId, 'message:receive', messageData);
      emitToTenantAgents(req.tenant!.id, 'message:new', { sessionId, message: messageData });
      if (result.autoClaimed) {
        emitToTenantAgents(req.tenant!.id, 'handoff:assigned', { sessionId, agentId: req.user!.id });
      }
      // B-PR3a: normalized events, post-commit. Only ids are in hand here —
      // the helper re-selects a fresh row (it also carries an auto-claim's
      // committed ownership) and is fail-safe END TO END: a DB hiccup on the
      // re-select or the emits is logged, never a 500 on a request whose
      // message already committed.
      await emitMessageCreatedForSession(sessionId, req.tenant!.id, {
        id: result.message.id,
        sessionId,
        type: 'text',
        content,
        senderType: 'agent',
        status: 'sent',
        createdAt: result.message.createdAt,
      });
      // External channels get the reply post-commit (mirrors the socket path,
      // including Meta's HUMAN_AGENT tag). Failure is logged, never a rollback:
      // the persisted message is the source of truth; PR 3 surfaces per-message
      // delivery state.
      if (result.conversation && (await isExternalChannel(sessionId, req.tenant!.id))) {
        routeOutboundMessage(
          { type: 'text', content },
          { sessionId, tenantId: req.tenant!.id, messageId: result.message.id },
          undefined, // WebSocket already emitted above
          { humanAgent: true },
        ).catch((err) => {
          logger.error('Error routing operator reply to external channel:', err);
        });
      }
    }

    sendCreated(res, {
      outcome: result.outcome,
      autoClaimed: result.autoClaimed,
      message: result.message,
      conversation: result.conversation,
    });
  })
);

/** Widget sessions deliver over the socket only; everything else goes through
 *  the outbound router. Read once post-commit. */
async function isExternalChannel(sessionId: string, tenantId: string): Promise<boolean> {
  const { AppDataSource } = await import('../database/data-source');
  const rows = (await AppDataSource.query(
    `SELECT channel FROM chat_sessions WHERE id = $1 AND tenant_id = $2`,
    [sessionId, tenantId],
  )) as Array<{ channel: string | null }>;
  return !!rows[0]?.channel && rows[0].channel !== 'widget';
}

export default router;
