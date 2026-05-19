/**
 * Inbound Pipeline
 * Processes normalized webhook events through a common pipeline:
 *   dedupe → status-update | (find/create conversation → save message → broadcast → forward)
 */

import { DeepPartial, EntityManager } from 'typeorm';
import { AppDataSource, getRepository } from '../database/data-source';
import { WebhookEventLog } from '../database/entities/WebhookEventLog';
import { ConversationBinding } from '../database/entities/ConversationBinding';
import { ChatSession } from '../database/entities/ChatSession';
import { Participant } from '../database/entities/Participant';
import { Message } from '../database/entities/Message';
import { ChannelConnection } from '../database/entities/ChannelConnection';
import { MessageDelivery } from '../database/entities/MessageDelivery';
import { NormalizedEvent } from './types';
import { encrypt } from '../utils/encryption';
import { forwardMessageToN8n } from '../services/message-forwarding.service';
import { emitToSession, emitToTenantAgents } from '../websocket/socket.handler';
import { logger } from '../utils/logger';
import { enforceCountLimit } from '../billing/enforce';
import { Not } from 'typeorm';

/**
 * Main entry point: process a single NormalizedEvent for a given ChannelConnection.
 */
export async function processInboundEvent(
  event: NormalizedEvent,
  connection: ChannelConnection,
): Promise<void> {
  const eventLogRepo = getRepository(WebhookEventLog);

  // ── 1. Dedupe check ────────────────────────────────────────────────────
  const existing = await eventLogRepo.findOne({
    where: { dedupeKey: event.dedupeKey },
  });

  if (existing && existing.status === 'processed') {
    logger.debug(`[inbound-pipeline] Skipping already-processed event ${event.dedupeKey}`);
    return;
  }

  // ── 2. Mark as processing ──────────────────────────────────────────────
  let eventLogEntry = existing;
  if (eventLogEntry) {
    eventLogEntry.status = 'processing';
    eventLogEntry.processingAttempts += 1;
    await eventLogRepo.save(eventLogEntry);
  } else {
    console.warn(`[inbound-pipeline] No event log entry found for dedupe key: ${event.dedupeKey}, creating one`);
    // Create the missing entry
    const newEntry = eventLogRepo.create({
      channelConnectionId: connection.id,
      channel: connection.channel,
      dedupeKey: event.dedupeKey,
      eventType: event.rawEventType,
      rawPayload: {},
      status: 'received',
    });
    eventLogEntry = await eventLogRepo.save(newEntry);
  }

  try {
    // ── 3. Non-message events (delivery receipts, read receipts, reactions) ─
    if (event.type === 'delivery' || event.type === 'read') {
      await handleReceiptEvent(event, connection);
      await markEventProcessed(eventLogRepo, event.dedupeKey);
      return;
    }

    if (event.type === 'reaction' || event.type === 'status' || event.type === 'unknown') {
      // Log and skip for now
      logger.debug(`[inbound-pipeline] Ignoring ${event.type} event for ${connection.channel}`);
      await markEventProcessed(eventLogRepo, event.dedupeKey);
      return;
    }

    // ── 4. Message / postback events ─────────────────────────────────────
    const { session, participant } = await findOrCreateConversation(event, connection);

    // ── 5. Save the message (encrypted) to DB ────────────────────────────
    const messageRepo = getRepository(Message);

    const content = event.type === 'postback'
      ? event.postback?.payload || ''
      : event.message?.content || '';

    const messageType = event.type === 'postback'
      ? 'text'
      : mapMessageType(event.message?.type);

    const encryptedContent = encrypt(content);

    const messageData: DeepPartial<Message> = {
      sessionId: session.id,
      tenantId: connection.tenantId,
      participantId: participant.id,
      type: messageType,
      content: encryptedContent,
      contentEncrypted: true,
      status: 'sent',
      sentAt: event.timestamp,
      metadata: event.message?.mediaUrl
        ? { fileUrl: event.message.mediaUrl, customData: event.message.mediaMetadata as Record<string, unknown> | undefined }
        : undefined,
    };

    const savedMessage = await messageRepo.save(messageRepo.create(messageData)) as Message;

    // Update session activity
    session.incrementMessageCount();
    const sessionRepo = getRepository(ChatSession);
    await sessionRepo.save(session);

    // ── 6. Broadcast to portal agents via WebSocket ──────────────────────
    emitToSession(connection.tenantId, session.id, 'message:receive', {
      id: savedMessage.id,
      type: savedMessage.type,
      content, // plain text for the portal
      senderType: 'user',
      timestamp: savedMessage.sentAt?.toISOString() || new Date().toISOString(),
    });

    emitToTenantAgents(connection.tenantId, 'message:new', {
      sessionId: session.id,
      message: {
        id: savedMessage.id,
        type: savedMessage.type,
        content,
        senderType: 'user',
        timestamp: savedMessage.sentAt?.toISOString() || new Date().toISOString(),
      },
    });

    // ── 7. Forward to RAG / n8n ──────────────────────────────────────────
    try {
      await forwardMessageToN8n(session, savedMessage);
    } catch (err) {
      logger.error(`[inbound-pipeline] Error forwarding to n8n for session ${session.id}`, err);
    }

    // ── 8. Mark event as processed ───────────────────────────────────────
    await markEventProcessed(eventLogRepo, event.dedupeKey);
  } catch (error) {
    // Mark as failed
    if (eventLogEntry) {
      eventLogEntry.status = 'failed';
      eventLogEntry.error = error instanceof Error ? error.message.slice(0, 500) : 'Unknown error';
      await eventLogRepo.save(eventLogEntry);
    }
    throw error;
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Handle delivery / read receipt events by updating MessageDelivery rows.
 */
async function handleReceiptEvent(
  event: NormalizedEvent,
  connection: ChannelConnection,
): Promise<void> {
  if (!event.receipt) return;

  const deliveryRepo = getRepository(MessageDelivery);
  const newStatus = event.receipt.status; // 'delivered' | 'read'

  for (const platformMsgId of event.receipt.messageIds) {
    const delivery = await deliveryRepo.findOne({
      where: {
        platformMessageId: platformMsgId,
        channelConnectionId: connection.id,
      },
    });

    if (delivery) {
      delivery.status = newStatus;
      await deliveryRepo.save(delivery);
    }
  }
}

/**
 * Find an existing conversation binding or create a new session + participant + binding.
 */
async function findOrCreateConversation(
  event: NormalizedEvent,
  connection: ChannelConnection,
): Promise<{ session: ChatSession; participant: Participant; binding: ConversationBinding }> {
  const bindingRepo = getRepository(ConversationBinding);

  // Look for existing binding
  const existingBinding = await bindingRepo.findOne({
    where: {
      channelConnectionId: connection.id,
      externalUserId: event.sender.externalUserId,
      externalThreadId: event.sender.externalThreadId,
    },
    relations: ['session'],
  });

  if (existingBinding && existingBinding.session && existingBinding.session.status !== 'closed') {
    // Reuse active session
    const participantRepo = getRepository(Participant);
    const participant = await participantRepo.findOne({
      where: { sessionId: existingBinding.sessionId, type: 'user', isDeleted: false },
      order: { joinedAt: 'DESC' },
    });

    if (participant) {
      return {
        session: existingBinding.session as ChatSession,
        participant: participant as Participant,
        binding: existingBinding as ConversationBinding,
      };
    }
  }

  if (existingBinding && (!existingBinding.session || existingBinding.session.status === 'closed')) {
    // Session is closed — create new session and update existing binding
    return AppDataSource.transaction(async (manager: EntityManager) => {
      const now = new Date();

      // Plan-gate (step 10, count 2): live COUNT on chat_sessions for cap.
      await enforceCountLimit({
        manager,
        tenantId: connection.tenantId,
        capability: 'sessions',
        errorCode: 'plan_limit_sessions',
        countQuery: (m) =>
          m.count(ChatSession, {
            where: { tenantId: connection.tenantId, status: Not('closed') },
          }),
      });

      const newSession = manager.create(ChatSession, {
        tenantId: connection.tenantId,
        visitorId: event.sender.externalUserId,
        status: 'waiting',
        source: connection.channel,
        channel: connection.channel,
        channelConnectionId: connection.id,
        startedAt: now,
        lastActivityAt: now,
        metadata: {
          customData: {
            externalUserId: event.sender.externalUserId,
            externalThreadId: event.sender.externalThreadId,
            displayName: event.sender.displayName,
          },
        },
      } as DeepPartial<ChatSession>);
      const savedSession = await manager.save(ChatSession, newSession);

      const newParticipant = manager.create(Participant, {
        sessionId: savedSession.id,
        type: 'user',
        name: event.sender.displayName || 'Visitor',
        avatarUrl: event.sender.avatarUrl || undefined,
        isAnonymous: !event.sender.displayName,
        joinedAt: now,
      } as DeepPartial<Participant>);
      const savedParticipant = await manager.save(Participant, newParticipant) as Participant;

      // Update existing binding to point to new session
      existingBinding.sessionId = savedSession.id;
      existingBinding.externalUserName = event.sender.displayName || existingBinding.externalUserName;
      existingBinding.externalAvatarUrl = event.sender.avatarUrl || existingBinding.externalAvatarUrl;
      const updatedBinding = await manager.save(ConversationBinding, existingBinding) as ConversationBinding;

      return {
        session: savedSession,
        participant: savedParticipant,
        binding: updatedBinding,
      };
    });
  }

  // No existing binding — create new session + participant + binding in a transaction
  return AppDataSource.transaction(async (manager: EntityManager) => {
    const now = new Date();

    // Plan-gate (step 10, count 2): live COUNT on chat_sessions for cap.
    await enforceCountLimit({
      manager,
      tenantId: connection.tenantId,
      capability: 'sessions',
      errorCode: 'plan_limit_sessions',
      countQuery: (m) =>
        m.count(ChatSession, {
          where: { tenantId: connection.tenantId, status: Not('closed') },
        }),
    });

    const sessionData = manager.create(ChatSession, {
      tenantId: connection.tenantId,
      visitorId: event.sender.externalUserId,
      status: 'waiting',
      source: connection.channel,
      channel: connection.channel,
      channelConnectionId: connection.id,
      startedAt: now,
      lastActivityAt: now,
      metadata: {
        customData: {
          externalUserId: event.sender.externalUserId,
          externalThreadId: event.sender.externalThreadId,
          displayName: event.sender.displayName,
        },
      },
    } as DeepPartial<ChatSession>);
    const savedSession = await manager.save(ChatSession, sessionData);

    const participantData = manager.create(Participant, {
      sessionId: savedSession.id,
      type: 'user',
      name: event.sender.displayName || 'Visitor',
      avatarUrl: event.sender.avatarUrl || undefined,
      isAnonymous: !event.sender.displayName,
      joinedAt: now,
    } as DeepPartial<Participant>);
    const savedParticipant = await manager.save(Participant, participantData) as Participant;

    const bindingData = manager.create(ConversationBinding, {
      sessionId: savedSession.id,
      channelConnectionId: connection.id,
      externalUserId: event.sender.externalUserId,
      externalThreadId: event.sender.externalThreadId,
      externalUserName: event.sender.displayName || null,
      externalAvatarUrl: event.sender.avatarUrl || null,
      platformUserData: event.sender.platformData || {},
    } as DeepPartial<ConversationBinding>);
    const savedBinding = await manager.save(ConversationBinding, bindingData) as ConversationBinding;

    return {
      session: savedSession,
      participant: savedParticipant,
      binding: savedBinding,
    };
  });
}

/**
 * Map normalized message type to our internal Message type.
 */
function mapMessageType(
  type?: 'text' | 'image' | 'video' | 'audio' | 'file' | 'location' | 'contact' | 'sticker',
): 'text' | 'image' | 'file' {
  switch (type) {
    case 'image':
      return 'image';
    case 'video':
    case 'audio':
    case 'file':
    case 'location':
    case 'contact':
    case 'sticker':
      return 'file';
    default:
      return 'text';
  }
}

/**
 * Mark a dedupe key as processed in the event log.
 */
async function markEventProcessed(
  eventLogRepo: ReturnType<typeof getRepository<WebhookEventLog>>,
  dedupeKey: string,
): Promise<void> {
  await eventLogRepo.update({ dedupeKey }, { status: 'processed' });
}
