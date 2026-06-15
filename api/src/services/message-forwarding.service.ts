/**
 * Message Forwarding Service
 * Handles forwarding visitor messages to n8n webhooks
 * Used by both WebSocket handler and HTTP chat routes
 */

import { logger } from '../utils/logger';
import { AppDataSource } from '../database/data-source';
import { notificationService } from './notification.service';
import { ChatSession } from '../database/entities/ChatSession';
import { Message } from '../database/entities/Message';
import { decrypt, encrypt } from '../utils/encryption';
import { cached } from '../utils/cache';
import { Tenant } from '../database/entities/Tenant';
import { Bot, BotSettings } from '../database/entities/Bot';
import { resolveBoundTemplate, effectiveConfigFrom, withEffectiveConfig } from '../templates/template-resolver';
import { getEntitlements } from '../billing/entitlements';
import { Participant } from '../database/entities/Participant';
import { HandoffRequest } from '../database/entities/HandoffRequest';
import { OutboundService } from '../n8n/outbound.service';
import { composeSystemPrompt } from '../llm/compose-system-prompt';
import { FallbackService } from '../n8n/fallback.service';
import { WebhookConfig, OutboundMessage, MessagePayload, TenantAiConfig, KnowledgeBaseMetadata, IntegrationsConfig } from '../n8n/types';
import { emitToTenantAgents, emitToSession } from '../websocket/socket.handler';
import { generateResponse } from '../llm/rag.service';
import { getBotKnowledgeBaseIds } from '../knowledge/bot-knowledge-bases';
import { routeOutboundMessage } from '../channels/outbound-router';
import { config } from '../config/environment';
import { AgentService, AgentResult } from '../agent/agent.service';
import {
  getBotConfigForSession,
  getLlmRuntimeConfigForSession,
  BotPausedConfigError,
  BotNotFoundConfigError,
} from './bot-config.service';

/** Bot.settings['ai'] alias — the behavioural slice (no apiKey). */
type BotAiSettings = BotSettings['ai'];

const sessionRepository = AppDataSource.getRepository(ChatSession);
const messageRepository = AppDataSource.getRepository(Message);
const tenantRepository = AppDataSource.getRepository(Tenant);
const participantRepository = AppDataSource.getRepository(Participant);
const handoffRepository = AppDataSource.getRepository(HandoffRequest);

// Module-level service references, set via initialize()
let outboundService: OutboundService | null = null;
let fallbackServiceRef: FallbackService | null = null;
let agentService: AgentService | null = null;

/**
 * Initialize with n8n service references
 */
export function initializeForwarding(
  outbound: OutboundService,
  fallback: FallbackService
): void {
  outboundService = outbound;
  fallbackServiceRef = fallback;
  logger.info('Message forwarding service initialized');
}

export function initializeAgentService(agent: AgentService): void {
  agentService = agent;
  logger.info('Platform agent service initialized for message forwarding');
}

export function getFallbackService(): FallbackService | null {
  return fallbackServiceRef;
}

/**
 * Whether a tenant.webhookUrl is an EXPLICIT custom n8n workflow (vs. an
 * auto-provision artifact). A url equal to the platform default is set
 * automatically when AI is enabled and must NOT count as custom — otherwise it
 * shadows the platform-agent path and forces messages down the default n8n
 * webhook (which, if its workflow is inactive, 404s and silently hands off).
 * localhost urls are dev leftovers and never count.
 */
export function isCustomWebhookUrl(
  webhookUrl: string | null | undefined,
  defaultUrl: string | null | undefined,
): boolean {
  return !!webhookUrl && !webhookUrl.includes('localhost') && webhookUrl !== defaultUrl;
}

/**
 * Build a WebhookConfig from a Tenant entity
 */
export function buildWebhookConfig(tenant: Tenant): WebhookConfig {
  return {
    id: tenant.id,
    tenantId: tenant.id,
    name: tenant.name,
    url: tenant.webhookUrl!,
    secret: tenant.webhookSecret || '',
    events: ['message.received', 'session.started', 'session.ended'],
    active: true,
    timeout: 30000,
    retryPolicy: { maxRetries: 3, backoffMultiplier: 2, initialDelay: 1000 },
    headers: {},
    createdAt: tenant.createdAt.toISOString(),
    updatedAt: tenant.updatedAt.toISOString(),
  };
}

/**
 * Build the AI config slice of the n8n outbound payload.
 *
 * Multi-bot Phase 4 (#16d): reads from the bot's `BotSettings.ai` (resolved
 * via `getBotConfigForSession`), not `tenant.settings.ai`. `tenantName` is
 * still passed in for `businessName` placeholder substitution.
 */
export function buildTenantAiConfig(
  tenantName: string,
  ai: BotAiSettings | undefined,
  templateBody?: string,
): TenantAiConfig | undefined {
  if (!ai?.enabled) return undefined;

  return {
    brandName: ai.brandVoice?.name || tenantName,
    brandTone: ai.brandVoice?.tone || 'professional',
    // n8n has its own prompt handling — pass the bot's template + custom
    // instructions through with {placeholders} resolved, but without a legacy
    // fallback (empty template + empty custom → empty systemPrompt). Composed
    // via the n8n mode of the single composer (no default block, no platform
    // rules, no module sections — T14).
    systemPrompt: composeSystemPrompt({ mode: 'n8n', ai, businessName: tenantName, templateBody }),
    guardrails: {
      topicsToAvoid: ai.guardrails?.topicsToAvoid || [],
      confidenceThreshold: ai.guardrails?.confidenceThreshold ?? 0.7,
      maxResponseLength: ai.guardrails?.maxResponseLength ?? 500,
      escalationKeywords: ai.guardrails?.escalationKeywords || [],
    },
  };
}

export async function buildKnowledgeBaseMetadata(tenantId: string): Promise<KnowledgeBaseMetadata> {
  try {
    // Cached per tenant (kb:meta:<tenantId>) — this COUNT runs on every
    // forwarded message. The count only moves when a document finishes indexing
    // or is removed, so a short TTL with no explicit invalidation is fine: a
    // freshly-indexed doc becomes visible within the TTL.
    return await cached(`kb:meta:${tenantId}`, 60, async () => {
      const result = await AppDataSource.query(
        `SELECT COUNT(*)::int AS count FROM knowledge_documents WHERE "tenantId" = $1 AND status = 'indexed'`,
        [tenantId]
      );
      const docCount = result[0]?.count || 0;
      return { enabled: docCount > 0, documentCount: docCount };
    });
  } catch {
    return { enabled: false, documentCount: 0 };
  }
}

/**
 * Build the integrations slice of the n8n outbound payload from the bot's
 * settings. Multi-bot Phase 4 (#16d): reads from `BotSettings` only — no
 * tenant fall-through. The entitlement gate is the canonical egress
 * chokepoint: a tenant who loses the feature stops sending the booking block
 * to n8n without any DB cleanup.
 */
async function buildIntegrationsConfig(
  botSettings: BotSettings,
  tenantId: string,
): Promise<IntegrationsConfig | undefined> {
  const timezone = botSettings.businessHours?.timezone || 'UTC';

  // Gated on the resolved `bookings` feature (plan D6/D10/D11) — resolved
  // entitlements, not raw tier, so per-tenant overrides and the free/
  // non-active deny apply. The `calcom` key name is load-bearing for external
  // custom n8n workflows and is kept verbatim; the n8n flow is
  // provider-agnostic and only needs the block to activate the booking
  // prompt + tools, which hit /internal/booking/* (internal provider).
  // Fails closed on resolution errors.
  try {
    if (!(await getEntitlements(tenantId)).features.bookings) return undefined;
  } catch {
    return undefined;
  }
  return {
    calcom: {
      enabled: true,
      language: 'en',
      collectFields: ['name', 'email'],
      timezone,
    },
  };
}

/**
 * Load last 10 text messages with timestamps for the n8n outbound payload.
 * Separate from getConversationHistory() which is used by the RAG fallback path.
 */
async function getConversationHistoryForPayload(
  sessionId: string
): Promise<{ role: 'user' | 'assistant' | 'system'; content: string; timestamp: string }[]> {
  const messages = await messageRepository
    .createQueryBuilder('message')
    .leftJoinAndSelect('message.participant', 'participant')
    .where('message.sessionId = :sessionId', { sessionId })
    .andWhere('message.isDeleted = false')
    .andWhere('message.type = :type', { type: 'text' })
    .orderBy('message.createdAt', 'DESC')
    .take(10)
    .getMany();

  return messages.reverse().map((msg) => ({
    role: msg.participant?.type === 'bot' ? 'assistant' as const : 'user' as const,
    content: msg.contentEncrypted ? decrypt(msg.content) : msg.content,
    timestamp: msg.createdAt?.toISOString() || new Date().toISOString(),
  }));
}

/**
 * Forward a visitor message to n8n if applicable.
 * Called after the message is saved to DB and broadcast via WebSocket.
 *
 * Returns true if the message was forwarded (or fallback triggered).
 */
export async function forwardMessageToN8n(
  session: ChatSession,
  savedMessage: Message
): Promise<boolean> {
  // Only forward visitor messages when session is in bot or waiting status
  if (session.status !== 'bot' && session.status !== 'waiting') {
    return false;
  }

  if (!outboundService) {
    logger.warn('Message forwarding not initialized — outboundService is null');
    return false;
  }

  const tenant = await tenantRepository.findOne({ where: { id: session.tenantId } });
  if (!tenant) {
    logger.warn(`Tenant not found for session ${session.id}`);
    return false;
  }

  // Multi-bot Phase 4 (#16d): resolve per-bot config. The behavioural slice
  // (ai, businessHours, integrations) lives on Bot.settings; only the LLM
  // provider apiKey stays on Tenant.settings.ai.apiKey (fetched lazily in the
  // RAG fallback path below via getLlmRuntimeConfigForSession).
  let botSettings: BotSettings;
  let bot: Bot;
  try {
    ({ bot, settings: botSettings } = await getBotConfigForSession(session));
  } catch (err) {
    if (err instanceof BotPausedConfigError || err instanceof BotNotFoundConfigError) {
      // Traffic to a paused/deleted bot should have been rejected upstream
      // (widget/auth layer, #16b). Don't propagate as 500 — log and drop.
      logger.warn(
        `Session ${session.id} points at a paused/deleted bot — should have been caught upstream`,
        { error: err.message, tenantId: session.tenantId, botId: session.botId },
      );
      return false;
    }
    throw err;
  }
  // Tone + policy guardrails (offHours/fallback messages etc.) come from the
  // bound template; override the AI slice once so all downstream reads + the n8n
  // payload + the RAG fallback use the effective values. escalationKeywords +
  // businessHours stay tenant-owned (preserved / read from botSettings directly).
  const resolvedTemplate = await resolveBoundTemplate(bot);
  const aiSettings = botSettings.ai ? withEffectiveConfig(botSettings.ai, effectiveConfigFrom(resolvedTemplate)) : botSettings.ai;

  // Only a genuinely custom n8n webhook is honoured. The auto-provisioned
  // default (config.n8n.defaultWebhookUrl) is intentionally NOT a fallback: that
  // workflow is inactive (404), and AI bots without a custom webhook are
  // answered by the platform agent instead. See issue #3.
  const customWebhookUrl = isCustomWebhookUrl(tenant.webhookUrl, config.n8n.defaultWebhookUrl)
    ? tenant.webhookUrl!
    : undefined;

  const aiEnabled = !!aiSettings?.enabled;
  // AI-enabled bots without a custom webhook are answered by the platform agent.
  // The dead default n8n webhook is never used as a fallback. See issue #3.
  const willUsePlatformAgent = !customWebhookUrl && aiEnabled && !!agentService;

  if (!customWebhookUrl && !willUsePlatformAgent) {
    // Nothing to forward to: AI is off, or the agent service is unavailable.
    // Session stays waiting; a human agent picks up. (Previously this fell back
    // to the dead default n8n webhook → 404 → spurious "connecting you to an
    // agent" handoff. See issue #3.)
    return false;
  }

  // ── Pre-forwarding checks (cheap, local) ──────────────────────────────
  if (session.status === 'bot' && savedMessage.type === 'text' && aiSettings?.enabled) {
    // Business hours check
    const bh = botSettings.businessHours;
    if (bh?.enabled && bh.schedule?.length) {
      const now = new Date();
      const tz = bh.timezone || 'UTC';
      const dayFormatter = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'long' });
      const dayName = dayFormatter.format(now).toLowerCase();
      const timeFormatter = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
      const parts = timeFormatter.formatToParts(now);
      const hour = parts.find(p => p.type === 'hour')!.value;
      const minute = parts.find(p => p.type === 'minute')!.value;
      const timeStr = `${hour}:${minute}`;
      const daySchedule = bh.schedule.find((s: any) => s.day.toLowerCase() === dayName);

      const isOutsideHours = !daySchedule || daySchedule.closed ||
        timeStr < daySchedule.open || timeStr >= daySchedule.close;

      if (isOutsideHours) {
        const botParticipant = await ensureBotParticipant(session, aiSettings);
        await sendBotMessage(
          session,
          botParticipant.id,
          aiSettings.guardrails?.offHoursMessage || "We're currently outside business hours. We'll get back to you soon."
        );
        return true;
      }
    }

    // Escalation keyword check — decrypt first if needed
    const escalationKeywords = aiSettings.guardrails?.escalationKeywords || [];
    const plainContent = savedMessage.contentEncrypted
      ? decrypt(savedMessage.content)
      : savedMessage.content;
    const lowerContent = plainContent.toLowerCase();
    const matchedKeyword = escalationKeywords.find((kw: string) =>
      lowerContent.includes(kw.toLowerCase())
    );

    if (matchedKeyword) {
      logger.info(`Escalation keyword "${matchedKeyword}" detected in session ${session.id}`);
      const botParticipant = await ensureBotParticipant(session, aiSettings);
      await sendBotMessage(
        session,
        botParticipant.id,
        aiSettings.guardrails?.fallbackMessage || "I'm connecting you to a human agent."
      );
      await handleBotHandoff(session, botParticipant.id, 'bot_escalation_keyword');
      return true;
    }
  }

  // ── Platform agent path (AI bots without a custom webhook) ───────────
  if (willUsePlatformAgent) {
    return platformAgentPath(session, savedMessage, tenant, aiSettings);
  }

  // ── Custom webhook path (tenant-configured n8n workflow) ───────────────
  const webhookConfig = buildWebhookConfig(tenant);
  webhookConfig.url = customWebhookUrl!;

  // Layer-2 template body for this bot — used by the n8n systemPrompt and the
  // RAG fallback below (blank-base → empty → unchanged).
  const templateBody = resolvedTemplate.body;

  const outboundPayload: OutboundMessage = {
    event: 'message.received',
    tenantId: session.tenantId,
    botId: session.botId ?? null,
    sessionId: session.id,
    timestamp: new Date().toISOString(),
    payload: {
      type: (savedMessage.type as MessagePayload['type']) || 'text',
      content: savedMessage.contentEncrypted
        ? decrypt(savedMessage.content)
        : savedMessage.content,
      metadata: savedMessage.metadata || undefined,
    },
    tenantConfig: buildTenantAiConfig(tenant.name, aiSettings, templateBody),
    knowledgeBase: await buildKnowledgeBaseMetadata(session.tenantId),
    integrations: await buildIntegrationsConfig(botSettings, tenant.id),
    context: {
      previousMessages: await getConversationHistoryForPayload(session.id),
    },
  };

  // ── Forward to n8n ─────────────────────────────────────────────────────
  // NOTE: sendToWebhook() swallows HTTP errors and returns { success: false }
  // instead of throwing. Must check result.success, not rely on catch.
  const result = await outboundService.sendToWebhook(webhookConfig, outboundPayload);

  if (result.success) {
    // Transition waiting → bot atomically on first forwarded message
    if (session.status === 'waiting') {
      await sessionRepository
        .createQueryBuilder()
        .update(ChatSession)
        .set({ status: 'bot' })
        .where('id = :id AND status = :status', { id: session.id, status: 'waiting' })
        .execute();
    }

    return true;
  }

  // ── n8n forwarding failed ──────────────────────────────────────────────
  logger.error(`n8n forwarding failed for session ${session.id}`, { error: result.error });

  // ── RAG fallback (text messages only, when tenant has KB) ──────────
  if (
    session.status === 'bot' &&
    savedMessage.type === 'text' &&
    aiSettings?.enabled &&
    outboundPayload.knowledgeBase?.enabled
  ) {
    try {
      logger.info(`[Fallback] Attempting native RAG for session ${session.id}`);
      const history = await getConversationHistory(session.id, savedMessage.id);
      const messageContent = savedMessage.contentEncrypted
        ? decrypt(savedMessage.content)
        : savedMessage.content;
      // Multi-bot: scope retrieval to the session's bot's attached KBs.
      // Null botId (unattributed/legacy session) → tenant-wide (undefined).
      const botKbIds = session.botId
        ? await getBotKnowledgeBaseIds(AppDataSource, session.botId)
        : undefined;
      // generateResponse needs the LLM provider apiKey, which stays on
      // Tenant.settings.ai.apiKey (NEVER on bot.settings). Merge the bot's
      // behavioural slice with the tenant-held secret only at the call site.
      const { apiKey: tenantApiKey } = await getLlmRuntimeConfigForSession(session);
      const ragSettings = {
        ...aiSettings,
        apiKey: tenantApiKey,
      } as Parameters<typeof generateResponse>[2];
      const ragResult = await generateResponse(
        AppDataSource,
        session.tenantId,
        ragSettings,
        messageContent,
        history,
        botKbIds,
        templateBody
      );

      const botParticipant = await ensureBotParticipant(session, aiSettings);
      await sendBotMessage(session, botParticipant.id, ragResult.response);

      if (ragResult.shouldHandoff && ragResult.handoffReason) {
        await handleBotHandoff(session, botParticipant.id, ragResult.handoffReason as HandoffRequest['reason']);
      }

      logger.info(`[Fallback] Native RAG succeeded for session ${session.id}`);
      return true;
    } catch (ragError) {
      logger.error(`[Fallback] Native RAG also failed for session ${session.id}`, ragError);
    }
  }

  // ── Final fallback: bot message + proper handoff ────────────────────
  try {
    const botParticipant = await ensureBotParticipant(session, aiSettings);
    const fallbackContent = aiSettings?.guardrails?.fallbackMessage ||
      "We're connecting you to an agent. Please hold on.";
    await sendBotMessage(session, botParticipant.id, fallbackContent);
    await handleBotHandoff(session, botParticipant.id, 'bot_error');
  } catch (innerError) {
    logger.error(`Failed to handle n8n failure gracefully for session ${session.id}`, innerError);
  }

  return true;
}

// ── Per-Session Lock + Burst Coalescing ─────────────────────────────────
// Prevents concurrent agent runs on the same session, and coalesces a rapid
// burst of user messages ("Hi" / "I want to book" / "my pipe" / "tomorrow")
// into a single coherent turn instead of answering only the first.
// Uses Redis SET NX with TTL. Falls back to no-lock if Redis is down.

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// Quiet-window the lock holder waits before running, so messages typed in quick
// succession are handled together. 0 in tests to keep the suite fast / avoid
// fake-timer stalls. Tunable in prod via AGENT_BURST_DEBOUNCE_MS without a code change.
const BURST_DEBOUNCE_MS = Number(
  process.env.AGENT_BURST_DEBOUNCE_MS ?? (process.env.NODE_ENV === 'test' ? 0 : 1000),
);
// Safety cap on the drain loop — bounds work even if a user keeps bursting.
const MAX_DRAIN_TURNS = 6;

async function acquireSessionLock(sessionId: string, ttlMs: number = 60000): Promise<boolean> {
  try {
    const { getRedisClient } = await import('../config/redis');
    const redis = getRedisClient();
    if (!redis) return true; // no Redis = no lock (fail open)
    const result = await redis.set(`agent:lock:${sessionId}`, '1', 'PX', ttlMs, 'NX');
    return result === 'OK';
  } catch {
    return true; // fail open
  }
}

// Extend the lock while a multi-turn drain is in progress, so a slow burst
// doesn't let the TTL lapse and admit a concurrent run.
async function refreshSessionLock(sessionId: string, ttlMs: number = 60000): Promise<void> {
  try {
    const { getRedisClient } = await import('../config/redis');
    const redis = getRedisClient();
    if (redis) await redis.pexpire(`agent:lock:${sessionId}`, ttlMs);
  } catch {
    // ignore
  }
}

async function releaseSessionLock(sessionId: string): Promise<void> {
  try {
    const { getRedisClient } = await import('../config/redis');
    const redis = getRedisClient();
    if (redis) await redis.del(`agent:lock:${sessionId}`);
  } catch {
    // ignore
  }
}

// The most recent user text message that has no bot reply after it — i.e. the
// live turn to answer. Returns null when the latest message is already a bot
// reply (everything answered). Earlier burst messages are still picked up: they
// ride along as conversation history for whichever message is the live turn.
async function getLatestUnansweredUserMessage(sessionId: string): Promise<Message | null> {
  const latest = await messageRepository
    .createQueryBuilder('message')
    .leftJoinAndSelect('message.participant', 'participant')
    .where('message.sessionId = :sessionId', { sessionId })
    .andWhere('message.isDeleted = false')
    .andWhere('message.type = :type', { type: 'text' })
    .orderBy('message.createdAt', 'DESC')
    .getOne();
  return latest && latest.participant?.type === 'user' ? latest : null;
}

// ── Platform Agent Path ──────────────────────────────────────────────────

async function platformAgentPath(
  session: ChatSession,
  _savedMessage: Message,
  tenant: Tenant,
  aiSettings: BotAiSettings,
): Promise<boolean> {
  // Acquire per-session lock — prevents concurrent agent runs. The message that
  // wins the lock drives the turn; rapid-fire siblings fail to acquire, return
  // here (already persisted by the /message handler), and get picked up by the
  // drain loop below as part of the same coalesced turn.
  const locked = await acquireSessionLock(session.id);
  if (!locked) {
    logger.info(`Agent already processing session ${session.id}; message queued for the in-flight run`);
    return true;
  }

  try {
    const botParticipant = await ensureBotParticipant(session, aiSettings);

    // Debounce: wait a quiet-window so a burst of messages typed in quick
    // succession settles before we run, and is answered as ONE coherent turn
    // instead of replying only to the first message.
    if (BURST_DEBOUNCE_MS > 0) await sleep(BURST_DEBOUNCE_MS);

    // Drain loop: answer the latest unanswered user message (with the rest of
    // the burst as history) and keep going while new user messages land —
    // including any that arrive *while* the agent is thinking. `processed`
    // guards against re-answering the same message (and any infinite loop if a
    // bot reply fails to persist).
    const processed = new Set<string>();

    for (let turn = 0; turn < MAX_DRAIN_TURNS; turn++) {
      await refreshSessionLock(session.id);
      const pending = await getLatestUnansweredUserMessage(session.id);
      if (!pending || processed.has(pending.id)) break;
      processed.add(pending.id);

      // Show typing indicator while AI processes
      emitToTenantAgents(session.tenantId, 'typing:indicator', {
        sessionId: session.id, isTyping: true, participantType: 'bot',
      });
      emitToSession(session.tenantId, session.id, 'typing:start', {});

      const messageContent = pending.contentEncrypted ? decrypt(pending.content) : pending.content;
      // Exclude the live turn itself; earlier burst messages remain in history
      // so the agent sees the whole burst.
      const history = await getConversationHistory(session.id, pending.id);

      const result: AgentResult = await agentService!.run(
        messageContent,
        session,
        tenant,
        history,
      );

      let handedOff = false;
      switch (result.type) {
        case 'response':
          await sendBotMessage(session, botParticipant.id, result.content, result.quickReplies);
          break;

        case 'error':
          logger.error(`Platform agent error for session ${session.id}`, { error: result.error });
          await sendBotMessage(session, botParticipant.id, result.fallbackMessage);
          await handleBotHandoff(session, botParticipant.id, 'bot_error');
          handedOff = true;
          break;

        case 'budget_exceeded':
          logger.warn(`Platform agent budget exceeded for tenant ${tenant.id}`);
          await sendBotMessage(session, botParticipant.id, result.fallbackMessage);
          await handleBotHandoff(session, botParticipant.id, 'bot_error');
          handedOff = true;
          break;

        case 'max_iterations':
          logger.warn(`Platform agent max iterations for session ${session.id}`);
          await sendBotMessage(session, botParticipant.id, result.fallbackMessage);
          await handleBotHandoff(session, botParticipant.id, 'bot_error');
          handedOff = true;
          break;

        case 'awaiting_confirmation':
          // Confirmation gate — just send the preview message, don't handoff
          await sendBotMessage(session, botParticipant.id, result.message);
          break;
      }

      // Stop typing indicator
      emitToSession(session.tenantId, session.id, 'typing:stop', {});

      // Once handed to a human, stop draining — the bot no longer owns the session.
      if (handedOff) break;

      // Brief settle so a message typed right after this reply joins the same
      // drain rather than racing the lock release.
      if (BURST_DEBOUNCE_MS > 0) await sleep(BURST_DEBOUNCE_MS);
    }

    // Transition waiting → bot on first message (no-op if a handoff moved it on).
    if (session.status === 'waiting') {
      await sessionRepository
        .createQueryBuilder()
        .update(ChatSession)
        .set({ status: 'bot' })
        .where('id = :id AND status = :status', { id: session.id, status: 'waiting' })
        .execute();
    }

    return true;
  } catch (error) {
    emitToSession(session.tenantId, session.id, 'typing:stop', {});
    logger.error(`Platform agent unexpected error for session ${session.id}`, error);
    const fallbackContent = aiSettings?.guardrails?.fallbackMessage ||
      "We're connecting you to an agent. Please hold on.";
    const bp = await ensureBotParticipant(session, aiSettings);
    await sendBotMessage(session, bp.id, fallbackContent);
    await handleBotHandoff(session, bp.id, 'bot_error');
    return true;
  } finally {
    await releaseSessionLock(session.id);
  }
}

// ── RAG Helper Functions ──────────────────────────────────────────────────

/**
 * Find or create a bot Participant for the session
 */
async function ensureBotParticipant(
  session: ChatSession,
  aiSettings: BotAiSettings,
): Promise<Participant> {
  let botParticipant = await participantRepository.findOne({
    where: { sessionId: session.id, type: 'bot', isDeleted: false },
  });

  if (!botParticipant) {
    botParticipant = participantRepository.create({
      sessionId: session.id,
      type: 'bot',
      name: aiSettings?.brandVoice?.name || 'AI Assistant',
      isAnonymous: false,
      joinedAt: new Date(),
    });
    botParticipant = await participantRepository.save(botParticipant);
  }

  return botParticipant;
}

/**
 * Load last 10 messages with participant join to determine role.
 *
 * `excludeMessageId` drops the current inbound message from the history: it is
 * already persisted before the agent runs, so callers that *also* pass it as
 * the live user turn (agent loop / RAG fallback) would otherwise send it to the
 * LLM twice. Exclude it here so it appears exactly once.
 */
async function getConversationHistory(
  sessionId: string,
  excludeMessageId?: string,
): Promise<{ role: 'user' | 'assistant'; content: string }[]> {
  const qb = messageRepository
    .createQueryBuilder('message')
    .leftJoinAndSelect('message.participant', 'participant')
    .where('message.sessionId = :sessionId', { sessionId })
    .andWhere('message.isDeleted = false')
    .andWhere('message.type = :type', { type: 'text' });

  if (excludeMessageId) {
    qb.andWhere('message.id != :excludeMessageId', { excludeMessageId });
  }

  const messages = await qb
    .orderBy('message.createdAt', 'DESC')
    .take(10)
    .getMany();

  // Reverse to chronological order
  return messages.reverse().map((msg) => ({
    role: msg.participant?.type === 'bot' ? 'assistant' as const : 'user' as const,
    content: msg.contentEncrypted ? decrypt(msg.content) : msg.content,
  }));
}

/**
 * Create a bot Message and emit via WebSocket
 */
async function sendBotMessage(
  session: ChatSession,
  botParticipantId: string,
  content: string,
  quickReplies?: Array<{ title: string; value: string }>
): Promise<Message> {
  const metadata = quickReplies?.length ? { quickReplies } : undefined;
  const botMsg = messageRepository.create({
    sessionId: session.id,
    tenantId: session.tenantId,
    participantId: botParticipantId,
    type: 'text' as Message['type'],
    content: encrypt(content),
    contentEncrypted: true,
    status: 'sent' as Message['status'],
    sentAt: new Date(),
    ...(metadata ? { metadata } : {}),
  });
  const saved = await messageRepository.save(botMsg);

  await sessionRepository.increment({ id: session.id }, 'messageCount', 1);
  await sessionRepository.update(session.id, { lastActivityAt: new Date() });

  // Route through outbound router — handles both WebSocket and external channels.
  // Quick replies go to BOTH: the widget renders them as chips (via socketEvent
  // metadata below), and external channels (Messenger/IG/WhatsApp/Telegram) get
  // them as native quick replies via the channel response payload. Each adapter
  // gates on its own supportsQuickReplies/maxQuickReplies, so unsupported
  // channels simply send the text.
  await routeOutboundMessage(
    { type: 'text', content, ...(quickReplies?.length ? { quickReplies } : {}) },
    { sessionId: session.id, tenantId: session.tenantId, messageId: saved.id },
    {
      event: 'message:receive',
      data: {
        id: saved.id,
        type: 'text',
        content,
        senderType: 'bot',
        timestamp: new Date().toISOString(),
        ...(metadata ? { metadata } : {}),
      },
    },
  );

  return saved;
}

/**
 * Transition session to handoff and create a HandoffRequest
 */
async function handleBotHandoff(
  session: ChatSession,
  botParticipantId: string,
  reason: HandoffRequest['reason']
): Promise<void> {
  // Check if handoff is enabled for this bot (multi-bot Phase 4 #16d:
  // features + ai now live on Bot.settings, not Tenant.settings).
  let botSettings: BotSettings | undefined;
  let handoffBot: Bot | undefined;
  try {
    ({ bot: handoffBot, settings: botSettings } = await getBotConfigForSession(session));
  } catch (err) {
    if (err instanceof BotPausedConfigError || err instanceof BotNotFoundConfigError) {
      logger.warn(
        `handleBotHandoff: session ${session.id} points at paused/deleted bot — proceeding with handoff anyway`,
        { error: err.message },
      );
    } else {
      throw err;
    }
  }
  if (botSettings?.features?.handoffEnabled === false) {
    // Handoff disabled — send fallback message but keep session in bot status.
    // fallbackMessage is template-owned, so resolve the effective config.
    const eff = handoffBot ? effectiveConfigFrom(await resolveBoundTemplate(handoffBot)) : null;
    const fallbackMsg = eff?.guardrails.fallbackMessage ||
      botSettings.ai?.guardrails?.fallbackMessage ||
      "I'm sorry, I couldn't find an answer to your question.";
    await sendBotMessage(session, botParticipantId, fallbackMsg);
    logger.info(`Handoff skipped for session ${session.id} (handoff disabled)`, { reason });
    return;
  }

  // Update session status
  session.requestHandoff();
  await sessionRepository.save(session);

  // Create handoff request
  const handoff = handoffRepository.create({
    sessionId: session.id,
    tenantId: session.tenantId,
    requestedBy: botParticipantId,
    requestedAt: new Date(),
    reason,
    priority: 'medium',
  } as Partial<HandoffRequest>);
  await handoffRepository.save(handoff);

  // Notify agents
  emitToTenantAgents(session.tenantId, 'handoff:requested', {
    sessionId: session.id,
    handoffId: handoff.id,
    reason,
    requestedAt: new Date().toISOString(),
  });

  // Push notification to operators (fire-and-forget; never blocks handoff).
  void notificationService
    .createForTenant({
      tenantId: session.tenantId,
      type: 'handoff_requested',
      title: 'New handoff request',
      message: reason
        ? `A visitor needs help: ${reason}`
        : 'A visitor is requesting a human agent.',
      data: { sessionId: session.id, handoffId: handoff.id },
      dedupeBase: `handoff:${handoff.id}`,
    })
    .catch(() => {});

  logger.info(`Bot handoff triggered for session ${session.id}`, { reason });
}
