/**
 * Copilot HTTP routes (M9a — AI Platform Assistant).
 *
 * Endpoints:
 *
 *   POST /api/v1/copilot/messages
 *     SSE stream. Accepts `{ message: string, locale?: 'en'|'nl'|'fr' }`.
 *     Runs agent loop. Emits token / tool_call_start / tool_call_end /
 *     heartbeat / error / complete events.
 *
 *   GET  /api/v1/copilot/conversation
 *     JSON. Cursor-paginated transcript of the active conversation.
 *     Pages never split user/assistant pairs (round 5 #9).
 *
 *   POST /api/v1/copilot/conversation/clear
 *     Archives the active conversation. Idempotent (round 3 #10).
 *
 * Middleware chain per Q10:
 *   1. requireClerkAuth   → 401
 *   2. autoProvision      → ensures req.tenantId, req.userId
 *   3. resolveTenantContext → super-admin tenant switch
 *   4. requireFeature('platformAssistant') → 402 plan_limit_platform_assistant
 *   5. (POST /messages only) body validation → 400
 *   6. (POST /messages only) cost check → 429 daily or 429 per-minute
 *   7. (POST /messages only) SSE headers + agent loop
 *
 * Pre-SSE errors return JSON envelopes via the global error handler.
 * Post-SSE-headers errors emit `event: error` and close the stream.
 */
import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { AppDataSource } from '../database/data-source';
import { CopilotMessage } from '../database/entities/CopilotMessage';
import { CopilotConversation } from '../database/entities/CopilotConversation';
import { requireClerkAuth, autoProvision } from '../middleware/clerk.middleware';
import { resolveTenantContext } from '../middleware/super-admin.middleware';
import { ApiError, asyncHandler } from '../middleware/error-handler';
import { sendSuccess } from '../utils/response';
import { requireFeature } from '../billing/enforce';
import { getRedisClient } from '../config/redis';
import {
  checkAndConsumeCopilotCost,
} from './limits/check-and-consume';
import { CopilotDailyCapExceededError } from './limits/daily-cap';
import { CopilotRateLimitExceededError } from './limits/rate-limit';
import { runCopilotTurn } from './agent/loop';
import { ConversationClearedMidSendError } from './agent/persist';
import { OpenAICopilotLlmStream } from './agent/openai-stream';
import { serializeSSE, type CopilotSSEEvent, type CopilotSSESink } from './agent/sse';
import { buildV1CopilotToolRegistry } from './tools';
import { createCopilotKnowledgeSource } from './knowledge/factory';
import { IsNull } from 'typeorm';
import { logger } from '../utils/logger';
import type { CopilotKnowledgeSource } from './knowledge/types';
import type { CopilotLlmStream } from './agent/llm-stream';

const router = Router();

router.use(requireClerkAuth, autoProvision, resolveTenantContext);

// Every Copilot route is Pro+ entitlement-gated. Locked-drawer UX is
// purely client-side; the API never returns data for non-entitled
// tenants (round 1 #5).
router.use(
  asyncHandler(async (req: Request, _res: Response, next: NextFunction) => {
    await requireFeature(req.tenantId!, 'platformAssistant', 'plan_limit_platform_assistant');
    next();
  }),
);

// ---------------------------------------------------------------
// POST /messages — SSE stream
// ---------------------------------------------------------------
const sendMessageSchema = z.object({
  message: z
    .string()
    .trim()
    .min(1, 'message cannot be empty')
    .max(4000, 'message exceeds 4000-character limit'),
  locale: z.enum(['en', 'nl', 'fr']).optional(),
});

const HEARTBEAT_INTERVAL_MS = 60_000;

router.post(
  '/messages',
  asyncHandler(async (req: Request, res: Response): Promise<void> => {
    // ---- Step 4: body validation ----
    const parsed = sendMessageSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ApiError(
        'Invalid Copilot message request body',
        400,
        'invalid_request_body',
        { issues: parsed.error.issues },
      );
    }

    // ---- Step 5: cost-check + increment ----
    const redis = getRedisClient();
    const tenantId = req.tenantId!;
    const userId = req.userId!;
    try {
      await checkAndConsumeCopilotCost(redis, tenantId, userId);
    } catch (err) {
      if (err instanceof CopilotDailyCapExceededError) {
        res.setHeader('Retry-After', String(err.retryAfterSeconds));
        throw new ApiError(err.message, 429, err.code, {
          retryAfter: err.retryAfterSeconds,
        });
      }
      if (err instanceof CopilotRateLimitExceededError) {
        res.setHeader('Retry-After', String(err.retryAfterSeconds));
        throw new ApiError(err.message, 429, err.code, {
          retryAfter: err.retryAfterSeconds,
        });
      }
      throw err;
    }

    // ---- Step 6: SSE handshake ----
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('X-Accel-Buffering', 'no');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    // Tie req.close → AbortController so the agent loop unwinds cleanly.
    const abortController = new AbortController();
    const onSocketClose = () => abortController.abort('aborted');
    req.on('close', onSocketClose);

    // Heartbeat: emit every 60s during tool-call gaps so Cloudflare's
    // 524 edge timeout doesn't kill long tool runs. Cleared when the
    // turn completes or the socket closes.
    const heartbeat = setInterval(() => {
      writeEvent(res, { event: 'heartbeat', data: {} });
    }, HEARTBEAT_INTERVAL_MS);

    const sink: CopilotSSESink = {
      emit(event: CopilotSSEEvent) {
        writeEvent(res, event);
      },
    };

    try {
      await runCopilotTurn({
        dataSource: AppDataSource,
        llm: getLlmStream(),
        knowledge: getKnowledgeSource(),
        toolRegistry: buildV1CopilotToolRegistry(),
        sink,
        abortSignal: abortController.signal,
        tenantId,
        userId,
        message: parsed.data.message,
        locale: parsed.data.locale,
      });
    } catch (err) {
      if (err instanceof ConversationClearedMidSendError) {
        // The send-vs-clear race fired twice — the user actively
        // cleared mid-send. We've already emitted SSE headers, so
        // surface the issue via an `error` event and close.
        sink.emit({ event: 'error', data: { code: 'aborted' } });
      } else {
        logger.error('Copilot route: agent loop threw unexpectedly', {
          tenantId,
          userId,
          error: err instanceof Error ? err.message : String(err),
        });
        sink.emit({ event: 'error', data: { code: 'llm_error' } });
      }
    } finally {
      clearInterval(heartbeat);
      req.off('close', onSocketClose);
      if (!res.writableEnded) {
        res.end();
      }
    }
  }),
);

function writeEvent(res: Response, event: CopilotSSEEvent): void {
  if (res.writableEnded || (res as Response & { destroyed?: boolean }).destroyed) return;
  try {
    res.write(serializeSSE(event));
  } catch {
    // Socket closed mid-write — silently drop. The agent loop's
    // finalize path still writes the final DB row + trace via
    // CopilotMessage updates, not via this socket.
  }
}

// ---------------------------------------------------------------
// GET /conversation — paginated transcript
// ---------------------------------------------------------------
const conversationQuerySchema = z.object({
  cursor: z
    .preprocess((v) => (v === undefined ? undefined : Number(v)), z.number().int().min(0))
    .optional(),
  limit: z
    .preprocess((v) => (v === undefined ? undefined : Number(v)), z.number().int().min(1).max(200))
    .optional(),
});

router.get(
  '/conversation',
  asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const parsed = conversationQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      throw new ApiError(
        'Invalid cursor or limit on GET /copilot/conversation',
        400,
        'bad_cursor_or_limit',
        { issues: parsed.error.issues },
      );
    }
    const cursor = parsed.data.cursor ?? 0;
    const limit = parsed.data.limit ?? 50;

    const tenantId = req.tenantId!;
    const userId = req.userId!;

    const conv = await AppDataSource.getRepository(CopilotConversation).findOne({
      where: { tenantId, userId, archivedAt: IsNull() },
    });
    if (!conv) {
      // Empty-state per round 3 #10 — never 404.
      sendSuccess(res, { conversationId: null, messages: [], nextCursor: null });
      return;
    }

    // Fetch (limit + 1) rows starting at `cursor` ascending. If the
    // (limit)-th row is a user with a paired assistant at turn+1
    // beyond the page, we extend the page to include the assistant
    // so we never split a pair (round 5 #9).
    const fetched = await AppDataSource.getRepository(CopilotMessage).find({
      where: { conversationId: conv.id },
      order: { turn: 'ASC' },
      skip: undefined,
      take: limit,
      cache: false,
      // Filter by turn >= cursor via QueryBuilder for type safety.
    });
    // (TypeORM's find() doesn't expose >= filtering directly without
    //  more types; do it inline.)
    const slice = fetched.filter((m) => m.turn >= cursor).slice(0, limit);

    let pageRows = slice;
    if (pageRows.length === limit && pageRows[pageRows.length - 1]?.role === 'user') {
      const assistantTurn = pageRows[pageRows.length - 1].turn + 1;
      const paired = await AppDataSource.getRepository(CopilotMessage).findOne({
        where: { conversationId: conv.id, turn: assistantTurn },
      });
      if (paired) pageRows = [...pageRows, paired];
    }

    const lastTurn = pageRows.length > 0 ? pageRows[pageRows.length - 1].turn : null;
    const totalAfter = await AppDataSource.getRepository(CopilotMessage).count({
      where: { conversationId: conv.id },
    });
    const nextCursor =
      lastTurn !== null && lastTurn + 1 < (cursor + totalAfter)
        ? lastTurn + 1
        : null;

    sendSuccess(res, {
      conversationId: conv.id,
      messages: pageRows.map(serializeMessage),
      nextCursor,
    });
  }),
);

function serializeMessage(m: CopilotMessage) {
  if (m.role === 'user') {
    return {
      id: m.id,
      turn: m.turn,
      role: 'user' as const,
      content: m.content,
      createdAt: m.createdAt,
    };
  }
  return {
    id: m.id,
    turn: m.turn,
    role: 'assistant' as const,
    content: m.content,
    toolsCalled: m.toolsCalled ?? [],
    outcome: m.outcome,
    tokensIn: m.tokensIn ?? null,
    tokensOut: m.tokensOut ?? null,
    latencyMs: m.latencyMs ?? null,
    createdAt: m.createdAt,
  };
}

// ---------------------------------------------------------------
// POST /conversation/clear — archive active
// ---------------------------------------------------------------
router.post(
  '/conversation/clear',
  asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const tenantId = req.tenantId!;
    const userId = req.userId!;

    // Idempotent: archive if there's an active conversation; succeed
    // either way (round 3 #10).
    await AppDataSource.query(
      `UPDATE chatbot_copilot_conversations
          SET archived_at = now(), updated_at = now()
        WHERE tenant_id = $1 AND user_id = $2 AND archived_at IS NULL`,
      [tenantId, userId],
    );
    sendSuccess(res, { cleared: true });
  }),
);

// ---------------------------------------------------------------
// Lazy singletons for LLM stream + knowledge source so a tenant's
// first message doesn't pay the OpenAI client construction cost.
// ---------------------------------------------------------------
let cachedLlm: CopilotLlmStream | null = null;
let cachedKnowledge: CopilotKnowledgeSource | null = null;

function getLlmStream(): CopilotLlmStream {
  if (!cachedLlm) cachedLlm = new OpenAICopilotLlmStream();
  return cachedLlm;
}
function getKnowledgeSource(): CopilotKnowledgeSource {
  if (!cachedKnowledge) cachedKnowledge = createCopilotKnowledgeSource(AppDataSource.manager);
  return cachedKnowledge;
}

/** Test-only — reset cached deps between tests. */
export function __resetCopilotRoutesCache(): void {
  cachedLlm = null;
  cachedKnowledge = null;
}

/** Test-only — inject a fake LLM stream + knowledge source. */
export function __setCopilotRoutesDeps(deps: {
  llm?: CopilotLlmStream;
  knowledge?: CopilotKnowledgeSource;
}): void {
  if (deps.llm) cachedLlm = deps.llm;
  if (deps.knowledge) cachedKnowledge = deps.knowledge;
}

export default router;
