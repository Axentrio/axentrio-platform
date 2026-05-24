/**
 * Message Forwarding Service
 * Handles forwarding visitor messages to n8n webhooks
 * Used by both WebSocket handler and HTTP chat routes
 */

import { logger } from '../utils/logger';
import { AppDataSource } from '../database/data-source';
import { ChatSession } from '../database/entities/ChatSession';
import { Message } from '../database/entities/Message';
import { decrypt, encrypt } from '../utils/encryption';
import { Tenant } from '../database/entities/Tenant';
import { Participant } from '../database/entities/Participant';
import { HandoffRequest } from '../database/entities/HandoffRequest';
import { OutboundService } from '../n8n/outbound.service';
import { substituteVariables } from '../llm/prompt-builder';
import { FallbackService } from '../n8n/fallback.service';
import { WebhookConfig, OutboundMessage, MessagePayload, TenantAiConfig, KnowledgeBaseMetadata, IntegrationsConfig } from '../n8n/types';
import { emitToTenantAgents, emitToSession } from '../websocket/socket.handler';
import { generateResponse } from '../llm/rag.service';
import { routeOutboundMessage } from '../channels/outbound-router';
import { config } from '../config/environment';
import { AgentService, AgentResult } from '../agent/agent.service';

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

export function buildTenantAiConfig(tenant: Tenant): TenantAiConfig | undefined {
  const ai = tenant.settings?.ai;
  if (!ai?.enabled) return undefined;

  return {
    brandName: ai.brandVoice?.name || tenant.name,
    brandTone: ai.brandVoice?.tone || 'professional',
    // n8n has its own prompt handling — pass the tenant's template through
    // with {placeholders} resolved, but without injecting a legacy fallback
    // (empty customInstructions → empty systemPrompt).
    systemPrompt: substituteVariables(
      ai.brandVoice?.customInstructions || '',
      ai,
      { businessName: tenant.name }
    ),
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
    const result = await AppDataSource.query(
      `SELECT COUNT(*)::int AS count FROM knowledge_documents WHERE "tenantId" = $1 AND status = 'indexed'`,
      [tenantId]
    );
    const docCount = result[0]?.count || 0;
    return { enabled: docCount > 0, documentCount: docCount };
  } catch {
    return { enabled: false, documentCount: 0 };
  }
}

function buildIntegrationsConfig(tenant: Tenant): IntegrationsConfig | undefined {
  const calcom = tenant.settings?.integrations?.calcom;
  if (!calcom?.apiKey || !calcom?.eventTypeId) return undefined;

  const timezone = tenant.settings?.businessHours?.timezone || 'UTC';

  return {
    calcom: {
      enabled: true,
      language: calcom.language || 'en',
      collectFields: calcom.collectFields || ['name', 'email'],
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

  const aiSettings = tenant.settings?.ai;

  // Use tenant's webhookUrl, or global default ONLY for AI-enabled tenants
  // Ignore localhost URLs in production — leftover from dev setup
  const tenantUrl = tenant.webhookUrl && !tenant.webhookUrl.includes('localhost') ? tenant.webhookUrl : undefined;
  const webhookUrl = tenantUrl || (aiSettings?.enabled ? config.n8n.defaultWebhookUrl : undefined);
  if (!webhookUrl) {
    // No webhook configured and AI not enabled — session stays waiting, agent picks up
    return false;
  }

  // ── Pre-forwarding checks (cheap, local) ──────────────────────────────
  if (session.status === 'bot' && savedMessage.type === 'text' && aiSettings?.enabled) {
    // Business hours check
    const bh = tenant.settings?.businessHours;
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

  // ── Platform agent path (opted-in tenants without custom webhook) ─────
  if (
    !tenantUrl &&
    aiSettings?.enabled &&
    (aiSettings as any)?.usePlatformAgent &&
    agentService
  ) {
    return platformAgentPath(session, savedMessage, tenant, aiSettings);
  }

  // ── Build enriched outbound payload ────────────────────────────────────
  const webhookConfig = buildWebhookConfig(tenant);
  // Override URL with resolved webhook URL (may be global default)
  webhookConfig.url = webhookUrl;

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
    tenantConfig: buildTenantAiConfig(tenant),
    knowledgeBase: await buildKnowledgeBaseMetadata(session.tenantId),
    integrations: buildIntegrationsConfig(tenant),
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
      const history = await getConversationHistory(session.id);
      const messageContent = savedMessage.contentEncrypted
        ? decrypt(savedMessage.content)
        : savedMessage.content;
      const ragResult = await generateResponse(
        AppDataSource,
        session.tenantId,
        aiSettings as Parameters<typeof generateResponse>[2],
        messageContent,
        history
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

// ── Per-Session Lock ────────────────────────────────────────────────────
// Prevents concurrent agent runs on the same session.
// Uses Redis SET NX with TTL. Falls back to no-lock if Redis is down.

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

async function releaseSessionLock(sessionId: string): Promise<void> {
  try {
    const { getRedisClient } = await import('../config/redis');
    const redis = getRedisClient();
    if (redis) await redis.del(`agent:lock:${sessionId}`);
  } catch {
    // ignore
  }
}

// ── Platform Agent Path ──────────────────────────────────────────────────

async function platformAgentPath(
  session: ChatSession,
  savedMessage: Message,
  tenant: Tenant,
  aiSettings: NonNullable<Tenant['settings']>['ai'],
): Promise<boolean> {
  // Acquire per-session lock — prevents concurrent agent runs
  const locked = await acquireSessionLock(session.id);
  if (!locked) {
    logger.info(`Agent already processing session ${session.id}, skipping duplicate`);
    return true; // message is saved, agent will see it in history on current run
  }

  try {
  const botParticipant = await ensureBotParticipant(session, aiSettings);

  // Show typing indicator while AI processes
  emitToTenantAgents(session.tenantId, 'typing:indicator', {
    sessionId: session.id, isTyping: true, participantType: 'bot',
  });
  // Also emit to the session room so the widget sees it
  emitToSession(session.tenantId, session.id, 'typing:start', {});

  // Decrypt message content
  const messageContent = savedMessage.contentEncrypted
    ? decrypt(savedMessage.content)
    : savedMessage.content;

  // Load conversation history for the agent loop
  const history = await getConversationHistory(session.id);

    const result: AgentResult = await agentService!.run(
      messageContent,
      session,
      tenant,
      history,
    );

    switch (result.type) {
      case 'response':
        await sendBotMessage(session, botParticipant.id, result.content);
        break;

      case 'error':
        logger.error(`Platform agent error for session ${session.id}`, { error: result.error });
        await sendBotMessage(session, botParticipant.id, result.fallbackMessage);
        await handleBotHandoff(session, botParticipant.id, 'bot_error');
        break;

      case 'budget_exceeded':
        logger.warn(`Platform agent budget exceeded for tenant ${tenant.id}`);
        await sendBotMessage(session, botParticipant.id, result.fallbackMessage);
        await handleBotHandoff(session, botParticipant.id, 'bot_error');
        break;

      case 'max_iterations':
        logger.warn(`Platform agent max iterations for session ${session.id}`);
        await sendBotMessage(session, botParticipant.id, result.fallbackMessage);
        await handleBotHandoff(session, botParticipant.id, 'bot_error');
        break;

      case 'awaiting_confirmation':
        // Confirmation gate — just send the preview message, don't handoff
        await sendBotMessage(session, botParticipant.id, result.message);
        break;
    }

    // Stop typing indicator
    emitToSession(session.tenantId, session.id, 'typing:stop', {});

    // Transition waiting → bot on first message
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
  aiSettings: NonNullable<Tenant['settings']>['ai']
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
 * Load last 10 messages with participant join to determine role
 */
async function getConversationHistory(
  sessionId: string
): Promise<{ role: 'user' | 'assistant'; content: string }[]> {
  const messages = await messageRepository
    .createQueryBuilder('message')
    .leftJoinAndSelect('message.participant', 'participant')
    .where('message.sessionId = :sessionId', { sessionId })
    .andWhere('message.isDeleted = false')
    .andWhere('message.type = :type', { type: 'text' })
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
  content: string
): Promise<Message> {
  const botMsg = messageRepository.create({
    sessionId: session.id,
    tenantId: session.tenantId,
    participantId: botParticipantId,
    type: 'text' as Message['type'],
    content: encrypt(content),
    contentEncrypted: true,
    status: 'sent' as Message['status'],
    sentAt: new Date(),
  });
  const saved = await messageRepository.save(botMsg);

  await sessionRepository.increment({ id: session.id }, 'messageCount', 1);
  await sessionRepository.update(session.id, { lastActivityAt: new Date() });

  // Route through outbound router — handles both WebSocket and external channels
  await routeOutboundMessage(
    { type: 'text', content },
    { sessionId: session.id, tenantId: session.tenantId, messageId: saved.id },
    {
      event: 'message:receive',
      data: {
        id: saved.id,
        type: 'text',
        content,
        senderType: 'bot',
        timestamp: new Date().toISOString(),
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
  // Check if handoff is enabled for this tenant
  const tenant = await tenantRepository.findOne({ where: { id: session.tenantId } });
  if (tenant?.settings?.features?.handoffEnabled === false) {
    // Handoff disabled — send fallback message but keep session in bot status
    const aiSettings = tenant.settings?.ai;
    const fallbackMsg = aiSettings?.guardrails?.fallbackMessage ||
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

  logger.info(`Bot handoff triggered for session ${session.id}`, { reason });
}
