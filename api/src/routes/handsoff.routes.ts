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
import { HandoffRequest } from '../database/entities/HandoffRequest';
import { logger } from '../utils/logger';
import { authenticateWidget } from '../middleware/auth.middleware';
import { requireClerkAuth, autoProvision } from '../middleware/clerk.middleware';
import { resolveTenantContext } from '../middleware/super-admin.middleware';
import { validateTenant, TenantRequest } from '../middleware/tenant.middleware';
import { rateLimit } from '../middleware/rate-limit.middleware';
import { emitToSession, emitToTenantAgents } from '../websocket/socket.handler';
import { emitConversationUpsertForSession } from '../realtime/conversation-events';
import { parsePaginationParams, applyPagination } from '../utils/pagination';
import { asyncHandler, BadRequestError, NotFoundError, ForbiddenError } from '../middleware/error-handler';
import { validate } from '../middleware/validate';
import { sendSuccess } from '../utils/response';
import { requestHandoffSchema } from '../schemas';
import { requireFeature } from '../billing/enforce';
import { redisLoopStore } from '../guardrails/loop-store';
import { conversationCommands } from '../services/conversation-command.service';
import { deliverHandoffNotification } from '../notifications/notification-outbox.worker';

const router = Router();
const sessionRepository = AppDataSource.getRepository(ChatSession);
const messageRepository = AppDataSource.getRepository(Message);
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
    if (!tenantId) {
      throw new BadRequestError('Tenant context required');
    }
    // Plan-gate (step 10, feature 6). Throws 402 plan_limit_handoff when the
    // tenant's tier doesn't include human handoff (currently Free).
    await requireFeature(tenantId, 'handoff', 'plan_limit_handoff');

    // Find session (parity pre-checks; the command service re-validates under lock)
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

    // The ONE transactional handoff-creation path (B6): ownership + legacy
    // status + the open HandoffRequest row + the system event move together.
    const result = await conversationCommands.requestHandoff(
      sessionId,
      'user_request',
      'widget',
      undefined,
      { tenantId, note: reason || 'User requested human assistance', notify: true },
    );
    if (result.outcome === 'handoff_disabled') {
      throw new BadRequestError('Human handoff is not enabled for this assistant');
    }
    session.status = result.conversation.status;

    // Display-only free-text reason for the inbox list (not ownership state).
    // DB-side jsonb merge — spreading the in-memory copy would persist a stale
    // metadata snapshot loaded before the command ran.
    await sessionRepository.query(
      `UPDATE chat_sessions SET metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb WHERE id = $1`,
      [sessionId, JSON.stringify({ handoffReason: reason || 'User requested' })],
    );

    // Notify agents via WebSocket
    emitToTenantAgents(tenantId!, 'handoff:requested', {
      sessionId,
      handoffId: result.handoffId,
      reason: reason || 'User requested',
      requestedAt: new Date().toISOString(),
    });

    // Notify session
    emitToSession(tenantId!, sessionId, 'handoff:pending', {
      sessionId,
      status: 'handoff',
      message: 'Waiting for an agent to join...',
    });

    // B-PR3a: normalized ownership event, post-commit, when the state moved.
    if (result.outcome === 'requested') {
      await emitConversationUpsertForSession(sessionId, tenantId);
      void deliverHandoffNotification({
        tenantId: tenantId!,
        handoffId: result.handoffId!,
        sessionId,
        reason: 'user_request',
        requestedAt: new Date(),
      }).catch((error) => {
        logger.warn('Handoff notification backstop failed', {
          tenantId: tenantId!,
          sessionId,
          handoffId: result.handoffId!,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }

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

    // Find session (parity pre-check; the command service re-validates under lock)
    const session = await sessionRepository.findOne({
      where: { id: sessionId, tenantId },
    });

    if (!session) {
      throw new NotFoundError('Session not found');
    }

    if (session.status !== 'handoff') {
      throw new BadRequestError('Session is not pending handoff');
    }

    // One transactional claim: session lock + open-handoff accept + assignment +
    // agent chat-count + the single system event. Two concurrent accepts yield
    // one winner and one `conversation_already_claimed` 409.
    const result = await conversationCommands.claimConversation(
      sessionId,
      agent!.id,
      { mode: 'indefinite' },
      undefined,
      { tenantId },
    );

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

    // B-PR3a: normalized ownership event to BOTH rooms, post-commit.
    await emitConversationUpsertForSession(sessionId, tenantId);

    logger.info(`Handoff accepted for session ${sessionId}`, {
      agentId: agent!.id,
    });

    sendSuccess(res, {
      message: 'Handoff accepted',
      session: {
        id: result.conversation.sessionId,
        status: result.conversation.status,
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
    const { sessionId, reason } = req.body;

    if (!sessionId) {
      throw new BadRequestError('Session ID is required');
    }

    // An operator decline is an ATOMIC HANDOFF_REQUESTED -> BOT_OWNED transition
    // (plan B1: the old handler only broadcast, so the state never moved back and
    // the customer sat in a queue nobody was going to serve).
    const result = await conversationCommands.cancelHandoff(
      sessionId,
      { kind: 'agent', agentId: agent!.id },
      undefined,
      { tenantId, reason },
    );

    emitToTenantAgents(tenantId!, 'handoff:rejected', {
      sessionId,
      rejectedBy: agent!.id,
      rejectedAt: new Date().toISOString(),
    });

    // B-PR3a: normalized ownership event, post-commit, when the state moved.
    if (result.outcome === 'cancelled') {
      await emitConversationUpsertForSession(sessionId, tenantId);
    }

    logger.info(`Handoff rejected for session ${sessionId}`, {
      agentId: agent!.id,
    });

    sendSuccess(res, {
      message: 'Handoff rejected',
      session: { id: sessionId, status: result.conversation.status },
    });
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

    // One transactional release: HUMAN_OWNED -> BOT_OWNED, assignment +
    // human-control cleared, the accepted handoff completed, one system event.
    // Ownership (not the legacy 'active' status) is the authority on who may
    // release; the service 403s a non-assigned agent.
    const result = await conversationCommands.releaseConversation(
      sessionId,
      agent!.id,
      undefined,
      { tenantId, reason },
    );

    // Notify session
    emitToSession(tenantId!, sessionId, 'handoff:returned', {
      sessionId,
      reason,
      returnedAt: new Date().toISOString(),
    });

    // B-PR3a: a return/release previously reached ONLY the session room — the
    // agents-room gap this PR closes. Emit when the state moved.
    if (result.outcome === 'released') {
      await emitConversationUpsertForSession(sessionId, tenantId);
    }

    logger.info(`Session ${sessionId} returned to bot`, {
      agentId: agent!.id,
      reason,
    });

    sendSuccess(res, {
      message: 'Session returned to bot',
      session: {
        id: result.conversation.sessionId,
        status: result.conversation.status,
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
      .andWhere('session.status = :status', { status: 'handoff' })
      // A CLAIMED conversation keeps legacy status 'handoff' (human_owned maps
      // there), so "pending" must key on ownership or accepted chats would
      // reappear in the queue.
      .andWhere('session.ownership = :ownership', { ownership: 'handoff_requested' });

    if (!params.sortBy) {
      qb.orderBy('session.createdAt', 'ASC');
    }

    const result = await applyPagination(qb, params);

    // Latest message per session in ONE query (DISTINCT ON) instead of an
    // N+1 of per-session findOne calls.
    const sessionIds = result.data.map((s) => s.id);
    const lastMessages = sessionIds.length
      ? await messageRepository
          .createQueryBuilder('m')
          .distinctOn(['m.sessionId'])
          .where('m.sessionId IN (:...sessionIds)', { sessionIds })
          .orderBy('m.sessionId', 'ASC')
          .addOrderBy('m.createdAt', 'DESC')
          .getMany()
      : [];
    const lastBySession = new Map(lastMessages.map((m) => [m.sessionId, m]));

    const sessionsWithPreview = result.data.map((session) => {
      const lastMessage = lastBySession.get(session.id);
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
    });

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

    // Accepting a queue item IS the claim command, keyed by sessionId (plan B1:
    // no second takeover call, no handoff-id/session-id translation anywhere
    // else). The service accepts the open handoff row in the same transaction —
    // and it verifies the agent belongs to the session's tenant, which this
    // legacy route never did.
    await conversationCommands.claimConversation(
      handoff.sessionId,
      agentId!,
      { mode: 'indefinite' },
      undefined,
      {},
    );

    // B-PR3a: normalized ownership event to BOTH rooms, post-commit.
    await emitConversationUpsertForSession(handoff.sessionId, handoff.tenantId);

    const updated = await handoffRepository.findOneOrFail({ where: { id } });

    logger.info(`Handoff ${id} accepted by agent ${agentId}`);

    sendSuccess(res, {
      message: 'Handoff accepted',
      handoff: {
        id: updated.id,
        status: updated.status,
        assignedAgentId: updated.assignedAgentId,
        acceptedAt: updated.acceptedAt,
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

    // A decline is the atomic HANDOFF_REQUESTED -> BOT_OWNED cancel: the old
    // handler rejected the row but left the SESSION parked in handoff forever.
    await conversationCommands.cancelHandoff(
      handoff.sessionId,
      { kind: 'agent', agentId: req.user!.id },
      undefined,
      { reason: reason || 'Declined by agent' },
    );

    // B-PR3a: normalized ownership event to BOTH rooms, post-commit.
    await emitConversationUpsertForSession(handoff.sessionId, handoff.tenantId);

    const updated = await handoffRepository.findOneOrFail({ where: { id } });

    logger.info(`Handoff ${id} declined by agent ${req.user?.id}`);

    sendSuccess(res, {
      message: 'Handoff declined',
      handoff: {
        id: updated.id,
        status: updated.status,
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

/**
 * POST /handoff/resume-ai
 * Re-enable AI replies on a conversation the guardrails layer paused
 * (spam/scam/bot-loop). Owner action only — per R18, AI resumes solely on
 * explicit business-owner reactivation. Tenant-scoped lookup (no IDOR).
 */
router.post(
  '/resume-ai',
  requireClerkAuth, autoProvision, resolveTenantContext,
  validateTenant,
  asyncHandler(async (req: TenantRequest, res: Response) => {
    const tenantId = req.tenant?.id;
    const agent = req.user;
    const { sessionId } = req.body;

    if (!sessionId) {
      throw new BadRequestError('Session ID is required');
    }
    // Owner action only (R18): re-enabling AI after a safety pause is an admin
    // decision, not something any agent seat should do.
    if (agent?.role !== 'admin' && agent?.role !== 'super_admin') {
      throw new ForbiddenError('Only an admin can re-enable AI on a flagged conversation');
    }

    const session = await sessionRepository.findOne({ where: { id: sessionId, tenantId } });
    if (!session) {
      throw new NotFoundError('Session not found');
    }

    // Targeted UPDATE, never save(session): a full-entity write from this stale
    // copy would revert a concurrent ownership command (B-PR2b fix B1).
    await sessionRepository.update(session.id, {
      aiAutoReplyEnabled: true,
      guardrailStatus: 'normal',
    });

    // Clear the ephemeral bot-loop counters so a resumed conversation starts fresh.
    await redisLoopStore.clear(sessionId).catch(() => {});

    logger.info(`Guardrails: AI re-enabled for session ${sessionId}`, { agentId: agent?.id });

    sendSuccess(res, {
      message: 'AI replies re-enabled',
      session: { id: session.id, aiAutoReplyEnabled: true, guardrailStatus: 'normal' },
    });
  })
);

export default router;
