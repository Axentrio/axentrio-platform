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
import { returningRows } from '../utils/raw-sql';
import { cached } from '../utils/cache';
import { Tenant } from '../database/entities/Tenant';
import { Bot, BotSettings } from '../database/entities/Bot';
import { resolveBoundTemplates, composeTemplateBodies, effectiveConfigFromList, withEffectiveConfig } from '../templates/template-resolver';
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
import { routeOutboundMessage, sendChannelTypingIndicator } from '../channels/outbound-router';
import { config } from '../config/environment';
import { AgentService, AgentResult, AgentImageInput } from '../agent/agent.service';
import { safeOutboundRequest } from '../security/ssrf-guard';
import { ConversationBinding } from '../database/entities/ConversationBinding';
import { ChannelConnection } from '../database/entities/ChannelConnection';
import { getWhatsAppAccessToken } from '../channels/credential-utils';
import { FB_GRAPH_API } from '../channels/meta/graph-api';
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

/**
 * True once both the n8n outbound service and the platform agent service are
 * wired. The turn-coalescer processor checks this before running, so a delayed
 * job that fires during the post-restart boot window re-arms instead of running
 * against half-initialised deps. See plan-message-coalescer.md (deps-ready guard).
 */
export function isForwardingReady(): boolean {
  return outboundService !== null && agentService !== null;
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
  const resolvedTemplates = await resolveBoundTemplates(bot);
  const aiSettings = botSettings.ai ? withEffectiveConfig(botSettings.ai, effectiveConfigFromList(resolvedTemplates)) : botSettings.ai;

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
  const templateBody = composeTemplateBodies(resolvedTemplates, bot.templateMode ?? 'or');

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

// The most recent user message that has no bot reply after it — i.e. the live
// turn to answer. Returns null when the latest message is already a bot reply
// (everything answered). Earlier burst messages are still picked up: they ride
// along as conversation history for whichever message is the live turn.
// `image` messages count too — a photo (with or without a caption) is a turn the
// bot must answer; the agent path attaches the image as vision input.
async function getLatestUnansweredUserMessage(sessionId: string): Promise<Message | null> {
  const latest = await messageRepository
    .createQueryBuilder('message')
    .leftJoinAndSelect('message.participant', 'participant')
    .where('message.sessionId = :sessionId', { sessionId })
    .andWhere('message.isDeleted = false')
    .andWhere('message.type IN (:...types)', { types: ['text', 'image'] })
    .orderBy('message.createdAt', 'DESC')
    .getOne();
  return latest && latest.participant?.type === 'user' ? latest : null;
}

// ── Inbound image → vision input ───────────────────────────────────────────

// Anthropic caps a single base64 image near 5 MB; stay under that.
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
// sharp's detected format → the MIME both LLM providers (Anthropic + OpenAI) accept.
const IMAGE_FORMAT_TO_MIME: Record<string, string> = {
  jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp',
};

// Download an image URL → base64 content part for the vision model.
//
// Uses the SAME mechanism as inbound-media ingestion
// (`UploadService.ingestRemoteFile`): the SSRF-guarded axios path with MANUAL
// redirect following. A bare `fetch()` does NOT reliably retrieve Meta CDN URLs
// from the prod datacenter — they 302-redirect (lookaside → scontent) and the
// CDN rejects the default client. Following redirects manually also lets us
// re-apply `authHeader` on every hop (axios drops Authorization across hosts) —
// required for WhatsApp media, whose download URLs are token-gated. Format is
// sniffed with sharp (authoritative), not the content-type header.
//
// Best-effort: returns null on any failure so the turn degrades to text-only
// rather than erroring the whole reply.
async function downloadImageAsContentPart(
  url: string,
  label: string,
  authHeader?: Record<string, string>,
): Promise<AgentImageInput | null> {
  try {
    let current = url;
    let response: Awaited<ReturnType<typeof safeOutboundRequest>> | undefined;
    for (let hop = 0; hop < 4; hop++) {
      response = await safeOutboundRequest({
        url: current,
        method: 'GET',
        responseType: 'arraybuffer',
        headers: authHeader,
        timeout: 15_000,
        maxContentLength: MAX_IMAGE_BYTES,
        maxBodyLength: MAX_IMAGE_BYTES,
      });
      if (response.status >= 300 && response.status < 400) {
        const location = (response.headers as Record<string, string> | undefined)?.location;
        if (!location) break;
        current = new URL(location, current).toString();
        response = undefined;
        continue;
      }
      break;
    }
    if (!response || response.status < 200 || response.status >= 300) {
      logger.warn(`${label} image fetch failed (status ${response?.status ?? 'redirect-no-location'}) — answering without vision`);
      return null;
    }
    const buf = Buffer.from(response.data as ArrayBuffer);
    if (buf.byteLength === 0 || buf.byteLength > MAX_IMAGE_BYTES) {
      logger.warn(`${label} image rejected (size ${buf.byteLength}B) — answering without vision`);
      return null;
    }
    // Authoritative format sniff via sharp (lazy import keeps the native dep off
    // this hot module's load path).
    const sharp = (await import('sharp')).default;
    let format: string | undefined;
    try {
      format = (await sharp(buf).metadata()).format;
    } catch {
      format = undefined;
    }
    const mimeType = format ? IMAGE_FORMAT_TO_MIME[format] : undefined;
    if (!mimeType) {
      logger.warn(`${label} image format '${format ?? 'unknown'}' unsupported — answering without vision`);
      return null;
    }
    return { mimeType, data: buf.toString('base64') };
  } catch (error) {
    logger.warn(`${label} image fetch threw — answering without vision`, { error });
    return null;
  }
}

// Messenger/Instagram: the stored fileUrl is a directly-fetchable CDN URL.
function fetchInboundImageForAgent(url: string): Promise<AgentImageInput | null> {
  return downloadImageAsContentPart(url, 'Inbound');
}

// WhatsApp: the webhook delivers a media *id*, not a URL. Resolve it via the
// Graph API (`GET /<media-id>`) to a temporary, token-gated download URL, then
// download the bytes — BOTH requests need the connection's WhatsApp access
// token as a Bearer header. The token is resolved from the session's bound
// ChannelConnection.
async function fetchWhatsAppImageForAgent(sessionId: string, mediaId: string): Promise<AgentImageInput | null> {
  try {
    const binding = await AppDataSource.getRepository(ConversationBinding).findOne({
      where: { sessionId },
      select: { channelConnectionId: true },
    });
    if (!binding) {
      logger.warn('WhatsApp image: no conversation binding for session — answering without vision');
      return null;
    }
    const connection = await AppDataSource.getRepository(ChannelConnection).findOne({
      where: { id: binding.channelConnectionId },
    });
    const accessToken = connection ? getWhatsAppAccessToken(connection.credentials) : null;
    if (!accessToken) {
      logger.warn('WhatsApp image: no access token on connection — answering without vision');
      return null;
    }
    const authHeader = { Authorization: `Bearer ${accessToken}` };

    // Step 1: media id → temporary download URL (JSON: { url, mime_type, ... }).
    let mediaUrl: string | undefined;
    try {
      const meta = await safeOutboundRequest({
        url: `${FB_GRAPH_API}/${encodeURIComponent(mediaId)}`,
        method: 'GET',
        headers: authHeader,
        timeout: 15_000,
      });
      mediaUrl = (meta.data as { url?: string } | undefined)?.url;
    } catch (error) {
      logger.warn('WhatsApp image: media-id resolve failed — answering without vision', { error });
      return null;
    }
    if (!mediaUrl) {
      logger.warn('WhatsApp image: media-id resolve returned no url — answering without vision');
      return null;
    }

    // Step 2: download the bytes (token required, may redirect).
    return downloadImageAsContentPart(mediaUrl, 'WhatsApp', authHeader);
  } catch (error) {
    logger.warn('WhatsApp image fetch threw — answering without vision', { error });
    return null;
  }
}

// Resolve an inbound image message into a vision content part, picking the right
// download path per channel: Messenger/IG expose a fetchable fileUrl; WhatsApp
// exposes a token-gated media id in customData. Returns null for non-images and
// on any failure (caller falls back to a text placeholder).
async function resolveInboundImage(pending: Message, session: ChatSession): Promise<AgentImageInput | null> {
  if (pending.type !== 'image') return null;
  let result: AgentImageInput | null = null;
  if (pending.metadata?.fileUrl) {
    result = await fetchInboundImageForAgent(pending.metadata.fileUrl);
  } else if (session.channel === 'whatsapp') {
    const mediaId = (pending.metadata?.customData as Record<string, unknown> | undefined)?.mediaId;
    // TEMP diagnostic (#wa-vision): confirm the branch + mediaId at agent-time.
    logger.warn(`[wa-vision] whatsapp image turn sid=${session.id} mediaId=${typeof mediaId === 'string' ? mediaId : 'MISSING'} metaKeys=${Object.keys(pending.metadata ?? {}).join('|')}`);
    if (typeof mediaId === 'string' && mediaId) {
      result = await fetchWhatsAppImageForAgent(session.id, mediaId);
    }
  }
  // TEMP diagnostic (#wa-vision): what did resolution yield?
  logger.warn(`[wa-vision] resolveInboundImage channel=${session.channel} type=${pending.type} fileUrl=${pending.metadata?.fileUrl ? 'y' : 'n'} -> ${result ? 'IMAGE/' + result.mimeType : 'NULL'}`);
  return result;
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

      // Show typing indicator while AI processes — portal + widget over the
      // WebSocket, and the end user on their external channel (best-effort).
      emitToTenantAgents(session.tenantId, 'typing:indicator', {
        sessionId: session.id, isTyping: true, participantType: 'bot',
      });
      emitToSession(session.tenantId, session.id, 'typing:start', {});
      void sendChannelTypingIndicator(session.id).catch(() => {});

      let messageContent = pending.contentEncrypted ? decrypt(pending.content) : pending.content;
      // Picture turn: fetch the image and hand it to the agent as vision input.
      // If the fetch fails we still answer — with a note so the bot acknowledges
      // the photo instead of replying to an empty message.
      let images: AgentImageInput[] | undefined;
      if (pending.type === 'image') {
        const img = await resolveInboundImage(pending, session);
        if (img) {
          images = [img];
        } else if (!messageContent) {
          messageContent = '[The customer sent an image, but it could not be loaded.]';
        }
      }
      // Exclude the live turn itself; earlier burst messages remain in history
      // so the agent sees the whole burst.
      const history = await getConversationHistory(session.id, pending.id);

      const result: AgentResult = await agentService!.run(
        messageContent,
        session,
        tenant,
        history,
        images,
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

// ── Turn Coalescer: single-run path + durable watermark ────────────────────
// Used by the turn-coalescer (api/src/services/turn-coalescer.ts). Unlike
// platformAgentPath (the legacy fail-open fallback, which keeps its own lock +
// fixed-sleep drain), this path runs the agent EXACTLY ONCE for a snapped
// high-water-mark message, then finalises against the durable tuple watermark on
// chat_sessions. The coalescer owns timing, the run-lock, and re-running.
// See .scratch/plan-message-coalescer.md.

/** Status returned by runTurn so the coalescer can decide clear-vs-re-arm. */
export type RunTurnStatus = 'answered' | 'stale' | 'noop';

/** Benign loser of a watermark race (rolls back the txn → no double reply). */
class WatermarkConflictError extends Error {}

/**
 * Newest UNANSWERED user text/image message for a session — the live turn.
 * "Unanswered" is the durable tuple compare `(created_at, id) >
 * (lastCoalescedAnswerAt, lastCoalescedAnswerMessageId)`; when the watermark is
 * null the whole conversation qualifies (the clause is simply omitted, which is
 * null-safe by construction). Returns null when everything is answered.
 */
export async function getNewestUnansweredUserMessage(session: ChatSession): Promise<Message | null> {
  const qb = messageRepository
    .createQueryBuilder('m')
    .innerJoin('m.participant', 'p')
    .where('m.sessionId = :sid', { sid: session.id })
    .andWhere('m.isDeleted = false')
    .andWhere("m.type IN ('text','image')")
    .andWhere("p.type = 'user'");
  if (session.lastCoalescedAnswerMessageId) {
    // Compare the watermark DB-side: read its created_at from the row with full
    // microsecond precision. Passing session.lastCoalescedAnswerAt (a JS Date,
    // millisecond precision) truncates sub-ms µs, so the already-answered
    // watermark message re-qualifies as "unanswered" and the coalescer re-runs
    // the agent on it forever (re-arm storm → LLM/TPM saturation). Mirrors the
    // DB-side advance in finalizeReply.
    qb.andWhere(
      '(m.created_at, m.id) > ((SELECT created_at FROM messages WHERE id = :wId), :wId)',
      { wId: session.lastCoalescedAnswerMessageId },
    );
  }
  return qb.orderBy('m.createdAt', 'DESC').addOrderBy('m.id', 'DESC').limit(1).getOne();
}

/**
 * Count + first/last createdAt of the unanswered user messages — lets the
 * coalescer recompute `dueAt` from the DB when Redis turn:state was lost
 * (TTL/restart). Returns null when nothing is unanswered.
 */
export async function getUnansweredBounds(
  session: ChatSession,
): Promise<{ count: number; firstAt: Date; lastAt: Date } | null> {
  const qb = messageRepository
    .createQueryBuilder('m')
    .innerJoin('m.participant', 'p')
    .select('COUNT(*)', 'cnt')
    .addSelect('MIN(m.created_at)', 'firstat')
    .addSelect('MAX(m.created_at)', 'lastat')
    .where('m.sessionId = :sid', { sid: session.id })
    .andWhere('m.isDeleted = false')
    .andWhere("m.type IN ('text','image')")
    .andWhere("p.type = 'user'");
  if (session.lastCoalescedAnswerMessageId) {
    // DB-side watermark comparison (full µs precision) — see the note in
    // getNewestUnansweredUserMessage.
    qb.andWhere(
      '(m.created_at, m.id) > ((SELECT created_at FROM messages WHERE id = :wId), :wId)',
      { wId: session.lastCoalescedAnswerMessageId },
    );
  }
  const raw = await qb.getRawOne<{ cnt: string; firstat: string; lastat: string }>();
  if (!raw || Number(raw.cnt) === 0) return null;
  return { count: Number(raw.cnt), firstAt: new Date(raw.firstat), lastAt: new Date(raw.lastat) };
}

/**
 * Conversation history bounded to `<= hwm` (and excluding the hwm message
 * itself, which is the live turn). The created_at is read DB-side from the hwm id
 * for microsecond fidelity. Messages that arrived AFTER the hwm are intentionally
 * left for their own future turn.
 */
async function getCoalescedHistory(
  sessionId: string,
  hwmId: string,
): Promise<{ role: 'user' | 'assistant'; content: string }[]> {
  const messages = await messageRepository
    .createQueryBuilder('message')
    .leftJoinAndSelect('message.participant', 'participant')
    .where('message.sessionId = :sid', { sid: sessionId })
    .andWhere('message.isDeleted = false')
    .andWhere("message.type IN ('text','image')")
    .andWhere('message.id != :hwmId', { hwmId })
    .andWhere(
      '(message.created_at, message.id) <= ((SELECT created_at FROM messages WHERE id = :hwmId), :hwmId)',
      { hwmId },
    )
    .orderBy('message.createdAt', 'DESC')
    .addOrderBy('message.id', 'DESC')
    .take(10)
    .getMany();

  return messages.reverse().map((msg) => {
    const text = msg.contentEncrypted ? decrypt(msg.content) : msg.content;
    const content = msg.type === 'image' ? (text ? `[Image] ${text}` : '[Image]') : text;
    return {
      role: msg.participant?.type === 'bot' ? ('assistant' as const) : ('user' as const),
      content,
    };
  });
}

/**
 * Persist the bot reply AND advance the durable watermark in ONE transaction.
 * - When `staleGuard`, first check for a user message newer than the hwm; if one
 *   exists the computed reply is stale → return 'stale' WITHOUT writing.
 * - The watermark advance is null-safe and DB-side (created_at read from the hwm
 *   row, never a JS ms param). It must affect exactly one row; otherwise another
 *   run already advanced past hwm → roll back (no double reply).
 * Outbound delivery happens AFTER commit (caller), so a crash before commit
 * re-runs the turn rather than marking it answered without a persisted reply.
 */
async function finalizeReply(
  session: ChatSession,
  botParticipantId: string,
  content: string,
  quickReplies: Array<{ title: string; value: string }> | undefined,
  hwmId: string,
  staleGuard: boolean,
): Promise<{ status: 'answered'; savedId: string } | { status: 'stale' }> {
  try {
    return await AppDataSource.transaction(async (manager) => {
      if (staleGuard) {
        const r = await manager.query(
          `SELECT EXISTS(
             SELECT 1 FROM messages m
             JOIN participants p ON p.id = m.participant_id
             WHERE m.session_id = $1 AND m.is_deleted = false
               AND m.type IN ('text','image') AND p.type = 'user'
               AND (m.created_at, m.id) > ((SELECT created_at FROM messages WHERE id = $2), $2)
           ) AS has_newer`,
          [session.id, hwmId],
        );
        if (r?.[0]?.has_newer) return { status: 'stale' as const };
      }

      const metadata = quickReplies?.length ? { quickReplies } : undefined;
      const repo = manager.getRepository(Message);
      const saved = await repo.save(
        repo.create({
          sessionId: session.id,
          tenantId: session.tenantId,
          participantId: botParticipantId,
          type: 'text' as Message['type'],
          content: encrypt(content),
          contentEncrypted: true,
          status: 'sent' as Message['status'],
          sentAt: new Date(),
          ...(metadata ? { metadata } : {}),
        }),
      );

      const upd = await manager.query(
        `UPDATE chat_sessions s
            SET last_coalesced_answer_at = m.created_at,
                last_coalesced_answer_message_id = m.id
           FROM messages m
          WHERE s.id = $1 AND m.id = $2
            AND (s.last_coalesced_answer_at IS NULL
                 OR (s.last_coalesced_answer_at, s.last_coalesced_answer_message_id)
                    < (m.created_at, m.id))
          RETURNING s.id`,
        [session.id, hwmId],
      );
      if (returningRows<{ id: string }>(upd).length !== 1) {
        // Another run already advanced past hwm — roll back this reply.
        throw new WatermarkConflictError();
      }

      await manager.query(
        `UPDATE chat_sessions
            SET message_count = message_count + 1, last_activity_at = now()
          WHERE id = $1`,
        [session.id],
      );

      return { status: 'answered' as const, savedId: saved.id };
    });
  } catch (err) {
    if (err instanceof WatermarkConflictError) {
      logger.info(`[coalescer] watermark race for session ${session.id} — treating as stale`);
      return { status: 'stale' as const };
    }
    throw err;
  }
}

/** Outbound delivery for a persisted bot message (post-commit). */
async function routeBotMessageOutbound(
  session: ChatSession,
  savedId: string,
  content: string,
  quickReplies?: Array<{ title: string; value: string }>,
): Promise<void> {
  const metadata = quickReplies?.length ? { quickReplies } : undefined;
  await routeOutboundMessage(
    { type: 'text', content, ...(quickReplies?.length ? { quickReplies } : {}) },
    { sessionId: session.id, tenantId: session.tenantId, messageId: savedId },
    {
      event: 'message:receive',
      data: {
        id: savedId,
        type: 'text',
        content,
        senderType: 'bot',
        timestamp: new Date().toISOString(),
        ...(metadata ? { metadata } : {}),
      },
    },
  );
}

/**
 * Run the platform agent EXACTLY ONCE for the snapped `pending` (= hwm) message,
 * with history bounded to `<= hwm`, then finalise. The coalescer (not this fn)
 * owns the run-lock, timing, and re-running. Returns 'answered' | 'stale' |
 * 'noop' so the coalescer can clear state or re-arm.
 */
export async function runTurn(session: ChatSession, pending: Message): Promise<RunTurnStatus> {
  const tenant = await tenantRepository.findOne({ where: { id: session.tenantId } });
  if (!tenant) return 'noop';

  let botSettings: BotSettings;
  let bot: Bot;
  try {
    ({ bot, settings: botSettings } = await getBotConfigForSession(session));
  } catch (err) {
    if (err instanceof BotPausedConfigError || err instanceof BotNotFoundConfigError) {
      logger.warn(`[coalescer] session ${session.id} points at a paused/deleted bot — skipping`, {
        error: (err as Error).message,
      });
      return 'noop';
    }
    throw err;
  }

  const resolvedTemplates = await resolveBoundTemplates(bot);
  const aiSettings = botSettings.ai
    ? withEffectiveConfig(botSettings.ai, effectiveConfigFromList(resolvedTemplates))
    : botSettings.ai;
  if (!aiSettings?.enabled || !agentService) return 'noop';

  const botParticipant = await ensureBotParticipant(session, aiSettings);

  // Typing indicators — portal + widget over WS, and the end user's channel.
  emitToTenantAgents(session.tenantId, 'typing:indicator', {
    sessionId: session.id, isTyping: true, participantType: 'bot',
  });
  emitToSession(session.tenantId, session.id, 'typing:start', {});
  void sendChannelTypingIndicator(session.id).catch(() => {});

  let messageContent = pending.contentEncrypted ? decrypt(pending.content) : pending.content;
  let images: AgentImageInput[] | undefined;
  if (pending.type === 'image') {
    const img = await resolveInboundImage(pending, session);
    if (img) images = [img];
    else if (!messageContent) messageContent = '[The customer sent an image, but it could not be loaded.]';
  }

  const history = await getCoalescedHistory(session.id, pending.id);

  let result: AgentResult;
  try {
    result = await agentService.run(messageContent, session, tenant, history, images);
  } finally {
    emitToSession(session.tenantId, session.id, 'typing:stop', {});
  }

  // Map the agent result to (content, handoff, stale-guard). Only the normal
  // answer paths are stale-guarded; error/handoff paths always finalise so the
  // turn isn't retried forever (the human picks up the newer messages).
  let content: string;
  let handoffReason: HandoffRequest['reason'] | null = null;
  let staleGuard = false;
  switch (result.type) {
    case 'response':
      content = result.content;
      staleGuard = true;
      break;
    case 'awaiting_confirmation':
      content = result.message;
      staleGuard = true;
      break;
    case 'error':
      logger.error(`[coalescer] agent error for session ${session.id}`, { error: result.error });
      content = result.fallbackMessage;
      handoffReason = 'bot_error';
      break;
    case 'budget_exceeded':
      logger.warn(`[coalescer] agent budget exceeded for tenant ${tenant.id}`);
      content = result.fallbackMessage;
      handoffReason = 'bot_error';
      break;
    case 'max_iterations':
      logger.warn(`[coalescer] agent max iterations for session ${session.id}`);
      content = result.fallbackMessage;
      handoffReason = 'bot_error';
      break;
  }
  const quickReplies = result.type === 'response' ? result.quickReplies : undefined;

  const fin = await finalizeReply(session, botParticipant.id, content, quickReplies, pending.id, staleGuard);
  if (fin.status === 'stale') return 'stale';

  await routeBotMessageOutbound(session, fin.savedId, content, quickReplies);

  if (handoffReason) await handleBotHandoff(session, botParticipant.id, handoffReason);

  if (session.status === 'waiting') {
    await sessionRepository
      .createQueryBuilder()
      .update(ChatSession)
      .set({ status: 'bot' })
      .where('id = :id AND status = :status', { id: session.id, status: 'waiting' })
      .execute();
  }

  return 'answered';
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
    .andWhere('message.type IN (:...types)', { types: ['text', 'image'] });

  if (excludeMessageId) {
    qb.andWhere('message.id != :excludeMessageId', { excludeMessageId });
  }

  const messages = await qb
    .orderBy('message.createdAt', 'DESC')
    .take(10)
    .getMany();

  // Reverse to chronological order. Past images are summarised as a text
  // placeholder (plus any caption) rather than re-sent as vision input — their
  // channel CDN URLs are short-lived, and only the live turn's image needs to be
  // re-fetched and shown to the model.
  return messages.reverse().map((msg) => {
    const text = msg.contentEncrypted ? decrypt(msg.content) : msg.content;
    const content = msg.type === 'image'
      ? (text ? `[Image] ${text}` : '[Image]')
      : text;
    return {
      role: msg.participant?.type === 'bot' ? 'assistant' as const : 'user' as const,
      content,
    };
  });
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
    const eff = handoffBot ? effectiveConfigFromList(await resolveBoundTemplates(handoffBot)) : null;
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
