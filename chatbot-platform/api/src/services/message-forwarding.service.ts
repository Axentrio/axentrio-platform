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
import { OutboundService } from '../n8n/outbound.service';
import { FallbackService } from '../n8n/fallback.service';
import { WebhookConfig, OutboundMessage, MessagePayload } from '../n8n/types';
import { emitToSession, emitToTenantAgents } from '../websocket/socket.handler';

const sessionRepository = AppDataSource.getRepository(ChatSession);
const messageRepository = AppDataSource.getRepository(Message);
const tenantRepository = AppDataSource.getRepository(Tenant);

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
