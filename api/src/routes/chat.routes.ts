/**
 * Chat Routes
 * GET /chat/:sessionId/history - Get message history
 * POST /chat/:sessionId/message - Send message via HTTP
 * GET /chat/:sessionId/status - Get session status
 * POST /chat/:sessionId/close - Close session
 */
import crypto from 'crypto';
import { Router, Request, Response } from 'express';
import { IsNull, DeepPartial, Brackets } from 'typeorm';
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
import { scheduleTurn } from '../services/turn-coalescer';
import { conversationCommands } from '../services/conversation-command.service';
import { encrypt, decrypt, DecryptionError } from '../utils/encryption';
import { parsePaginationParams, applyPagination } from '../utils/pagination';
import { asyncHandler, BadRequestError, NotFoundError, ForbiddenError } from '../middleware/error-handler';

/**
 * Widget tokens are bound to exactly one session (req.widget.sessionId). Enforce
 * that the URL :sessionId matches the token's session — otherwise a visitor could
 * read/post on another visitor's session within the same tenant. Fail closed if
 * the token carries no sessionId. See security audit #G.
 */
export function requireWidgetSessionMatch(req: import('express').Request, _res: import('express').Response, next: import('express').NextFunction): void {
  const tokenSessionId = (req as { widget?: { sessionId?: string } }).widget?.sessionId;
  if (!tokenSessionId || tokenSessionId !== req.params.sessionId) {
    return next(new ForbiddenError('Session does not match the widget token'));
  }
  next();
}
import { validate } from '../middleware/validate';
import { sendSuccess, sendPaginated, sendCreated } from '../utils/response';
import { sendMessageSchema, chatListQuerySchema } from '../schemas';
import { emitWebhookEvent } from '../webhooks/webhook.emitter';
import {
  serializeConversationSummary,
  previewFromRaw,
  computeCustomerThreadId,
  type CustomerThreadBinding,
} from '../realtime/conversation-serializer';
import { ConversationBinding } from '../database/entities/ConversationBinding';
import {
  emitConversationUpsert,
  emitConversationUpsertForSession,
  emitMessageCreated,
} from '../realtime/conversation-events';

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
  requireWidgetSessionMatch,
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
  requireWidgetSessionMatch,
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

    // Resolve the participant ID — for widget users, look up by session
    let resolvedParticipantId = user?.id || 'anonymous';
    if (user?.type === 'widget') {
      const participantRepo = AppDataSource.getRepository(Participant);
      const userParticipant = await participantRepo.findOne({
        where: { sessionId, type: 'user', isDeleted: false },
      });
      if (userParticipant) {
        resolvedParticipantId = userParticipant.id;
      }
    }

    // Save message + update session in a single transaction
    const message = messageRepository.create({
      sessionId,
      tenantId: tenantId!,
      participantId: resolvedParticipantId,
      type,
      content: messageContent,
      contentEncrypted: true,
      metadata: metadata || undefined,
    } as DeepPartial<Message>);

    const savedMessage = await AppDataSource.transaction(async (manager) => {
      const msg = await manager.save(message);
      // Targeted UPDATE, never save(session): a full-entity write from this
      // stale copy would revert a human takeover that committed since the load
      // (B-PR2b fix B1).
      session.updateActivity(); // keep the in-memory copy for the response
      await manager.query(
        `UPDATE chat_sessions SET last_activity_at = now() WHERE id = $1`,
        [session.id],
      );
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

    // B-PR3a: the normalized events, alongside the legacy emit (additive).
    emitMessageCreated(session, {
      id: savedMessage.id,
      sessionId,
      type: savedMessage.type,
      content: plainContent,
      senderType: 'user',
      status: savedMessage.status,
      createdAt: savedMessage.createdAt,
    });
    await emitConversationUpsert(session, {
      lastMessage: { content: plainContent, senderType: 'user' },
    });

    scheduleTurn(session, savedMessage).catch((err) => {
      logger.error('Error scheduling turn:', err);
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
  requireWidgetSessionMatch,
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
  requireWidgetSessionMatch,
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

    // Ownership write goes through the ONE command service (B-PR2b): status +
    // ownership + version + the open handoff's closure + the system event move
    // in one transaction. (The old inline system message wrote
    // participant_id='system' — an invalid uuid — and never landed.)
    const result = await conversationCommands.closeConversation(
      sessionId,
      { kind: 'customer' },
      undefined,
      { tenantId, reason },
    );
    const endedAt = new Date();

    // Fire conversation.ended webhook — non-blocking, errors handled internally
    emitWebhookEvent({
      id: crypto.randomUUID(),
      type: 'conversation.ended',
      tenantId: session.tenantId,
      sessionId: session.id,
      timestamp: new Date().toISOString(),
      session: {
        channel: session.channel || 'widget',
        visitorId: session.visitorId,
        startedAt: session.startedAt?.toISOString() || session.createdAt.toISOString(),
        messageCount: session.messageCount || 0,
      },
      conversation: {
        durationSeconds: session.startedAt
          ? Math.floor((endedAt.getTime() - session.startedAt.getTime()) / 1000)
          : null,
        messageCount: session.messageCount || 0,
        finalStatus: 'closed',
        assignedAgentId: session.assignedAgentId || undefined,
      },
    });

    // Notify via WebSocket
    emitToSession(tenantId!, sessionId, 'session:closed', {
      sessionId,
      reason,
      endedAt,
    });

    // B-PR3a: normalized lifecycle event to BOTH rooms (the legacy
    // session:closed only reached the session room). Fresh re-select — the
    // in-hand entity predates the close.
    await emitConversationUpsertForSession(sessionId, tenantId);

    logger.info(`Session ${sessionId} closed`, { reason });

    sendSuccess(res, {
      message: 'Session closed successfully',
      session: {
        id: result.conversation.sessionId,
        status: result.conversation.status,
        endedAt,
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

    if (status && ['active', 'closed', 'waiting', 'handoff', 'bot'].includes(status)) {
      qb.andWhere('session.status = :status', { status });
    }

    // Surface guardrail-paused conversations: AI was disabled by a guardrail
    // (auto-pause keeps status='bot', so these are otherwise indistinguishable
    // from a healthy bot conversation in the inbox).
    if (req.query.aiPaused === 'true') {
      qb.andWhere('session.aiAutoReplyEnabled = false');
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
        lastMessages[row.session_id] = previewFromRaw({
          id: row.id,
          content: row.content,
          encrypted: row.encrypted,
          senderType: row.sender_type,
        });
      }
    }

    // customerThreadId (B-PR4a): external sessions need their binding row for
    // the e:{connection}:{user}:{thread} key. One batch query for the page's
    // non-widget rows; widget rows compute the key from the session alone.
    const bindings: Record<string, CustomerThreadBinding> = {};
    const externalIds = result.data.filter((s) => s.source !== 'widget').map((s) => s.id);
    if (externalIds.length > 0) {
      const rows = await AppDataSource.getRepository(ConversationBinding)
        .createQueryBuilder('b')
        .where('b.sessionId IN (:...ids)', { ids: externalIds })
        .orderBy('b.createdAt', 'ASC')
        .getMany();
      // ASC + overwrite ⇒ the NEWEST binding wins, matching conversation-events.
      for (const b of rows) {
        bindings[b.sessionId] = {
          channelConnectionId: b.channelConnectionId,
          externalUserId: b.externalUserId,
          externalThreadId: b.externalThreadId,
        };
      }
    }

    // ONE mapper for this row and the conversation:upsert socket payload
    // (B-PR3a): the shapes cannot diverge because they are the same code.
    sendPaginated(
      res,
      result.data.map((s) =>
        serializeConversationSummary(s, {
          lastMessage: lastMessages[s.id] ?? null,
          binding: bindings[s.id] ?? null,
        }),
      ),
      result.meta
    );
  })
);

// ---------------------------------------------------------------------------
// B-PR4b §1 - one-customer thread (read-only). NEVER merges rows.
// ---------------------------------------------------------------------------

/** Prior sessions returned per thread (the NEWEST are kept); more ⇒ `truncated`. */
export const THREAD_PRIOR_SESSION_CAP = 20;
/** Per-session message page - the same size the detail GET serves. */
const THREAD_MESSAGES_PER_SESSION = 50;
/** Cap on the weaker-signal possible-duplicates audit list. */
const THREAD_DUPLICATE_CAP = 10;

/**
 * The customer identity a thread groups on. Mirrors computeCustomerThreadId
 * (B-PR4a): widget identity lives on the session row; external identity is the
 * conversation_bindings triple. `session` = unresolvable (an external session
 * with no binding row and no identity facts on the row) - the thread is then
 * just the one session, per spec.
 */
type ThreadIdentity =
  | { kind: 'widget'; botId: string; visitorId: string }
  | { kind: 'external'; binding: CustomerThreadBinding }
  | { kind: 'session' };

/**
 * Resolve the selected session's customer identity.
 *
 * External note: the inbound pipeline REASSIGNS the binding row to the new
 * session when a closed conversation reopens (findOrCreateConversation), so
 * only the newest session of an external customer still holds a binding. When
 * the selected session lost its binding that way, fall back to the identity
 * facts the pipeline stamps on every session row it creates:
 * channelConnectionId + visitorId(=externalUserId) +
 * metadata.customData.externalThreadId.
 */
async function resolveThreadIdentity(session: ChatSession): Promise<ThreadIdentity> {
  if (session.source === 'widget') {
    if (!session.visitorId) return { kind: 'session' };
    return { kind: 'widget', botId: session.botId, visitorId: session.visitorId };
  }
  const binding = await AppDataSource.getRepository(ConversationBinding).findOne({
    where: { sessionId: session.id },
    order: { createdAt: 'DESC' },
  });
  const metaThreadId = session.metadata?.customData?.externalThreadId;
  const candidate: CustomerThreadBinding | null = binding
    ? {
        channelConnectionId: binding.channelConnectionId,
        externalUserId: binding.externalUserId,
        externalThreadId: binding.externalThreadId,
      }
    : session.channelConnectionId && session.visitorId && typeof metaThreadId === 'string'
      ? {
          channelConnectionId: session.channelConnectionId,
          externalUserId: session.visitorId,
          externalThreadId: metaThreadId,
        }
      : null;
  // An INCOMPLETE identity must degrade to the one-session fallback, never to
  // a `= ''`/`= NULL` match that silently drops related sessions and
  // mis-classifies them as possibleDuplicates.
  if (
    !candidate ||
    !candidate.channelConnectionId ||
    !candidate.externalUserId ||
    !candidate.externalThreadId
  ) {
    return { kind: 'session' };
  }
  return { kind: 'external', binding: candidate };
}

/** The `(started_at, id)` SQL of the conversation_bindings identity-triple
 *  subquery, shared by the thread query and the duplicates exclusion. Params:
 *  :bcc / :beu / :bet. */
function bindingTripleSubQuery(): string {
  return AppDataSource.getRepository(ConversationBinding)
    .createQueryBuilder('b')
    .select('b.sessionId')
    .where('b.channelConnectionId = :bcc')
    .andWhere('b.externalUserId = :beu')
    .andWhere('b.externalThreadId = :bet')
    .getQuery();
}

/**
 * The sessions sharing the identity that are STRICTLY OLDER than the selected
 * one - TENANT-SCOPED on every branch. The strict `(started_at, id)` cut means
 * a NEWER (possibly still ACTIVE) session of the same identity can never
 * render as read-only "earlier history" above an old selected session; the
 * timeline always ends at the selected session's live thread.
 *
 * widget:   same (tenant_id, bot_id, visitor_id) AND source='widget' - the
 *           exact predicate of the B-PR4a partial unique index.
 * external: the binding triple (matches the CURRENTLY-bound session) OR the
 *           identity facts stamped on the row (matches PRIOR sessions whose
 *           binding was reassigned on reopen). The strict externalThreadId
 *           equality keeps e.g. a Telegram group chat out of the same user's
 *           DM thread. Legacy rows missing the metadata fall out of the strict
 *           thread and surface via possibleDuplicates instead.
 */
function threadSessionsQuery(
  tenantId: string,
  identity: Exclude<ThreadIdentity, { kind: 'session' }>,
  selected: ChatSession,
) {
  const qb = sessionRepository
    .createQueryBuilder('s')
    .leftJoinAndSelect('s.assignedAgent', 'agent')
    .where('s.tenantId = :tenantId', { tenantId })
    // Strictly older than the selected session (row-value comparison, id
    // tie-break) - never the selected row itself, never a newer sibling.
    .andWhere('(s.startedAt, s.id) < (:selStartedAt, :selId)', {
      selStartedAt: selected.startedAt ?? selected.createdAt,
      selId: selected.id,
    });

  if (identity.kind === 'widget') {
    return qb
      .andWhere("s.source = 'widget'")
      .andWhere('s.botId = :botId', { botId: identity.botId })
      .andWhere('s.visitorId = :visitorId', { visitorId: identity.visitorId });
  }

  return qb
    .andWhere("s.source <> 'widget'")
    .andWhere(
      new Brackets((w) => {
        w.where(`s.id IN (${bindingTripleSubQuery()})`).orWhere(
          `(s.channelConnectionId = :bcc AND s.visitorId = :beu AND s.metadata -> 'customData' ->> 'externalThreadId' = :bet)`,
        );
      }),
    )
    .setParameters({
      bcc: identity.binding.channelConnectionId,
      beu: identity.binding.externalUserId,
      bet: identity.binding.externalThreadId,
    });
}

/**
 * Weaker-signal sessions an operator should eyeball but the thread must NOT
 * absorb: the same widget visitor on a DIFFERENT bot, or the same external
 * user on the connection OUTSIDE the strict identity (another
 * externalThreadId, or a legacy row missing the thread facts). The exclusion
 * is the WHOLE identity - not just the rows the (older-than-selected, capped)
 * thread returned - so a newer sibling of the same identity is never
 * mis-classified as a duplicate. Read-only; never auto-merged.
 */
async function findPossibleDuplicates(
  tenantId: string,
  session: ChatSession,
  identity: ThreadIdentity,
): Promise<ChatSession[]> {
  if (identity.kind === 'widget') {
    return sessionRepository
      .createQueryBuilder('s')
      .leftJoinAndSelect('s.assignedAgent', 'agent')
      .where('s.tenantId = :tenantId', { tenantId })
      .andWhere("s.source = 'widget'")
      .andWhere('s.visitorId = :visitorId', { visitorId: identity.visitorId })
      .andWhere('s.botId != :botId', { botId: identity.botId })
      .orderBy('s.lastActivityAt', 'DESC')
      .take(THREAD_DUPLICATE_CAP)
      .getMany();
  }
  // External (resolved or fallback): same user on the same connection. Works
  // even when the strict triple could not be resolved - exactly the legacy
  // scatter the audit exists for.
  const channelConnectionId =
    identity.kind === 'external'
      ? identity.binding.channelConnectionId
      : session.channelConnectionId;
  const externalUserId =
    identity.kind === 'external' ? identity.binding.externalUserId : session.visitorId;
  if (!channelConnectionId || !externalUserId) return [];
  const qb = sessionRepository
    .createQueryBuilder('s')
    .leftJoinAndSelect('s.assignedAgent', 'agent')
    .where('s.tenantId = :tenantId', { tenantId })
    .andWhere("s.source <> 'widget'")
    .andWhere('s.channelConnectionId = :cc', { cc: channelConnectionId })
    .andWhere('s.visitorId = :eu', { eu: externalUserId });
  if (identity.kind === 'external') {
    // Exclude every session of the strict identity (bound to the triple OR
    // stamped with its externalThreadId), whatever its age.
    qb.andWhere(`s.id NOT IN (${bindingTripleSubQuery()})`)
      .andWhere(
        `s.metadata -> 'customData' ->> 'externalThreadId' IS DISTINCT FROM :bet`,
      )
      .setParameters({
        bcc: identity.binding.channelConnectionId,
        beu: identity.binding.externalUserId,
        bet: identity.binding.externalThreadId,
      });
  } else {
    // Unresolvable identity ('session' fallback): everything but itself.
    qb.andWhere('s.id != :selfId', { selfId: session.id });
  }
  return qb.orderBy('s.lastActivityAt', 'DESC').take(THREAD_DUPLICATE_CAP).getMany();
}

/** Same per-message shape the detail GET serves (serialiseMessage + the
 *  participant facts), plus sessionId so a multi-session payload stays
 *  attributable to its boundary block. */
function serialiseThreadMessage(m: Message) {
  return {
    ...serialiseMessage(m),
    sessionId: m.sessionId,
    sender: m.participant?.type ?? 'user',
    senderName: m.participant?.name ?? 'Unknown',
    participantId: m.participantId,
  };
}

/** The boundary label facts for one thread block. */
function threadBoundary(row: ChatSession) {
  return {
    startedAt: row.startedAt ?? row.createdAt,
    endedAt: row.endedAt ?? null,
    status: row.status,
  };
}

/**
 * GET /chat/:sessionId/thread  (agent endpoint, read-only)
 *
 * The selected session's customer thread UP TO the selected session: the
 * strictly-older sessions sharing its identity, oldest→newest, each with its
 * messages + a boundary label, ending at the selected session (isCurrent) -
 * a newer sibling never renders as read-only history. Plus a
 * possibleDuplicates audit list of weaker-signal sessions. Rows are never
 * physically merged. Prior sessions are capped (newest THREAD_PRIOR_SESSION_CAP);
 * `truncated` signals the cut.
 */
router.get(
  '/:sessionId/thread',
  requireClerkAuth, autoProvision, resolveTenantContext,
  asyncHandler(async (req: Request, res: Response) => {
    const { sessionId } = req.params;
    const tenantId = req.user?.tenantId;

    const session = await sessionRepository.findOne({
      where: { id: sessionId, tenantId },
      relations: ['assignedAgent'],
    });
    if (!session) {
      throw new NotFoundError('Session not found');
    }

    const identity = await resolveThreadIdentity(session);

    // 1. The prior sessions: STRICTLY OLDER identity-siblings only (newest
    // THREAD_PRIOR_SESSION_CAP of them), then the selected session last. A
    // newer - possibly still active - sibling is never part of this history.
    let rows: ChatSession[] = [session];
    let totalSessions = 1;
    if (identity.kind !== 'session') {
      const [olderDesc, olderTotal] = await threadSessionsQuery(tenantId!, identity, session)
        .orderBy('s.startedAt', 'DESC')
        .addOrderBy('s.id', 'DESC')
        .take(THREAD_PRIOR_SESSION_CAP)
        .getManyAndCount();
      totalSessions = olderTotal + 1; // priors + the selected session
      rows = [...olderDesc, session];
      const startedMs = (r: ChatSession) => new Date(r.startedAt ?? r.createdAt).getTime();
      rows.sort((a, b) => startedMs(a) - startedMs(b) || a.id.localeCompare(b.id));
    }
    const truncated = totalSessions > rows.length;

    // 2. Messages for every returned session in ONE round trip, capped per
    // session via a window function (no per-session N+1), then hydrated as
    // entities so the decrypt/serialize path is byte-for-byte the detail GET's.
    const rowIds = rows.map((r) => r.id);
    // Defense-in-depth: BOTH message queries are tenant-scoped too, so this
    // decrypt-and-return path across up to 21 sessions can never surface a
    // mis-associated cross-tenant message row.
    const cappedIdRows = (await AppDataSource.query(
      `SELECT id FROM (
         SELECT m.id, ROW_NUMBER() OVER (
           PARTITION BY m.session_id ORDER BY m.created_at DESC, m.id DESC
         ) AS rn
         FROM messages m
         WHERE m.session_id = ANY($1::uuid[])
           AND m.tenant_id = $3
       ) ranked
       WHERE rn <= $2`,
      [rowIds, THREAD_MESSAGES_PER_SESSION, tenantId],
    )) as Array<{ id: string }>;

    const messagesBySession = new Map<string, ReturnType<typeof serialiseThreadMessage>[]>();
    if (cappedIdRows.length > 0) {
      const msgs = await messageRepository
        .createQueryBuilder('m')
        .leftJoinAndSelect('m.participant', 'p')
        .where('m.id IN (:...mids)', { mids: cappedIdRows.map((r) => r.id) })
        .andWhere('m.tenantId = :tenantId', { tenantId })
        .orderBy('m.createdAt', 'ASC')
        .addOrderBy('m.id', 'ASC')
        .getMany();
      for (const m of msgs) {
        const list = messagesBySession.get(m.sessionId) ?? [];
        list.push(serialiseThreadMessage(m));
        messagesBySession.set(m.sessionId, list);
      }
    }

    // 3. Serialize. Every session in an external thread shares the resolved
    // binding facts - by construction they are the same customer identity, so
    // the summaries agree on one customerThreadId even for prior sessions
    // whose binding row was reassigned.
    const threadBinding = identity.kind === 'external' ? identity.binding : null;
    const sessions = rows.map((row) => {
      const msgs = messagesBySession.get(row.id) ?? [];
      const last = msgs.length > 0 ? msgs[msgs.length - 1] : null;
      return {
        summary: serializeConversationSummary(row, {
          lastMessage: last ? { content: last.content, senderType: last.sender } : null,
          binding: threadBinding,
        }),
        boundary: threadBoundary(row),
        isCurrent: row.id === session.id,
        messages: msgs,
      };
    });

    // 4. The weaker-signal audit list. These are a DIFFERENT identity by
    // definition, so their customerThreadId comes from their OWN binding
    // (batch-fetched like the list route), never from the thread's.
    const duplicates = await findPossibleDuplicates(tenantId!, session, identity);
    const dupBindings: Record<string, CustomerThreadBinding> = {};
    const dupExternalIds = duplicates.filter((d) => d.source !== 'widget').map((d) => d.id);
    if (dupExternalIds.length > 0) {
      const bindingRows = await AppDataSource.getRepository(ConversationBinding)
        .createQueryBuilder('b')
        .where('b.sessionId IN (:...ids)', { ids: dupExternalIds })
        .orderBy('b.createdAt', 'ASC')
        .getMany();
      for (const b of bindingRows) {
        dupBindings[b.sessionId] = {
          channelConnectionId: b.channelConnectionId,
          externalUserId: b.externalUserId,
          externalThreadId: b.externalThreadId,
        };
      }
    }
    const possibleDuplicates = duplicates.map((d) => ({
      summary: serializeConversationSummary(d, { binding: dupBindings[d.id] ?? null }),
      boundary: threadBoundary(d),
    }));

    sendSuccess(res, {
      sessionId: session.id,
      customerThreadId: computeCustomerThreadId(session, threadBinding),
      identity: identity.kind,
      totalSessions,
      truncated,
      sessions,
      possibleDuplicates,
    });
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

    const tenantId = req.user?.tenantId;

    // Run session + messages queries in parallel to halve latency
    const [session, messages] = await Promise.all([
      sessionRepository.findOne({
        where: { id, tenantId },
        relations: ['assignedAgent'],
      }),
      messageRepository
        .createQueryBuilder('m')
        .leftJoinAndSelect('m.participant', 'p')
        .where('m.sessionId = :id', { id })
        .orderBy('m.createdAt', 'DESC')
        .take(50)
        .getMany(),
    ]);

    if (!session) {
      throw new NotFoundError('Session not found');
    }

    sendSuccess(res, {
      id: session.id,
      sessionId: session.id,
      tenantId: session.tenantId,
      status: session.status,
      // Guardrail state so the inbox can show "AI paused by guardrail" + a
      // resume action — a guardrail pause keeps status='bot' but sets
      // aiAutoReplyEnabled=false, which is otherwise invisible to operators.
      aiAutoReplyEnabled: session.aiAutoReplyEnabled,
      guardrailStatus: session.guardrailStatus,
      visitorId: session.visitorId,
      assignedAgentId: session.assignedAgentId,
      assignedAgentName: session.assignedAgent?.userId ?? null,
      // Ownership + human-control facts so a deep-linked (GET-first) timed chat
      // renders the "AI paused - resumes in ..." countdown immediately, not only
      // after the first socket upsert. Same shape the list row + upsert emit.
      ownership: session.ownership,
      ownershipVersion: session.ownershipVersion,
      humanControlMode: session.humanControlMode ?? null,
      humanControlDurationHours: session.humanControlDurationHours ?? null,
      humanControlUntil: session.humanControlUntil
        ? new Date(session.humanControlUntil).toISOString()
        : null,
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

    // Verify target agent exists AND belongs to the caller's tenant — otherwise
    // a session could be assigned to a foreign-tenant agent. See security audit #H.
    const targetAgent = await agentRepository.findOne({
      where: { id: targetAgentId, tenantId: req.user?.tenantId },
    });

    if (!targetAgent) {
      throw new NotFoundError('Target agent not found');
    }

    // Ownership write goes through the ONE command service (B-PR2b): the
    // reassignment, the derived legacy status, the version bump and the open
    // handoff's accept move in one transaction.
    const result = await conversationCommands.transferConversation(
      id,
      targetAgentId,
      undefined,
      { tenantId: req.user?.tenantId },
    );

    // B-PR3a: normalized ownership event to BOTH rooms, post-commit.
    await emitConversationUpsertForSession(id, req.user?.tenantId);

    logger.info(`Session ${id} transferred to agent ${targetAgentId}`);

    sendSuccess(res, {
      message: 'Session transferred',
      session: {
        id: result.conversation.sessionId,
        status: result.conversation.status,
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

    // Ownership write goes through the ONE command service (B-PR2b).
    const result = await conversationCommands.closeConversation(
      id,
      { kind: 'agent', agentId: req.user!.id },
      undefined,
      { tenantId: req.user?.tenantId },
    );
    session.status = result.conversation.status;
    session.endedAt = new Date();

    emitToSession(req.user?.tenantId!, id, 'session:closed', {
      sessionId: id,
      endedAt: session.endedAt,
      closedBy: 'agent',
    });

    // B-PR3a: normalized lifecycle event to BOTH rooms, post-commit.
    await emitConversationUpsertForSession(id, req.user?.tenantId);

    // Fire conversation.ended webhook — non-blocking, errors handled internally
    emitWebhookEvent({
      id: crypto.randomUUID(),
      type: 'conversation.ended',
      tenantId: session.tenantId,
      sessionId: session.id,
      timestamp: new Date().toISOString(),
      session: {
        channel: session.channel || 'widget',
        visitorId: session.visitorId,
        startedAt: session.startedAt?.toISOString() || session.createdAt.toISOString(),
        messageCount: session.messageCount || 0,
      },
      conversation: {
        durationSeconds: session.durationSeconds || null,
        messageCount: session.messageCount || 0,
        finalStatus: 'closed',
        assignedAgentId: session.assignedAgentId || undefined,
      },
    });

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
