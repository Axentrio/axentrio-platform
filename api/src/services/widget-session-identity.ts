/**
 * Stable widget customer identity (B-PR4a) - the ONE resolve-or-create seam.
 *
 * One real customer = one (tenantId, botId, visitorId) = at most ONE non-closed
 * widget session, enforced by the partial unique index
 * uq_chat_sessions_widget_open (migration 1791500000000). EVERY public path
 * that can create a widget ChatSession row must go through these helpers under
 * the identity advisory lock: /widget/init, /widget/new-conversation, and the
 * legacy /auth/widget creator. A creator that bypasses this module turns the
 * unique index into a public 500 (that was exactly the /auth/widget bug).
 */

import type { Request } from 'express';
import { EntityManager, Not } from 'typeorm';
import { AppDataSource } from '../database/data-source';
import { ChatSession } from '../database/entities/ChatSession';
import { Participant } from '../database/entities/Participant';
import { Message } from '../database/entities/Message';
import { Tenant } from '../database/entities/Tenant';
import { Bot } from '../database/entities/Bot';
import { enforceCountLimit } from '../billing/enforce';
import { effectiveBotConfig, withEffectiveConfig } from '../templates/template-resolver';
import { substituteVariables } from '../llm/prompt-builder';
import { defaultBotAi } from '../config/default-bot-settings';
import {
  greetingQuickReplies,
  resolveBotLanguage,
  resolveGreetingMessage,
} from '../config/bot-language';
import { encrypt } from '../utils/encryption';
import { emitConversationUpsert } from '../realtime/conversation-events';
import { ValidationError } from '../middleware/error-handler';
import { logger } from '../utils/logger';

/**
 * classid for the two-int advisory-lock form. 0x42505234 = ASCII 'BPR4'.
 * Fits int4 (< 2^31).
 */
export const WIDGET_IDENTITY_LOCK_CLASS = 0x42505234;

/**
 * visitor_id is varchar(255) and feeds the identity advisory-lock key. A
 * non-string, empty, oversized, or control-character value (NUL breaks
 * Postgres text literals outright) must be a 422, never a DB error 500.
 * Applied on every endpoint that accepts a client-supplied identity:
 * /widget/init (visitorId) and /auth/widget (userId).
 */
export function assertValidVisitorId(visitorId: unknown): asserts visitorId is string {
  if (
    typeof visitorId !== 'string' ||
    visitorId.length === 0 ||
    visitorId.length > 255 ||
    // eslint-disable-next-line no-control-regex
    /[\u0000-\u001F\u007F]/.test(visitorId)
  ) {
    throw new ValidationError('Invalid visitor ID');
  }
}

/**
 * Transaction-level advisory lock on one widget customer identity. Released
 * automatically at commit/rollback (pg_advisory_xact_lock - no unlock call,
 * no leak on error).
 *
 * TWO-INT form on purpose: Postgres keeps the (classid, objid) two-key locks
 * in a lock space separate from the single-bigint form (objsubid 2 vs 1), so
 * this lock is PROVABLY disjoint from every hashtext/hashtextextended bigint
 * advisory user in this codebase (the booking itinerary lock, the Stripe
 * webhook lock, the calendar-credentials lock, the test-suite lock). Within
 * our own classid, hashtext collisions across different identities are
 * possible but only serialize the two requests briefly - both sides are
 * xact-scoped, so a collision cannot deadlock or persist.
 */
export async function acquireWidgetIdentityLock(
  manager: EntityManager,
  tenantId: string,
  botId: string,
  visitorId: string,
): Promise<void> {
  await manager.query('SELECT pg_advisory_xact_lock($1::int, hashtext($2))', [
    WIDGET_IDENTITY_LOCK_CLASS,
    `${tenantId}:${botId}:${visitorId}`,
  ]);
}

/**
 * The visitor's current session across ALL non-closed states - bot, waiting,
 * handoff, active. NOT just 'active': that stale filter is why dedup was dead
 * (AI sessions live in 'bot' and never resolved, so every reload created a
 * row). Scoped to source='widget', the same predicate as the unique index.
 */
export async function resolveOpenWidgetSession(
  manager: EntityManager,
  tenantId: string,
  botId: string,
  visitorId: string,
): Promise<ChatSession | null> {
  return manager
    .getRepository(ChatSession)
    .createQueryBuilder('s')
    .where('s.tenantId = :tenantId', { tenantId })
    .andWhere('s.botId = :botId', { botId })
    .andWhere('s.visitorId = :visitorId', { visitorId })
    .andWhere(`s.status <> 'closed'`)
    .andWhere(`s.source = 'widget'`)
    .orderBy('s.lastActivityAt', 'DESC')
    .addOrderBy('s.createdAt', 'DESC')
    .getOne();
}

/**
 * Create the widget session INSIDE the caller's transaction (which holds the
 * identity advisory lock): plan-cap gate first (step 10, count 2 - live
 * COUNT(*) behind the tenants row lock), then the insert the unique index
 * watches, then the visitor Participant row IN THE SAME transaction - a
 * session without its participant is not usable, so "session exists" must be
 * all-or-nothing (review fix S1). Used by /widget/init, /widget/new-conversation
 * and /auth/widget.
 */
export async function createWidgetSessionInTx(
  manager: EntityManager,
  args: {
    tenant: Tenant;
    bot: Bot;
    visitorId: string;
    metadata?: { name?: string; pageUrl?: string; referrer?: string; [k: string]: unknown };
    req: Request;
  },
): Promise<ChatSession> {
  const { tenant, bot, visitorId, metadata, req } = args;
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

  // #16d: initial status reads bot.settings - an AI-enabled bot starts in
  // 'bot' (platform agent / custom webhook), anything else waits for a human.
  const aiEnabled = bot.settings?.ai?.enabled;
  const initialStatus = aiEnabled ? 'bot' : 'waiting';

  const draft = manager.create(ChatSession, {
    tenantId: tenant.id,
    botId: bot.id,
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
  const session = await manager.save(ChatSession, draft);

  // The visitor Participant, atomically with the session (S1). A post-commit
  // participant write that failed used to orphan the session and 500.
  await manager.save(
    Participant,
    manager.create(Participant, {
      sessionId: session.id,
      type: 'user',
      name: metadata?.name || 'Visitor',
      isAnonymous: true,
      joinedAt: new Date(),
      metadata: {
        ipAddress: req.ip,
        userAgent: req.get('user-agent'),
      },
    }),
  );

  return session;
}

/**
 * Persist the bot greeting for a 'bot'-mode session - IDEMPOTENT and
 * FAIL-SAFE (S1). Idempotent: it no-ops when the session already has any
 * message, and it runs under the identity advisory lock in its own short
 * transaction, so a two-tab resolve cannot double-write the greeting.
 * Fail-safe: a greeting failure is logged, never thrown - the session is
 * already usable and the NEXT resolve of the same identity heals the missing
 * greeting (a resolve-retry re-announces instead of duplicating or failing).
 */
export async function ensureWidgetGreeting(
  session: ChatSession,
  tenant: Tenant,
  bot: Bot,
): Promise<void> {
  try {
    if (session.status !== 'bot') return;
    await AppDataSource.transaction(async (manager) => {
      await acquireWidgetIdentityLock(manager, session.tenantId, session.botId, session.visitorId);
      const existing = (await manager.query(
        `SELECT 1 FROM messages WHERE session_id = $1 LIMIT 1`,
        [session.id],
      )) as unknown[];
      if (existing.length) return;

      // The greeting comes from the effective config (template-owned when
      // bound, else the bot's own stored value), with placeholders like
      // {botName}/{businessName} substituted.
      const eff = await effectiveBotConfig(bot);
      const botAi = bot.settings?.ai ?? defaultBotAi(bot.name);
      const aiForGreeting = withEffectiveConfig(botAi, eff);
      const language = resolveBotLanguage(bot.settings?.ai?.language ?? botAi.language);
      const rawGreeting = resolveGreetingMessage(aiForGreeting.guardrails?.greetingMessage, language);
      const greetingMessage = rawGreeting
        ? substituteVariables(rawGreeting, aiForGreeting, { businessName: tenant.name })
        : '';
      if (!greetingMessage) return;

      let botParticipant = await manager.findOne(Participant, {
        where: { sessionId: session.id, type: 'bot', isDeleted: false },
      });
      if (!botParticipant) {
        botParticipant = await manager.save(
          Participant,
          manager.create(Participant, {
            sessionId: session.id,
            type: 'bot',
            name: bot.settings?.ai?.brandVoice?.name || 'AI Assistant',
            isAnonymous: false,
            joinedAt: new Date(),
          }),
        );
      }

      await manager.save(
        Message,
        manager.create(Message, {
          sessionId: session.id,
          tenantId: tenant.id,
          participantId: botParticipant.id,
          type: 'text' as Message['type'],
          content: encrypt(greetingMessage),
          contentEncrypted: true,
          status: 'sent' as Message['status'],
          sentAt: new Date(),
          metadata: {
            quickReplies: [...greetingQuickReplies(language)],
          },
        }),
      );
    });
  } catch (err) {
    logger.error('[widget] greeting write failed (session stays usable; next resolve heals it)', {
      sessionId: session.id,
      tenantId: session.tenantId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Post-commit half of a widget session create: the B-PR3a upsert announce
 * (internally fail-safe) and the idempotent greeting. NOTHING here may throw:
 * the session committed, so the response must report it (S1 - a throw here
 * used to 500 an endpoint whose session already existed, and the retry then
 * churned out another session).
 */
export async function announceWidgetSession(
  session: ChatSession,
  tenant: Tenant,
  bot: Bot,
): Promise<void> {
  // B-PR3a: announce the new conversation row AFTER the create commits
  // (before the greeting, which does not count into message_count either).
  await emitConversationUpsert(session, { lastMessage: null });
  await ensureWidgetGreeting(session, tenant, bot);
}
