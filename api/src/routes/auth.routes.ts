/**
 * Authentication Routes
 * POST /auth/widget - Widget authentication via API key (unchanged)
 * GET /auth/me - Get current user via Clerk auth + auto-provisioning
 */
import crypto from 'crypto';
import { Router, Response } from 'express';
import { AppDataSource } from '../database/data-source';
import { ChatSession } from '../database/entities/ChatSession';
import { User } from '../database/entities/User';
import { logger } from '../utils/logger';
import { generateWidgetToken } from '../middleware/auth.middleware';
import { resolveBotKeyStrict, BotPausedError, BotNotFoundError } from '../services/bot-resolution.service';
import { rateLimitWidget } from '../middleware/rate-limit.middleware';
import { requireClerkAuth, autoProvision, ProvisionedRequest } from '../middleware/clerk.middleware';
import { asyncHandler, BadRequestError, ForbiddenError, UnauthorizedError } from '../middleware/error-handler';
import { validate } from '../middleware/validate';
import { sendSuccess } from '../utils/response';
import { widgetAuthSchema } from '../schemas';
import {
  acquireWidgetIdentityLock,
  resolveOpenWidgetSession,
  createWidgetSessionInTx,
  announceWidgetSession,
  assertValidVisitorId,
} from '../services/widget-session-identity';

const router = Router();
const sessionRepository = AppDataSource.getRepository(ChatSession);

// Widget authentication request body
interface WidgetAuthRequest {
  apiKey: string;
  sessionId?: string;
  userId?: string;
  metadata?: Record<string, unknown>;
}

/**
 * POST /auth/widget
 * Authenticate widget and create/get session
 * Rate limited for security
 */
router.post(
  '/widget',
  rateLimitWidget,
  validate(widgetAuthSchema),
  asyncHandler(async (req: ProvisionedRequest, res: Response) => {
    const { apiKey, sessionId, userId, metadata } = req.body as WidgetAuthRequest;

    if (!apiKey) {
      throw new BadRequestError('API key is required');
    }

    // Resolve API key → { tenant, bot } (handles both bk_* and legacy apiKey).
    // #16b: paused bots are rejected at the HTTP surface with a 403, matching
    // the websocket rejection. The resolver throws `BotPausedError` when the
    // matched bot is paused; map that to 403 so the widget can surface
    // "this chatbot is currently paused" copy to the visitor.
    let resolved: Awaited<ReturnType<typeof resolveBotKeyStrict>>;
    try {
      resolved = await resolveBotKeyStrict(apiKey);
    } catch (err) {
      if (err instanceof BotPausedError) {
        throw new ForbiddenError('This chatbot is currently paused.');
      }
      if (err instanceof BotNotFoundError) {
        throw new UnauthorizedError('Invalid API key');
      }
      throw err;
    }

    const { tenant, bot } = resolved;

    // Client-supplied identity: 422 for oversized / control-character values
    // (S3) - they feed varchar(255) and the identity advisory-lock key.
    if (userId !== undefined) assertValidVisitorId(userId);

    // Get or create session. GUARDED since B-PR4a (review fix B1): this
    // legacy public creator used to insert widget-source rows with
    // visitorId 'anonymous', no lock, and an 'active'-only resume filter -
    // the exact producer of the duplicate rows migration 1791500000000
    // remediates. Every create now goes through the SAME advisory-locked
    // resolve-or-create seam as /widget/init, so it can never trip the
    // uq_chat_sessions_widget_open index into a public 500.
    let session: ChatSession | null = null;
    let isNew = false;

    if (sessionId) {
      const existingSession = await sessionRepository.findOne({
        where: { id: sessionId, tenantId: tenant.id },
      });

      // Broadened from isActive() (= 'active' only) to ANY non-closed state:
      // the 'active'-only filter is the dead-dedup bug B-PR4a fixes, and
      // creating a duplicate for a live 'waiting'/'bot' session would now
      // collide with the unique index.
      if (existingSession && !existingSession.isClosed()) {
        session = existingSession;
        // Targeted UPDATE, never save(session): a full-entity write from this
        // stale copy would revert a concurrent human takeover (B-PR2b fix B1).
        // Only botId-if-missing + activity are this handler's to write.
        session.updateActivity();
        if (!existingSession.botId) {
          session.botId = bot.id;
          await sessionRepository.update(session.id, { botId: bot.id, lastActivityAt: new Date() });
        } else {
          await sessionRepository.update(session.id, { lastActivityAt: new Date() });
        }
      }
    }

    if (!session) {
      // Identity: the caller's stable userId, or a UNIQUE per-call anonymous
      // id. A SHARED 'anonymous' identity is what produced the duplicate rows
      // the migration remediates - and resolving every anonymous caller onto
      // ONE open session would hand one visitor another visitor's transcript.
      // A unique id preserves the old per-call-create behavior for anonymous
      // callers, and unique ids never collide in the partial index.
      const visitorId = userId || `anon-${crypto.randomUUID()}`;
      const outcome = await AppDataSource.transaction(async (manager) => {
        await acquireWidgetIdentityLock(manager, tenant.id, bot.id, visitorId);
        const existing = await resolveOpenWidgetSession(manager, tenant.id, bot.id, visitorId);
        if (existing) return { session: existing, isNew: false };
        const created = await createWidgetSessionInTx(manager, {
          tenant,
          bot,
          visitorId,
          metadata: {
            ...metadata,
            referrer: (metadata?.referrer as string | undefined) ?? req.headers.referer,
          } as { name?: string; pageUrl?: string; referrer?: string },
          req,
        });
        return { session: created, isNew: true };
      });
      session = outcome.session;
      isNew = outcome.isNew;
    }

    if (isNew) {
      // B-PR3a announce + idempotent greeting, post-commit, fail-safe.
      await announceWidgetSession(session, tenant, bot);
    }

    // Generate widget token
    const token = generateWidgetToken(session.id, tenant.id, userId);

    logger.info('Widget authenticated', {
      sessionId: session.id,
      tenantId: tenant.id,
    });

    // #16d completion: visible session config lives on bot.settings, not
    // tenant.settings. The widget identity/appearance is per-bot since the
    // multi-bot refactor.
    const botSettings = bot.settings ?? {};
    sendSuccess(res, {
      token,
      session: {
        id: session.id,
        status: session.status,
        tenantId: tenant.id,
      },
      tenant: {
        id: tenant.id,
        name: tenant.name,
        settings: {
          theme: botSettings.theme,
          features: botSettings.features,
          businessHours: botSettings.businessHours,
        },
      },
    });
  })
);

/**
 * GET /auth/me
 * Get current authenticated user via Clerk + auto-provisioning
 */
router.get(
  '/me',
  requireClerkAuth,
  autoProvision,
  asyncHandler(async (req: ProvisionedRequest, res: Response) => {
    // Look up locale separately — req.user comes from a small cached struct
    // (id/email/role/tenant) and does not carry user preferences.
    const userId = req.userId;
    const user = userId
      ? await AppDataSource.getRepository(User).findOne({
          where: { id: userId },
          select: ['locale'],
        })
      : null;

    sendSuccess(res, {
      agentId: req.agentId,
      tenantId: req.tenantId,
      role: req.userRole,
      tenantName: req.tenantName,
      email: req.user?.email,
      locale: user?.locale ?? null,
    });
  })
);

export default router;
