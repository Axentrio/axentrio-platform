/**
 * Message Forwarding Service
 * Handles forwarding visitor messages to n8n webhooks
 * Used by both WebSocket handler and HTTP chat routes
 */

import { randomUUID } from 'crypto';
import type { EntityManager } from 'typeorm';
import { logger } from '../utils/logger';
import { AppDataSource } from '../database/data-source';
import { notificationService } from './notification.service';
import { ChatSession } from '../database/entities/ChatSession';
import { Message } from '../database/entities/Message';
import { MessageDelivery } from '../database/entities/MessageDelivery';
import { AddressOffer } from '../database/entities/AddressOffer';
import { decrypt, encrypt } from '../utils/encryption';
import { returningRows } from '../utils/raw-sql';
import { cached } from '../utils/cache';
import { Tenant } from '../database/entities/Tenant';
import { Bot, BotSettings } from '../database/entities/Bot';
import { resolveBoundTemplates, effectiveConfigFromList, withEffectiveConfig } from '../templates/template-resolver';
import { Participant } from '../database/entities/Participant';
import { HandoffRequest } from '../database/entities/HandoffRequest';
import { composeSystemPrompt } from '../llm/compose-system-prompt';
import { TenantAiConfig, KnowledgeBaseMetadata } from '../channels/response.types';
import { emitToTenantAgents, emitToSession } from '../websocket/socket.handler';
import { emitConversationUpsert, emitMessageCreated } from '../realtime/conversation-events';
import { routeOutboundMessage, sendChannelTypingIndicator } from '../channels/outbound-router';
import type { OfferMeasurement } from '../channels/response.types';
import { storedAffordance } from '../agent/tool-adapter';
import type { Affordance, StoredAffordance } from '../agent/tool-adapter';
import { markQuestionAsked } from '../booking/travel/address-binding';
import { AgentService, AgentResult, AgentImageInput } from '../agent/agent.service';
import { safeOutboundRequest } from '../security/ssrf-guard';
import { ConversationBinding } from '../database/entities/ConversationBinding';
import { ChannelConnection } from '../database/entities/ChannelConnection';
import { getWhatsAppAccessToken } from '../channels/credential-utils';
import { FB_GRAPH_API } from '../channels/meta/graph-api';
import {
  getBotConfigForSession,
  BotPausedConfigError,
  BotNotFoundConfigError,
} from './bot-config.service';
import { conversationCommands } from './conversation-command.service';
import { runInboundGate } from '../guardrails/inbound-guardrails.service';
import { applyOutputGuardrails } from '../guardrails/output-guardrails.service';
import { localizeMessage } from '../llm/localize';
import { isOutsideBusinessHours } from '../utils/format-business-hours';
import { renderChannelAddressControls } from '../channels/address-controls';

/** Bot.settings['ai'] alias — the behavioural slice (no apiKey). */
type BotAiSettings = BotSettings['ai'];

const sessionRepository = AppDataSource.getRepository(ChatSession);
const messageRepository = AppDataSource.getRepository(Message);
const tenantRepository = AppDataSource.getRepository(Tenant);
const participantRepository = AppDataSource.getRepository(Participant);

// Module-level service reference, set via initializeAgentService().
let agentService: AgentService | null = null;

export function initializeAgentService(agent: AgentService): void {
  agentService = agent;
  logger.info('Platform agent service initialized for message forwarding');
}

/**
 * True once the platform agent service is wired. The turn-coalescer processor
 * checks this before running, so a delayed job that fires during the post-restart
 * boot window re-arms instead of running against an un-wired agent. See
 * plan-message-coalescer.md (deps-ready guard).
 */
export function isForwardingReady(): boolean {
  return agentService !== null;
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
    // n8n has its own prompt handling — pass the bot's template body through with
    // {placeholders} resolved, but without a legacy fallback (no template → empty
    // systemPrompt). Composed via the n8n mode of the single composer (no default
    // block, no platform rules, no module sections — T14). The former
    // brandVoice.customInstructions layer is retired and no longer contributes.
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
 * Forward a visitor message to n8n if applicable.
 * Called after the message is saved to DB and broadcast via WebSocket.
 *
 * Returns true if the message was forwarded (or fallback triggered).
 */
export async function forwardMessageToN8n(
  session: ChatSession,
  savedMessage: Message,
): Promise<boolean> {
  // Only forward visitor messages when session is in bot or waiting status
  if (session.status !== 'bot' && session.status !== 'waiting') {
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

  // External n8n forwarding has been retired — every AI-enabled bot is answered by
  // the in-house platform agent. Bots with AI off (or before the agent service is
  // wired) stay waiting for a human to pick up.
  const willUsePlatformAgent = !!aiSettings?.enabled && !!agentService;
  if (!willUsePlatformAgent) {
    return false;
  }

  // ── Global guardrails gate (spam/scam/bot-loop) ───────────────────────
  // Single per-message gate for the legacy path, placed BEFORE the local
  // autoresponders (business-hours / escalation) so spam never receives an
  // off-hours or fallback reply. Covers BOTH the platform-agent and custom-webhook
  // branches below. Every inbound message reaches this entry exactly once
  // (scheduleTurn → forwardMessageToN8n per message), so the drain loop does NOT
  // re-gate (that would double-count). The coalescer path (runTurn) runs the same
  // gate under its own lock. The gate is idempotent per message (guardrail_checked
  // claim), so a message that's also seen by the coalescer window isn't
  // double-counted. Shadow mode logs only.
  if (savedMessage.type === 'text' || savedMessage.type === 'image') {
    const gateContent = savedMessage.contentEncrypted ? decrypt(savedMessage.content) : (savedMessage.content || '');
    const gate = await runInboundGate({
      session, tenantId: session.tenantId, message: savedMessage, content: gateContent, channel: session.channel,
    });
    if (!gate.proceed) {
      logger.info(`[guardrails] message blocked for session ${session.id} (${gate.category})`);
      return true; // handled — no reply, no forward
    }
  }

  // ── Pre-forwarding checks (cheap, local) — shared with the coalesced path ──
  if (aiSettings) {
    const plainContent = savedMessage.contentEncrypted ? decrypt(savedMessage.content) : (savedMessage.content || '');
    const auto = localAutoresponse(session, savedMessage.type, plainContent, botSettings, aiSettings, bot.businessTimezone);
    if (auto) {
      const botParticipant = await ensureBotParticipant(session, aiSettings);
      // Localize the canned off-hours/escalation message to the customer's
      // language (fail-open to the original).
      const autoMsg = await localizeMessage(auto.message, plainContent, session);
      try {
        // Fenced on the ingress-loaded entity's version: a takeover between the
        // message arriving and this canned reply suppresses it.
        await sendBotMessage(session, botParticipant.id, autoMsg, undefined, undefined, {
          ownershipVersion: session.ownershipVersion ?? 0,
        });
      } catch (err) {
        if (err instanceof OwnershipChangedError) {
          logger.info(`[legacy] canned reply suppressed for session ${session.id} — ownership changed`);
          return true;
        }
        throw err;
      }
      if (auto.kind === 'escalation') {
        await handleBotHandoff(session, botParticipant.id, 'bot_escalation_keyword');
      }
      return true;
    }
  }

  // ── Platform agent path ──────────────────────────────────────────────
  return platformAgentPath(session, savedMessage, tenant, aiSettings);
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

// Owner-token lock — `agent:lock:{sessionId}` is SHARED with the coalescer
// (turn-coalescer.ts), so refresh/release MUST be owner-token-scoped: an
// unconditional PEXPIRE/DEL here could extend or delete a lock the coalescer
// owns (and vice-versa) → concurrent runs / double reply. acquire returns the
// token to pass back to refresh/release; NO_REDIS_LOCK is the fail-open sentinel.
const NO_REDIS_LOCK = 'no-redis';
const LOCK_REFRESH_LUA = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('PEXPIRE', KEYS[1], ARGV[2]) end return 0`;
const LOCK_RELEASE_LUA = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0`;

async function acquireSessionLock(sessionId: string, ttlMs: number = 60000): Promise<string | null> {
  try {
    const { getRedisClient } = await import('../config/redis');
    const redis = getRedisClient();
    if (!redis) return NO_REDIS_LOCK; // no Redis = no lock (fail open)
    const token = randomUUID();
    const result = await redis.set(`agent:lock:${sessionId}`, token, 'PX', ttlMs, 'NX');
    return result === 'OK' ? token : null;
  } catch {
    return NO_REDIS_LOCK; // fail open
  }
}

// Extend the lock while a multi-turn drain is in progress, so a slow burst
// doesn't let the TTL lapse and admit a concurrent run. Owner-token-scoped.
async function refreshSessionLock(sessionId: string, token: string, ttlMs: number = 60000): Promise<void> {
  if (token === NO_REDIS_LOCK) return;
  try {
    const { getRedisClient } = await import('../config/redis');
    const redis = getRedisClient();
    if (redis) await redis.eval(LOCK_REFRESH_LUA, 1, `agent:lock:${sessionId}`, token, String(ttlMs));
  } catch {
    // ignore
  }
}

async function releaseSessionLock(sessionId: string, token: string): Promise<void> {
  if (token === NO_REDIS_LOCK) return;
  try {
    const { getRedisClient } = await import('../config/redis');
    const redis = getRedisClient();
    if (redis) await redis.eval(LOCK_RELEASE_LUA, 1, `agent:lock:${sessionId}`, token);
  } catch {
    // ignore
  }
}

// Advance the durable coalesced-answer watermark to `messageId` (DB-side, µs
// precision, monotonic). The legacy platformAgentPath calls this after answering
// a message so that — when the coalescer is enabled and a message reached the
// legacy path via the fail-open fallback — a coalescer job for the same session
// won't re-answer it (the watermark is the coalescer's "answered" source of
// truth). No-op-safe when the coalescer is off (nothing reads the watermark).
export async function advanceCoalescedWatermark(sessionId: string, messageId: string): Promise<void> {
  try {
    await sessionRepository.query(
      `UPDATE chat_sessions s
          SET last_coalesced_answer_at = m.created_at,
              last_coalesced_answer_message_id = m.id
         FROM messages m
        WHERE s.id = $1 AND m.id = $2
          AND (s.last_coalesced_answer_at IS NULL
               OR (s.last_coalesced_answer_at, s.last_coalesced_answer_message_id)
                  < (m.created_at, m.id))`,
      [sessionId, messageId],
    );
  } catch (err) {
    logger.warn('[coalescer] legacy watermark advance failed', {
      sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// Local autoresponder decision (off-hours / escalation-keyword), shared by the
// legacy forwardMessageToN8n path and the coalesced runTurn path so the two can't
// diverge (the coalescer previously skipped both gates). Returns null when the
// agent should run normally. Mirrors the legacy gate: text turns on bot-owned
// sessions with AI enabled only.
/**
 * Off-hours kill-switch, read per-call so it is togglable at runtime (and in
 * tests). Default ON: the AI runs off-hours and the `## AVAILABILITY` prompt fact
 * tells it the business is currently closed, so it keeps helping (opening hours are
 * informational). Set OFF_HOURS_AI_REPLY=false to restore the old behaviour — a
 * canned off-hours reply that short-circuits the agent — instantly, no deploy.
 */
function offHoursCannedReplyEnabled(): boolean {
  return process.env.OFF_HOURS_AI_REPLY === 'false';
}

function localAutoresponse(
  session: ChatSession,
  messageType: Message['type'],
  plainContent: string,
  botSettings: BotSettings,
  aiSettings: BotAiSettings,
  businessTimezone: string,
): { kind: 'off_hours' | 'escalation'; message: string } | null {
  if (session.status !== 'bot' || messageType !== 'text' || !aiSettings?.enabled) return null;

  // Off-hours. With the kill-switch ON (default) the AI runs and the
  // `## AVAILABILITY` fact carries the closed state into the prompt; only the
  // switch OFF short-circuits with the canned message. Detection is the shared
  // `isOutsideBusinessHours` predicate — one definition for the gate and the
  // prompt — anchored to the bot's canonical `businessTimezone`, never the
  // browser-written `businessHours.timezone`.
  if (offHoursCannedReplyEnabled() && isOutsideBusinessHours(botSettings.businessHours, businessTimezone)) {
    return {
      kind: 'off_hours',
      message: aiSettings.guardrails?.offHoursMessage || "We're currently outside business hours. We'll get back to you soon.",
    };
  }

  const escalationKeywords = aiSettings.guardrails?.escalationKeywords || [];
  const lowerContent = plainContent.toLowerCase();
  const matched = escalationKeywords.find((kw: string) => lowerContent.includes(kw.toLowerCase()));
  if (matched) {
    logger.info(`Escalation keyword "${matched}" detected in session ${session.id}`);
    return {
      kind: 'escalation',
      message: aiSettings.guardrails?.fallbackMessage || "I'm connecting you to a human agent.",
    };
  }

  return null;
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
    .andWhere('message.guardrailFlagged = false')
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
  if (pending.metadata?.fileUrl) {
    return fetchInboundImageForAgent(pending.metadata.fileUrl);
  }
  if (session.channel === 'whatsapp') {
    const mediaId = (pending.metadata?.customData as Record<string, unknown> | undefined)?.mediaId;
    if (typeof mediaId === 'string' && mediaId) {
      return fetchWhatsAppImageForAgent(session.id, mediaId);
    }
  }
  return null;
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
  const lockToken = await acquireSessionLock(session.id);
  if (!lockToken) {
    logger.info(`Agent already processing session ${session.id}; message queued for the in-flight run`);
    return true;
  }

  try {
    const botParticipant = await ensureBotParticipant(session, aiSettings);
    const fallbackMessage =
      aiSettings?.guardrails?.fallbackMessage || "We're connecting you to an agent. Please hold on.";

    /**
     * The owner's canned wording, said in the language the customer is writing in.
     *
     * The fallback is a tenant setting, so it is written once in the business's own language and
     * then posted verbatim to everybody. Observed in production: an English customer asked about a
     * Sunday and was answered `Laat me je verbinden met ons team`. The off-hours message already
     * goes through this exact helper for the same reason; these three exits were simply missed.
     *
     * Fail-open by construction - `localizeMessage` returns the original when the languages match
     * or when anything at all goes wrong, so a translation outage costs the old behaviour and
     * never a missing reply.
     */
    const inCustomerLanguage = (message: string, customerText: string) =>
      localizeMessage(message, customerText, session);

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
      await refreshSessionLock(session.id, lockToken);
      const pending = await getLatestUnansweredUserMessage(session.id);
      if (!pending || processed.has(pending.id)) break;
      processed.add(pending.id);
      // No guardrails gate here: every message was already gated at its own
      // forwardMessageToN8n entry (above), so the drain only coalesces
      // already-gated messages. Re-gating would double-count loop counters.
      // But re-check the guardrail pause each turn — a concurrent spam message
      // could have disabled the session mid-drain. Ownership is re-read too:
      // a human claim mid-drain ends the bot's turn-taking (B2), and the
      // version is the fence base for this turn's commit.
      const live = await sessionRepository.findOne({
        where: { id: session.id },
        select: { id: true, aiAutoReplyEnabled: true, ownership: true, ownershipVersion: true } as never,
      });
      if (live && live.aiAutoReplyEnabled === false) break;
      if (live && live.ownership !== 'bot_owned') break;
      const turnOwnershipVersion = live?.ownershipVersion ?? session.ownershipVersion ?? 0;

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

      // In-flight pause: a concurrent guardrail block may have disabled the
      // session while the agent was thinking — don't send the reply. A moved
      // ownership_version (human takeover, even a claim→release ABA) equally
      // suppresses it; the sendBotMessage fence below closes the remaining
      // read-to-commit race transactionally.
      const liveAfter = await sessionRepository.findOne({
        where: { id: session.id },
        select: { id: true, aiAutoReplyEnabled: true, ownershipVersion: true } as never,
      });
      if (liveAfter && liveAfter.aiAutoReplyEnabled === false) {
        emitToSession(session.tenantId, session.id, 'typing:stop', {});
        break;
      }
      if (liveAfter && (liveAfter.ownershipVersion ?? 0) !== turnOwnershipVersion) {
        emitToSession(session.tenantId, session.id, 'typing:stop', {});
        break;
      }
      const fence = { ownershipVersion: turnOwnershipVersion };

      let handedOff = false;
      // An upstream failure sends the fallback but writes NO handoff (the bot keeps
      // the session); it must still stop the drain, or the outage becomes a storm of
      // failing runs over the rest of the burst.
      let stopDrain = false;
      // The customer explicitly asked for a human and `escalate_to_human`
      // succeeded this run. Exactly ONE handoff per turn: every per-case
      // `bot_error` handoff below stands down, and one `escalation_trigger`
      // handoff fires AFTER the reply — winning even over an `error` exit,
      // INCLUDING `infraFailure` (which otherwise does not hand off): a provider
      // outage is no reason to lose a human the customer explicitly asked for.
      const explicitHandoff = result.handoffRequested === true;
      try {
      switch (result.type) {
        case 'response': {
          // Output guardrails (AC14): a blocked AI reply is treated like an agent
          // error — send the fallback (no quick replies) + hand off to a human.
          const guard = await applyOutputGuardrails({
            tenantId: tenant.id, session, channel: session.channel,
            content: result.content, fallbackMessage, generationPath: 'legacy',
          });
          if (guard.blocked) {
            await sendBotMessage(session, botParticipant.id, guard.content, undefined, undefined, fence);
            if (!explicitHandoff) {
              await handleBotHandoff(session, botParticipant.id, 'bot_error');
              handedOff = true;
            }
          } else {
            await sendBotMessage(
              session,
              botParticipant.id,
              result.content,
              { quickReplies: result.quickReplies, affordance: result.affordance },
              result.offer,
              fence,
            );
          }
          break;
        }

        case 'error':
          logger.error(`Platform agent error for session ${session.id}`, { error: result.error });
          await sendBotMessage(session, botParticipant.id, await inCustomerLanguage(result.fallbackMessage, messageContent), undefined, undefined, fence);
          // Mirror the coalescer path: an UPSTREAM failure (out of credit, throttled,
          // provider down, queue/Redis unreachable) hits every conversation at once.
          // Handing it to a human parks the whole inbox and SILENCES the bot for the
          // 60-minute sweep. So send the fallback, stop the drain, and keep the session
          // with the bot. A genuine bot fault still escalates.
          if (result.infraFailure) {
            stopDrain = true;
          } else if (!explicitHandoff) {
            await handleBotHandoff(session, botParticipant.id, 'bot_error');
            handedOff = true;
          }
          break;

        case 'budget_exceeded':
          logger.warn(`Platform agent budget exceeded for tenant ${tenant.id}`);
          await sendBotMessage(session, botParticipant.id, await inCustomerLanguage(result.fallbackMessage, messageContent), undefined, undefined, fence);
          if (!explicitHandoff) {
            await handleBotHandoff(session, botParticipant.id, 'bot_error');
            handedOff = true;
          }
          break;

        case 'max_iterations':
          logger.warn(`Platform agent max iterations for session ${session.id}`);
          await sendBotMessage(session, botParticipant.id, await inCustomerLanguage(result.fallbackMessage, messageContent), undefined, undefined, fence);
          if (!explicitHandoff) {
            await handleBotHandoff(session, botParticipant.id, 'bot_error');
            handedOff = true;
          }
          break;

        case 'awaiting_confirmation': {
          // Confirmation gate — just send the preview message, don't handoff
          // (unless output guardrails block it in enforce mode).
          const guard = await applyOutputGuardrails({
            tenantId: tenant.id, session, channel: session.channel,
            content: result.message, fallbackMessage, generationPath: 'legacy',
          });
          if (guard.blocked) {
            await sendBotMessage(session, botParticipant.id, guard.content, undefined, undefined, fence);
            if (!explicitHandoff) {
              await handleBotHandoff(session, botParticipant.id, 'bot_error');
              handedOff = true;
            }
          } else {
            await sendBotMessage(session, botParticipant.id, result.message, undefined, undefined, fence);
          }
          break;
        }
      }

      // The one explicit-escalation handoff, after the reply reached the customer.
      if (explicitHandoff) {
        await handleBotHandoff(session, botParticipant.id, 'escalation_trigger');
        handedOff = true;
      }
      } catch (err) {
        // The commit-time fence: ownership moved between the liveAfter read and
        // the reply's persist transaction (a human claimed the conversation).
        // Suppress the reply AND the follow-up handoff, and stop draining — the
        // human owns the turn-taking now.
        if (err instanceof OwnershipChangedError) {
          logger.info(`[legacy] bot reply suppressed for session ${session.id} — ownership changed mid-run`);
          emitToSession(session.tenantId, session.id, 'typing:stop', {});
          break;
        }
        throw err;
      }

      // Stop typing indicator
      emitToSession(session.tenantId, session.id, 'typing:stop', {});

      // Keep the durable coalesced watermark current: if the coalescer is enabled
      // and this message reached the legacy path via the fail-open fallback, this
      // stops a coalescer job from re-answering the same message.
      await advanceCoalescedWatermark(session.id, pending.id);

      // Stop draining when the turn was handed to a human (the bot no longer owns
      // the session), OR when an upstream failure means re-running the agent now
      // would only fail again over the rest of the burst.
      if (handedOff || stopDrain) break;

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
    // Emergency fallback goes through the SAME transactional fence as the
    // ordinary replies (S1): re-read ownership + version, then let the
    // FOR UPDATE check in sendBotMessage close the read-to-commit race — an
    // ownership check alone is blind to a claim→release ABA mid-failure.
    const ownNow = await sessionRepository.findOne({
      where: { id: session.id },
      select: { id: true, ownership: true, ownershipVersion: true } as never,
    });
    if (ownNow && ownNow.ownership === 'bot_owned') {
      const fallbackContent = aiSettings?.guardrails?.fallbackMessage ||
        "We're connecting you to an agent. Please hold on.";
      const bp = await ensureBotParticipant(session, aiSettings);
      try {
        await sendBotMessage(session, bp.id, fallbackContent, undefined, undefined, {
          ownershipVersion: ownNow.ownershipVersion ?? 0,
        });
        await handleBotHandoff(session, bp.id, 'bot_error');
      } catch (err) {
        if (!(err instanceof OwnershipChangedError)) throw err;
        logger.info(`[legacy] emergency fallback suppressed for session ${session.id} — ownership changed`);
      }
    }
    return true;
  } finally {
    await releaseSessionLock(session.id, lockToken);
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
    .andWhere("p.type = 'user'")
    .andWhere('m.guardrailFlagged = false');
  if (session.lastCoalescedAnswerMessageId) {
    // Compare the watermark DB-side: read its created_at from the row with full
    // microsecond precision. Passing session.lastCoalescedAnswerAt (a JS Date,
    // millisecond precision) truncates sub-ms µs, so the already-answered
    // watermark message re-qualifies as "unanswered" and the coalescer re-runs
    // the agent on it forever (re-arm storm → LLM/TPM saturation). Mirrors the
    // DB-side advance in finalizeReply. COALESCE falls back to the stored
    // last_coalesced_answer_at if the watermark message was hard-deleted, so the
    // bot doesn't silently stall (the subquery would otherwise return NULL).
    qb.andWhere(
      '(m.created_at, m.id) > (COALESCE((SELECT created_at FROM messages WHERE id = :wId), :wAt), :wId)',
      { wId: session.lastCoalescedAnswerMessageId, wAt: session.lastCoalescedAnswerAt },
    );
  }
  return qb.orderBy('m.createdAt', 'DESC').addOrderBy('m.id', 'DESC').limit(1).getOne();
}

/**
 * OLDEST unanswered user message (same watermark predicate, ascending). Used by
 * the custom-webhook recovery drain to forward a backlog oldest→newest one at a
 * time, advancing the watermark after each — so an arbitrarily large backlog is
 * forwarded exactly once with no message hidden behind the watermark.
 */
export async function getOldestUnansweredUserMessage(
  session: ChatSession,
  upToHwmId?: string,
): Promise<Message | null> {
  const qb = messageRepository
    .createQueryBuilder('m')
    .innerJoin('m.participant', 'p')
    .where('m.sessionId = :sid', { sid: session.id })
    .andWhere('m.isDeleted = false')
    .andWhere("m.type IN ('text','image')")
    .andWhere("p.type = 'user'")
    .andWhere('m.guardrailFlagged = false');
  if (session.lastCoalescedAnswerMessageId) {
    qb.andWhere(
      '(m.created_at, m.id) > (COALESCE((SELECT created_at FROM messages WHERE id = :wId), :wAt), :wId)',
      { wId: session.lastCoalescedAnswerMessageId, wAt: session.lastCoalescedAnswerAt },
    );
  }
  // Upper bound: don't drain past the snapped hwm. Messages that arrive DURING a
  // (slow) drain are forwarded by their own ingress path — without this bound the
  // drain loop would re-forward them (double send).
  if (upToHwmId) {
    qb.andWhere(
      '(m.created_at, m.id) <= ((SELECT created_at FROM messages WHERE id = :upTo), :upTo)',
      { upTo: upToHwmId },
    );
  }
  return qb.orderBy('m.createdAt', 'ASC').addOrderBy('m.id', 'ASC').limit(1).getOne();
}

/**
 * All unanswered USER TEXT messages up to (and including) the hwm, oldest-first,
 * capped at `limit`. Used by the coalesced escalation scan to cover the WHOLE
 * burst (legacy checks each message individually), beyond the small guardrails
 * window. Returns plaintext is the caller's job (content stays encrypted here).
 */
export async function getUnansweredUserTextUpTo(
  session: ChatSession,
  hwmId: string,
  limit: number,
): Promise<Message[]> {
  const qb = messageRepository
    .createQueryBuilder('m')
    .innerJoin('m.participant', 'p')
    .where('m.sessionId = :sid', { sid: session.id })
    .andWhere('m.isDeleted = false')
    .andWhere("m.type = 'text'")
    .andWhere("p.type = 'user'")
    .andWhere('m.guardrailFlagged = false')
    .andWhere(
      '(m.created_at, m.id) <= ((SELECT created_at FROM messages WHERE id = :hwmId), :hwmId)',
      { hwmId },
    );
  if (session.lastCoalescedAnswerMessageId) {
    qb.andWhere(
      '(m.created_at, m.id) > (COALESCE((SELECT created_at FROM messages WHERE id = :wId), :wAt), :wId)',
      { wId: session.lastCoalescedAnswerMessageId, wAt: session.lastCoalescedAnswerAt },
    );
  }
  return qb.orderBy('m.createdAt', 'ASC').addOrderBy('m.id', 'ASC').limit(limit).getMany();
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
    .andWhere("p.type = 'user'")
    .andWhere('m.guardrailFlagged = false');
  if (session.lastCoalescedAnswerMessageId) {
    // DB-side watermark comparison (full µs precision) — see the note in
    // getNewestUnansweredUserMessage.
    qb.andWhere(
      '(m.created_at, m.id) > (COALESCE((SELECT created_at FROM messages WHERE id = :wId), :wAt), :wId)',
      { wId: session.lastCoalescedAnswerMessageId, wAt: session.lastCoalescedAnswerAt },
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
    .andWhere('message.guardrailFlagged = false')
    .andWhere('message.id != :hwmId', { hwmId })
    .andWhere(
      '(message.created_at, message.id) <= ((SELECT created_at FROM messages WHERE id = :hwmId), :hwmId)',
      { hwmId },
    )
    .orderBy('message.createdAt', 'DESC')
    .addOrderBy('message.id', 'DESC')
    // One extra row beyond the 10-message window so we can tell whether older
    // history exists (and therefore whether the leading turn is the greeting).
    .take(11)
    .getMany();

  // `messages` is DESC; >10 means older history exists beyond the window.
  const hasOlder = messages.length > 10;
  const turns = messages
    .slice(0, 10)
    .reverse()
    .map((msg) => {
      const text = msg.contentEncrypted ? decrypt(msg.content) : msg.content;
      const content = msg.type === 'image' ? (text ? `[Image] ${text}` : '[Image]') : text;
      return {
        role: msg.participant?.type === 'bot' ? ('assistant' as const) : ('user' as const),
        content,
      };
    });

  // Drop the leading assistant turn ONLY when the window reaches the start of the
  // conversation — that leading assistant turn is the session greeting, a static
  // configured message (often the business default language) that would otherwise
  // anchor the model's reply language on turn 1. When older history exists, the
  // leading turn is a genuine assistant reply, so keep it.
  if (hasOlder) return turns;
  let start = 0;
  while (start < turns.length && turns[start].role === 'assistant') start++;
  return turns.slice(start);
}

/**
 * Unanswered USER messages in the coalesced window — `(watermark, hwm]`,
 * chronological — for the guardrails gate to vet every message that will be
 * answered or enter history (not just the hwm). Excludes already-flagged
 * messages; already-checked-clean ones are included but the gate no-ops them
 * (idempotent claim).
 *
 * Limit is 11 = the hwm + the 10 non-hwm rows getCoalescedHistory can include
 * (which uses `take(10)` AFTER excluding the hwm). That guarantees every user
 * message the agent could see — answered turn OR history — is gated, with no
 * off-by-one (codex review).
 */
async function getUnansweredUserWindow(session: ChatSession, hwmId: string): Promise<Message[]> {
  const qb = messageRepository
    .createQueryBuilder('m')
    .leftJoinAndSelect('m.participant', 'p')
    .where('m.sessionId = :sid', { sid: session.id })
    .andWhere('m.isDeleted = false')
    .andWhere("m.type IN ('text','image')")
    .andWhere("p.type = 'user'")
    .andWhere('m.guardrailFlagged = false')
    .andWhere(
      '(m.created_at, m.id) <= ((SELECT created_at FROM messages WHERE id = :hwmId), :hwmId)',
      { hwmId },
    );
  if (session.lastCoalescedAnswerMessageId) {
    // COALESCE to the stored date if the watermark message was hard-deleted — see
    // getNewestUnansweredUserMessage.
    qb.andWhere(
      '(m.created_at, m.id) > (COALESCE((SELECT created_at FROM messages WHERE id = :wId), :wAt), :wId)',
      { wId: session.lastCoalescedAnswerMessageId, wAt: session.lastCoalescedAnswerAt },
    );
  }
  const rows = await qb.orderBy('m.createdAt', 'DESC').addOrderBy('m.id', 'DESC').take(11).getMany();
  return rows.reverse();
}

/**
 * Everything a bot reply carries for the client, in one parameter.
 *
 * Deliberately an OBJECT replacing a positional `quickReplies`, and the type is the point rather
 * than the tidiness. Added as a second optional positional, a new field would compile at every
 * call site that forgot it - which is the whole failure mode this area keeps reproducing, because
 * a dropped affordance looks exactly like a reply that had none. As an object, adding a field
 * makes `tsc` name every site that builds one.
 */
export interface ReplyExtras {
  /** Tappable SENTENCES. A chip's value returns as an ordinary customer message. */
  quickReplies?: Array<{ title: string; value: string }>;
  /** A CONTROL the server asked the client to offer, whose result returns through an endpoint. */
  affordance?: Affordance;
}

class AddressQuestionStateConflictError extends Error {
  constructor() {
    super('The address question changed before its reply could be persisted');
    this.name = 'AddressQuestionStateConflictError';
  }
}

/**
 * The reply carrying an address question has been PERSISTED, so the customer has now been asked.
 *
 * Marked here rather than where the tool decides to ask, because those are different events and
 * only this one is evidence. A run that dies between deciding and writing leaves nothing on screen,
 * and a flag set at the decision would let the transition accept an answer to a question nobody
 * saw - and would let the next attempt book without asking again.
 *
 * The message and the state transition share one Postgres transaction. Either both exist or
 * neither does; a persisted question can no longer remain RECORDED after a process exit.
 */
async function markAddressQuestionAsked(
  manager: EntityManager,
  session: ChatSession,
  messageId: string,
  extras?: ReplyExtras
): Promise<void> {
  const a = extras?.affordance;
  if (a?.kind !== 'address_confirm') return;
  const applied = await markQuestionAsked(
    session.id,
    a.proposalId,
    { messageId, channel: session.channel ?? 'widget' },
    manager
  );
  // The reply itself says this question is live. Committing it while the matching RECORDED state
  // has expired, moved, or already been asked would put a stale control on screen and leave the
  // database claiming nobody was asked. Roll the reply back with the state transition.
  if (!applied) throw new AddressQuestionStateConflictError();
}

/** True ONLY for the widget, where the persisted reply IS the delivery, so a question may be marked
 *  ASKED at persist time. Fails closed: it requires the explicit 'widget' channel and never infers
 *  widget from a missing connection id, so a Meta reply's ASKED flip always waits for provider
 *  acceptance (#97 D1). */
export function deliveryIsPersistence(session: { channel?: string | null }): boolean {
  return session.channel === 'widget';
}

/**
 * RECORDED -> ASKED for an external channel, AFTER the provider accepted the reply.
 *
 * On the widget the reply row is the delivery, so `markAddressQuestionAsked` flips ASKED inside the
 * persist transaction. On Meta the two differ: #97 finding 1 is that a failed Send left the question
 * ASKED with nothing on the customer's screen, and `create_booking` then booked the stale binding.
 * So a Meta question flips ASKED only once a durable `MessageDelivery` row proves the provider
 * accepted THIS exact reply. That row is stronger than the in-memory delivery result: the router's
 * widget fallback (a Meta session with a null connection id) returns success but writes no such row,
 * so gating on the row leaves that reply RECORDED. On any conflict the question stays RECORDED and
 * the next create_booking re-asks; unlike the persist-time path this NEVER rolls the reply back,
 * because the reply is already committed and delivered.
 */
export async function markAddressQuestionAskedAfterDelivery(
  session: ChatSession,
  messageId: string,
  extras?: ReplyExtras,
): Promise<void> {
  const a = extras?.affordance;
  if (a?.kind !== 'address_confirm' || deliveryIsPersistence(session)) return;
  const delivered = await AppDataSource.getRepository(MessageDelivery).findOne({
    where: { internalMessageId: messageId, status: 'sent' },
  });
  if (!delivered) return;
  await markQuestionAsked(session.id, a.proposalId, { messageId, channel: session.channel ?? 'widget' });
}

/**
 * Write the single-use offer rows for a Meta address picker, in the SAME transaction that persists
 * the reply (#97 D3). The row ids are the tool-generated tokens already carried on the affordance
 * options, so the button renderer needs no extra plumbing and the reply and its offers commit
 * together. A widget picker carries no options and keeps its own places/select path.
 */
async function writePickerOffers(manager: EntityManager, session: ChatSession, extras?: ReplyExtras): Promise<void> {
  const a = extras?.affordance;
  if (a?.kind !== 'address_picker' || !a.options?.length || deliveryIsPersistence(session)) return;
  const setId = randomUUID();
  const expiresAt = new Date(Date.now() + 35 * 60 * 1000);
  await manager.getRepository(AddressOffer).insert(
    a.options.map((o) => ({
      id: o.id,
      setId,
      sessionId: session.id,
      channel: session.channel ?? 'unknown',
      placeId: o.placeId,
      expiresAt,
      consumedAt: null,
    })),
  );
}

/**
 * Everything a bot reply carries for the CLIENT, built in one place.
 *
 * It was three places - the same `quickReplies?.length ? { quickReplies } : undefined` written
 * out at each of the two persistence sites and the outbound one. That shape is why #80's offer
 * measurement "sat in exactly the right function and never fired once in production": every caller
 * assembled its own payload literal, so a field added to one was silently absent from the others,
 * and nothing failed - the reply simply arrived without it.
 *
 * There is no way to add a second field to three literals and be sure it reached all three, and
 * this file is now adding one. So the literals become a function, and a new field is added here,
 * once, or it does not exist.
 *
 * Returns `undefined` rather than `{}` when there is nothing to say, because an empty object is
 * still a metadata column write and reads downstream as "this reply had metadata".
 */
export function replyMetadata(parts: {
  quickReplies?: Array<{ title: string; value: string }>;
  affordance?: Affordance;
}): { quickReplies?: Array<{ title: string; value: string }>; affordance?: StoredAffordance } | undefined {
  const metadata = {
    ...(parts.quickReplies?.length ? { quickReplies: parts.quickReplies } : {}),
    // The picker's suggestion text is delivery-only (ADR-0014): the provider body is rendered from
    // the in-memory affordance, so the persisted + socket copy keeps only the {id, placeId}
    // evidence that `offeredPlaceId` reads. See #98.
    ...(parts.affordance ? { affordance: storedAffordance(parts.affordance) } : {}),
  };
  return Object.keys(metadata).length ? metadata : undefined;
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
  extras: ReplyExtras | undefined,
  hwmId: string,
  staleGuard: boolean,
  /** ownership_version read at RUN START (B2 fence): if any ownership command
   *  (claim/release/cancel/close) landed mid-run, the commit predicate fails
   *  and the in-flight AI reply is rolled back. Catches the claim→release ABA
   *  the status-only check is blind to. */
  ownershipVersionAtRunStart: number,
): Promise<{ status: 'answered'; savedId: string } | { status: 'stale' }> {
  try {
    const result = await AppDataSource.transaction(async (manager) => {
      if (staleGuard) {
        const r = await manager.query(
          `SELECT EXISTS(
             SELECT 1 FROM messages m
             JOIN participants p ON p.id = m.participant_id
             WHERE m.session_id = $1 AND m.is_deleted = false
               AND m.type IN ('text','image') AND p.type = 'user'
               AND m.guardrail_flagged = false
               AND (m.created_at, m.id) > ((SELECT created_at FROM messages WHERE id = $2), $2)
           ) AS has_newer`,
          [session.id, hwmId],
        );
        if (r?.[0]?.has_newer) return { status: 'stale' as const };
      }

      const metadata = replyMetadata(extras ?? {});
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

      // Atomic finalize predicate — every condition that must still hold at COMMIT
      // time (not just at the earlier checks), so the bot reply rolls back if:
      //  - ai_auto_reply was disabled mid-run (guardrail block), OR
      //  - a human took over mid-run (status left 'bot'/'waiting' → 'active'/'handoff'/
      //    'closed'); without this a coalesced reply could land after takeover, OR
      //  - ANY ownership command committed mid-run (ownership_version moved) —
      //    the status check alone is blind to a claim→release ABA that ends
      //    back on 'bot', OR
      //  - another run already advanced past hwm, OR
      //  - (staleGuard) a NEWER user message arrived between the stale-check and
      //    here — closes the READ COMMITTED race so no stale reply commits/sends.
      const noNewerClause = staleGuard
        ? `AND NOT EXISTS (
             SELECT 1 FROM messages n JOIN participants p ON p.id = n.participant_id
             WHERE n.session_id = s.id AND n.is_deleted = false
               AND n.type IN ('text','image') AND p.type = 'user' AND n.guardrail_flagged = false
               AND (n.created_at, n.id) > (m.created_at, m.id))`
        : '';
      const upd = await manager.query(
        `UPDATE chat_sessions s
            SET last_coalesced_answer_at = m.created_at,
                last_coalesced_answer_message_id = m.id
           FROM messages m
          WHERE s.id = $1 AND m.id = $2
            AND s.ai_auto_reply_enabled = true
            AND s.status IN ('bot','waiting')
            AND s.ownership_version = $3
            AND (s.last_coalesced_answer_at IS NULL
                 OR (s.last_coalesced_answer_at, s.last_coalesced_answer_message_id)
                    < (m.created_at, m.id))
            ${noNewerClause}
          RETURNING s.id`,
        [session.id, hwmId, ownershipVersionAtRunStart],
      );
      if (returningRows<{ id: string }>(upd).length !== 1) {
        // One of the finalize conditions failed at commit time (human takeover,
        // AI disabled, watermark race, or a newer message) — roll back this reply
        // (no persist, no delivery). Treated as 'stale' upstream.
        throw new WatermarkConflictError();
      }

      await manager.query(
        `UPDATE chat_sessions
            SET message_count = message_count + 1, last_activity_at = now()
          WHERE id = $1`,
        [session.id],
      );

      // The widget's persisted reply IS its delivery, so ASKED flips here; a Meta reply waits for
      // provider acceptance and flips post-delivery (#97 D1).
      if (deliveryIsPersistence(session)) await markAddressQuestionAsked(manager, session, saved.id, extras);
      await writePickerOffers(manager, session, extras);

      return { status: 'answered' as const, savedId: saved.id };
    });
    return result;
  } catch (err) {
    if (err instanceof WatermarkConflictError || err instanceof AddressQuestionStateConflictError) {
      logger.info(`[coalescer] reply state changed for session ${session.id} — treating as stale`, {
        cause: err.name,
      });
      return { status: 'stale' as const };
    }
    throw err;
  }
}

/**
 * Outbound delivery for a persisted bot message (post-commit).
 *
 * The reply is already committed + watermark-advanced, so a delivery failure here
 * does NOT roll back (re-running would re-LLM and persist a duplicate). We surface
 * it loudly instead — a true at-least-once guarantee needs a transactional outbox
 * (tracked separately). routeOutboundMessage SWALLOWS errors and returns
 * { success: false }, so check the result rather than relying on a throw.
 */
async function routeBotMessageOutbound(
  session: ChatSession,
  savedId: string,
  content: string,
  extras?: ReplyExtras,
  /**
   * #80 measurement, forwarded rather than acted on.
   *
   * It has to reach `routeOutboundMessage`, where BOTH reply paths converge and where the offer
   * is recorded. Every caller used to build a fresh payload literal and drop it, which is why the
   * recording sat in exactly the right function and never fired once in production.
   */
  offer?: OfferMeasurement,
): Promise<void> {
  const metadata = replyMetadata(extras ?? {});

  // B-PR3a: the reply is already COMMITTED (finalizeReply's transaction, which
  // also did message_count+1 / last_activity_at=now() in the DB) — announce it
  // to BOTH rooms before attempting external delivery. Bot replies previously
  // never reached the agents room (the scope-audit gap this PR closes). Keep
  // the in-memory copy in step for the serialized summary, exactly like the
  // ingest paths do.
  session.incrementMessageCount();
  emitMessageCreated(session, {
    id: savedId,
    sessionId: session.id,
    type: 'text',
    content,
    senderType: 'bot',
    status: 'sent',
    ...(metadata ? { metadata } : {}),
  });
  await emitConversationUpsert(session, {
    lastMessage: { content, senderType: 'bot' },
  });

  const outbound = renderChannelAddressControls(
    { type: 'text', content, ...(extras?.quickReplies?.length ? { quickReplies: extras.quickReplies } : {}), ...(offer ? { offer } : {}) },
    extras?.affordance,
    session.channel,
  );
  const result = await routeOutboundMessage(
    outbound,
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
  if (result && result.success === false) {
    logger.error('[coalescer] bot reply persisted but channel delivery FAILED', {
      sessionId: session.id, tenantId: session.tenantId, messageId: savedId,
      channel: session.channel, error: result.error,
    });
  }
  // #97 D1: an external question becomes ASKED only now, and only if the provider accepted the reply.
  await markAddressQuestionAskedAfterDelivery(session, savedId, extras);
}

/**
 * Run the platform agent EXACTLY ONCE for the snapped `pending` (= hwm) message,
 * with history bounded to `<= hwm`, then finalise. The coalescer (not this fn)
 * owns the run-lock, timing, and re-running. Returns 'answered' | 'stale' |
 * 'noop' so the coalescer can clear state or re-arm.
 */
export async function runTurn(session: ChatSession, pending: Message): Promise<RunTurnStatus> {
  // Status gate — mirror forwardMessageToN8n: never run the agent on a session a
  // human owns ('active'/'handoff') or that's closed. Without this the coalescer
  // path would bypass human takeover (R11/AC9).
  if (session.status !== 'bot' && session.status !== 'waiting') return 'noop';

  // Ownership gate + fence snapshot (B2). `session` is loaded fresh by the
  // coalescer right before this call; if ownership moves after this read, the
  // finalize predicate (ownership_version = this value) rolls the reply back.
  if (session.ownership !== 'bot_owned') return 'noop';
  const ownershipVersionAtRunStart = session.ownershipVersion ?? 0;

  // Guardrail pause: a sibling message may have tripped the gate and disabled the
  // session after this one was scheduled. `session` is loaded fresh by the
  // coalescer right before this call, so the in-memory flag is current.
  if (session.aiAutoReplyEnabled === false) return 'noop';

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

  // ── Global guardrails gate (spam/scam/bot-loop) ───────────────────────────
  // Gate EVERY unanswered user message in this coalesced window — not just the
  // hwm — or an earlier burst message (e.g. phishing) would enter history
  // ungated. The gate is idempotent per message (guardrail_checked claim), so a
  // 'stale' re-run never double-counts. Placed AFTER config resolution, so
  // AI-off / no-target sessions (returned above) are never gated. If the hwm is
  // blocked, or an earlier message disabled the session, drop the turn.
  const windowMsgs = await getUnansweredUserWindow(session, pending.id);
  for (const m of windowMsgs) {
    const c = m.contentEncrypted ? decrypt(m.content) : (m.content || '');
    const g = await runInboundGate({
      session, tenantId: session.tenantId, message: m, content: c, channel: session.channel,
    });
    if (m.id === pending.id && !g.proceed) {
      // hwm blocked — drop the turn. (An earlier window message that disabled the
      // session also surfaces here: the hwm gate's enforce fast-exit re-reads the
      // DB and blocks, since the hwm is always the last/newest in the window.)
      logger.info(`[guardrails] turn blocked for session ${session.id} (${g.category})`);
      return 'noop';
    }
  }

  const botParticipant = await ensureBotParticipant(session, aiSettings);

  // Local autoresponders (off-hours / escalation-keyword) — same gate as the
  // legacy path (shared helper), so coalesced platform-agent tenants don't lose
  // them. Finalise via the watermark so the turn is marked answered (won't re-run)
  // and route outbound; escalation also hands off.
  const pendingPlain = pending.contentEncrypted ? decrypt(pending.content) : (pending.content || '');
  let auto = localAutoresponse(session, pending.type, pendingPlain, botSettings, aiSettings, bot.businessTimezone);
  // The hwm itself didn't trip off-hours/escalation — but an EARLIER message in
  // this coalesced burst might contain an escalation keyword (the legacy path sees
  // each message individually; we must scan the whole window for parity). Off-hours
  // is time-based so it's already covered by the hwm check above.
  if (!auto) {
    const kwCount = aiSettings.guardrails?.escalationKeywords?.length ?? 0;
    // windowMsgs is the small guardrails window (newest 11). If it's at the cap
    // AND escalation keywords are configured, scan the FULL unanswered text
    // backlog up to the hwm so a keyword in an older burst message isn't missed
    // (legacy checks each message individually). Common case (no keywords / small
    // burst) reuses the already-loaded window — no extra query.
    const scan = kwCount > 0 && windowMsgs.length >= 11
      ? await getUnansweredUserTextUpTo(session, pending.id, 200)
      : windowMsgs;
    for (const m of scan) {
      if (m.id === pending.id || m.type !== 'text') continue;
      const mc = m.contentEncrypted ? decrypt(m.content) : (m.content || '');
      const esc = localAutoresponse(session, 'text', mc, botSettings, aiSettings, bot.businessTimezone);
      if (esc?.kind === 'escalation') { auto = esc; break; }
    }
  }
  if (auto) {
    // off-hours is stale-guarded (a newer message arriving mid-finalize should be
    // handled as its own turn, not double-replied with the canned off-hours msg).
    // escalation is NOT stale-guarded: hand off immediately; the human sees newer
    // messages and the takeover gate stops further bot replies.
    const staleGuard = auto.kind === 'off_hours';
    // Localize the tenant's canned off-hours/escalation message to the customer's
    // language (fail-open to the original) so an English customer doesn't get the
    // Dutch-configured fallback.
    const autoMsg = await localizeMessage(auto.message, pendingPlain, session);
    const fin = await finalizeReply(session, botParticipant.id, autoMsg, undefined, pending.id, staleGuard, ownershipVersionAtRunStart);
    if (fin.status === 'stale') return 'stale';
    await routeBotMessageOutbound(session, fin.savedId, autoMsg);
    if (auto.kind === 'escalation') await handleBotHandoff(session, botParticipant.id, 'bot_escalation_keyword');
    return 'answered';
  }

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
      // An UPSTREAM failure (out of credit, throttled, provider down) is not this
      // bot going wrong — it hits every conversation at once. Handing those to a
      // human would park the whole inbox in handoff, and handoff SILENCES the bot
      // until the 60-minute sweep, which every new customer message pushes further
      // out. So the customer gets the fallback and the session stays with the bot,
      // ready to answer the moment the provider recovers. The operator is told by
      // the health probe (llm/provider-health), which is where a platform-wide
      // outage belongs. A genuine bot fault still escalates as before.
      handoffReason = result.infraFailure ? null : 'bot_error';
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
  let quickReplies = result.type === 'response' ? result.quickReplies : undefined;
  // Read alongside `quickReplies` and cleared alongside it, because the guardrail block below is
  // about a reply the customer must not be shown - and a control attached to a suppressed reply
  // would render under a fallback that says nothing about it.
  let affordance = result.type === 'response' ? result.affordance : undefined;

  // ── Output guardrails (AC14) ──────────────────────────────────────────────
  // Validate only AI-GENERATED content (response / booking confirmation); the
  // error/budget/max_iterations branches already carry the platform-authored
  // fallback. In enforce mode a blocked reply is treated exactly like an agent
  // error: send the fallback (no quick replies) and hand off to a human.
  if (result.type === 'response' || result.type === 'awaiting_confirmation') {
    const fallbackMessage =
      aiSettings?.guardrails?.fallbackMessage || "We're connecting you to an agent. Please hold on.";
    const guard = await applyOutputGuardrails({
      tenantId: session.tenantId, session, channel: session.channel,
      content, fallbackMessage, generationPath: 'coalescer',
    });
    if (guard.blocked) {
      content = guard.content;
      quickReplies = undefined;
      affordance = undefined;
      handoffReason = 'bot_error';
      staleGuard = false;
    }
  }

  // The customer explicitly asked for a human and `escalate_to_human` succeeded
  // this run. Exactly ONE handoff per turn, and this reason WINS: it replaces any
  // `bot_error` set above (including the guardrail block) and overrides the
  // infraFailure no-handoff rule — a provider outage is no reason to lose a human
  // the customer explicitly asked for. `staleGuard` is forced off to match the
  // deterministic escalation-keyword path: a newer customer message arriving
  // mid-run must not roll back the turn that asked for a person.
  if (result.handoffRequested) {
    handoffReason = 'escalation_trigger';
    staleGuard = false;
  }

  const extras: ReplyExtras = { quickReplies, affordance };
  const fin = await finalizeReply(session, botParticipant.id, content, extras, pending.id, staleGuard, ownershipVersionAtRunStart);
  if (fin.status === 'stale') return 'stale';

  await routeBotMessageOutbound(session, fin.savedId, content, extras, result.type === 'response' ? result.offer : undefined);

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
    .andWhere('message.type IN (:...types)', { types: ['text', 'image'] })
    .andWhere('message.guardrailFlagged = false');

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

/** The legacy path's commit-time fence tripped: an ownership command
 *  (claim/release/cancel/close) landed while the agent was thinking, so the
 *  computed reply must not reach the customer. */
export class OwnershipChangedError extends Error {
  constructor() {
    super('Conversation ownership changed while the reply was being computed');
    this.name = 'OwnershipChangedError';
  }
}

/**
 * Create a bot Message and emit via WebSocket
 */
async function sendBotMessage(
  session: ChatSession,
  botParticipantId: string,
  content: string,
  extras?: ReplyExtras,
  /** #80: forwarded to `routeOutboundMessage`, where both reply paths converge. */
  offer?: OfferMeasurement,
  /** B2 fence for the LEGACY path (the coalescer has finalizeReply's predicate):
   *  when set, the persist transaction locks the session row and rolls the reply
   *  back with OwnershipChangedError if ownership_version moved since run start.
   *  FOR UPDATE serializes against the command service's row lock, so a claim
   *  committing concurrently is always observed. */
  fence?: { ownershipVersion: number },
): Promise<Message> {
  const metadata = replyMetadata(extras ?? {});
  const saved = await AppDataSource.transaction(async (manager) => {
    if (fence) {
      const rows = (await manager.query(
        `SELECT ownership_version FROM chat_sessions WHERE id = $1 FOR UPDATE`,
        [session.id],
      )) as Array<{ ownership_version: number }>;
      if (!rows.length || Number(rows[0].ownership_version) !== fence.ownershipVersion) {
        throw new OwnershipChangedError();
      }
    }
    const repo = manager.getRepository(Message);
    const botMsg = repo.create({
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
    const persisted = await repo.save(botMsg);
    // The widget's persisted reply IS its delivery, so ASKED flips here; a Meta reply waits for
    // provider acceptance and flips post-delivery (#97 D1).
    if (deliveryIsPersistence(session)) await markAddressQuestionAsked(manager, session, persisted.id, extras);
    await writePickerOffers(manager, session, extras);
    return persisted;
  });

  await sessionRepository.increment({ id: session.id }, 'messageCount', 1);
  await sessionRepository.update(session.id, { lastActivityAt: new Date() });

  // B-PR3a: reply committed above — announce to BOTH rooms before external
  // delivery (bot replies previously never reached the agents room). In-memory
  // bump keeps the serialized summary in step, like the ingest paths.
  session.incrementMessageCount();
  emitMessageCreated(session, {
    id: saved.id,
    sessionId: session.id,
    type: 'text',
    content,
    senderType: 'bot',
    status: saved.status,
    createdAt: saved.createdAt,
    ...(metadata ? { metadata } : {}),
  });
  await emitConversationUpsert(session, {
    lastMessage: { content, senderType: 'bot' },
  });

  // Route through outbound router — handles both WebSocket and external channels.
  // Quick replies go to BOTH: the widget renders them as chips (via socketEvent
  // metadata below), and external channels (Messenger/IG/WhatsApp/Telegram) get
  // them as native quick replies via the channel response payload. Each adapter
  // gates on its own supportsQuickReplies/maxQuickReplies, so unsupported
  // channels simply send the text.
  const outbound = renderChannelAddressControls(
    { type: 'text', content, ...(extras?.quickReplies?.length ? { quickReplies: extras.quickReplies } : {}), ...(offer ? { offer } : {}) },
    extras?.affordance,
    session.channel,
  );
  await routeOutboundMessage(
    outbound,
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

  // #97 D1: an external question becomes ASKED only now, and only if the provider accepted the reply.
  await markAddressQuestionAskedAfterDelivery(session, saved.id, extras);

  return saved;
}

/**
 * Transition session to handoff and create a HandoffRequest.
 *
 * B-PR2b: the actual transition goes through the conversation command service —
 * the ONE transactional ownership writer (ownership + derived legacy status +
 * ownership_version + the open-handoff row move together, and a duplicate
 * request converges on the one open HandoffRequest). This function keeps the
 * customer-facing behaviour identical: the handoff-disabled fallback message
 * and the post-commit socket/notification fan-out live here.
 */
async function handleBotHandoff(
  session: ChatSession,
  botParticipantId: string,
  reason: HandoffRequest['reason']
): Promise<void> {
  // Check if handoff is enabled for this bot (multi-bot Phase 4 #16d:
  // features + ai now live on Bot.settings, not Tenant.settings). The command
  // service re-checks this authoritatively; the pre-check is kept because only
  // this caller knows the template-resolved fallback wording to send.
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

  const result = await conversationCommands.requestHandoff(session.id, reason, 'bot', undefined, {
    requestedBy: botParticipantId,
  });
  // Keep the caller's in-memory copy consistent (the service only does targeted
  // column UPDATEs, so the coalescer watermark can never be clobbered).
  session.status = result.conversation.status;
  session.ownership = result.conversation.ownership;
  session.ownershipVersion = result.conversation.ownershipVersion;

  if (result.outcome !== 'requested') {
    // Disabled (raced a config change), already requested, or a human already
    // owns it — nothing new to announce.
    logger.info(`Bot handoff not re-created for session ${session.id} (${result.outcome})`, { reason });
    return;
  }
  const handoffId = result.handoffId!;

  // Notify agents
  emitToTenantAgents(session.tenantId, 'handoff:requested', {
    sessionId: session.id,
    handoffId,
    reason,
    requestedAt: new Date().toISOString(),
  });

  // B-PR3a: normalized ownership event to BOTH rooms, post-commit. The in-hand
  // entity's ownership/status/version were just synced from the command result.
  await emitConversationUpsert(session);

  // Push notification to operators (fire-and-forget; never blocks handoff).
  void notificationService
    .createForTenant({
      tenantId: session.tenantId,
      type: 'handoff_requested',
      title: 'New handoff request',
      message: reason
        ? `A visitor needs help: ${reason}`
        : 'A visitor is requesting a human agent.',
      data: { sessionId: session.id, handoffId },
      dedupeBase: `handoff:${handoffId}`,
    })
    .catch(() => {});

  logger.info(`Bot handoff triggered for session ${session.id}`, { reason });
}
