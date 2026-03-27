/**
 * Message Forwarding Service
 * Handles forwarding visitor messages to n8n webhooks
 * Used by both WebSocket handler and HTTP chat routes
 */

import { logger } from '../utils/logger';
import { AppDataSource } from '../database/data-source';
import { ChatSession } from '../database/entities/ChatSession';
import { Message } from '../database/entities/Message';
import { Tenant } from '../database/entities/Tenant';
import { Participant } from '../database/entities/Participant';
import { HandoffRequest } from '../database/entities/HandoffRequest';
import { OutboundService } from '../n8n/outbound.service';
import { FallbackService } from '../n8n/fallback.service';
import { WebhookConfig, OutboundMessage, MessagePayload } from '../n8n/types';
import { emitToSession, emitToTenantAgents } from '../websocket/socket.handler';
import { generateResponse } from '../llm/rag.service';

const sessionRepository = AppDataSource.getRepository(ChatSession);
const messageRepository = AppDataSource.getRepository(Message);
const tenantRepository = AppDataSource.getRepository(Tenant);
const participantRepository = AppDataSource.getRepository(Participant);
const handoffRepository = AppDataSource.getRepository(HandoffRequest);

// Module-level service references, set via initialize()
let outboundService: OutboundService | null = null;
let fallbackServiceRef: FallbackService | null = null;

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

  // ── RAG-powered bot handling ──────────────────────────────────────────
  if (session.status === 'bot' && savedMessage.type === 'text') {
    const tenant = await tenantRepository.findOne({ where: { id: session.tenantId } });
    const aiSettings = tenant?.settings?.ai;

    if (tenant && aiSettings?.enabled) {
      try {
        // Check business hours — if outside hours, send offHoursMessage and skip LLM
        const bh = tenant.settings?.businessHours;
        if (bh?.enabled && bh.schedule?.length) {
          const now = new Date();
          const tz = bh.timezone || 'UTC';
          const localTime = new Date(now.toLocaleString('en-US', { timeZone: tz }));
          const dayName = localTime.toLocaleDateString('en-US', { weekday: 'long', timeZone: tz }).toLowerCase();
          const daySchedule = bh.schedule.find((s: any) => s.day.toLowerCase() === dayName);

          const isOutsideHours = !daySchedule || daySchedule.closed || (() => {
            const timeStr = localTime.toTimeString().slice(0, 5); // HH:MM
            return timeStr < daySchedule.open || timeStr >= daySchedule.close;
          })();

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

        // Check escalation keywords first
        const escalationKeywords = aiSettings.guardrails?.escalationKeywords || [];
        const lowerContent = savedMessage.content.toLowerCase();
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

        // Call RAG service
        const history = await getConversationHistory(session.id);
        const ragResult = await generateResponse(
          AppDataSource,
          session.tenantId,
          aiSettings as Parameters<typeof generateResponse>[2],
          savedMessage.content,
          history
        );

        const botParticipant = await ensureBotParticipant(session, aiSettings);
        await sendBotMessage(session, botParticipant.id, ragResult.response);

        if (ragResult.shouldHandoff && ragResult.handoffReason) {
          await handleBotHandoff(session, botParticipant.id, ragResult.handoffReason as HandoffRequest['reason']);
        }

        return true;
      } catch (error) {
        logger.error(`RAG processing failed for session ${session.id}`, error);
        // On RAG error, trigger handoff so session isn't stuck
        try {
          const botParticipant = await ensureBotParticipant(session, aiSettings);
          await sendBotMessage(
            session,
            botParticipant.id,
            aiSettings.guardrails?.fallbackMessage || "I'm having trouble right now. Let me connect you to a human agent."
          );
          await handleBotHandoff(session, botParticipant.id, 'bot_error');
        } catch (innerError) {
          logger.error(`Failed to handle RAG error gracefully for session ${session.id}`, innerError);
        }
        return true;
      }
    }
  }

  // ── n8n forwarding (fallthrough) ──────────────────────────────────────

  if (!outboundService) {
    logger.warn('Message forwarding not initialized — outboundService is null');
    return false;
  }

  const tenant = await tenantRepository.findOne({ where: { id: session.tenantId } });
  if (!tenant?.webhookUrl) {
    // No webhook configured — session stays waiting, agent picks it up from queue
    return false;
  }

  const webhookConfig = buildWebhookConfig(tenant);

  const outboundPayload: OutboundMessage = {
    event: 'message.received',
    tenantId: session.tenantId,
    sessionId: session.id,
    timestamp: new Date().toISOString(),
    payload: {
      type: (savedMessage.type as MessagePayload['type']) || 'text',
      content: savedMessage.content,
      metadata: savedMessage.metadata || undefined,
    },
  };

  try {
    await outboundService.sendToWebhook(webhookConfig, outboundPayload);

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
  } catch (error) {
    logger.error(`n8n forwarding failed for session ${session.id}`, error);

    // n8n is down — send fallback message, transition to handoff
    const fallbackContent = "We're connecting you to an agent. Please hold on.";

    const fallbackMsg = messageRepository.create({
      sessionId: session.id,
      tenantId: session.tenantId,
      participantId: 'system',
      type: 'system' as Message['type'],
      content: fallbackContent,
    });
    const savedFallback = await messageRepository.save(fallbackMsg);

    // Broadcast fallback to visitor
    emitToSession(session.tenantId, session.id, 'message:receive', {
      id: savedFallback.id,
      type: 'system',
      content: fallbackContent,
      senderType: 'system',
      timestamp: new Date().toISOString(),
    });

    // Transition session to handoff so agents can pick it up
    await sessionRepository.update(session.id, { status: 'handoff' as ChatSession['status'] });

    // Notify agents about the new handoff
    emitToTenantAgents(session.tenantId, 'handoff:requested', {
      sessionId: session.id,
      reason: 'n8n_unavailable',
      requestedAt: new Date().toISOString(),
    });

    return true;
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
    content: msg.content,
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
    content,
    status: 'sent' as Message['status'],
    sentAt: new Date(),
  });
  const saved = await messageRepository.save(botMsg);

  emitToSession(session.tenantId, session.id, 'message:receive', {
    id: saved.id,
    type: 'text',
    content,
    senderType: 'bot',
    timestamp: new Date().toISOString(),
  });

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
