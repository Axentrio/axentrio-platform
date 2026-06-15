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
import { Bot } from '../database/entities/Bot';
import { Participant } from '../database/entities/Participant';
import { Message } from '../database/entities/Message';
import { ChannelConnection } from '../database/entities/ChannelConnection';
import { MessageDelivery } from '../database/entities/MessageDelivery';
import { NormalizedEvent } from './types';
import { isChannelEntitled } from './channel-entitlement';
import { encrypt } from '../utils/encryption';
import { forwardMessageToN8n } from '../services/message-forwarding.service';
import { emitToSession, emitToTenantAgents } from '../websocket/socket.handler';
import { logger } from '../utils/logger';
import { enforceCountLimit, requireFeature } from '../billing/enforce';
import { ServiceType } from '../database/entities/ServiceType';
import { getUploadService } from '../file-handling/upload.service';
import { upsertLead } from '../leads/lead-capture.service';
import { Not, IsNull } from 'typeorm';

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

  // `skipped` (entitlement-gated) is terminal like `processed` — a provider
  // redelivery of a skipped event must dedupe, not reprocess.
  if (existing && (existing.status === 'processed' || existing.status === 'skipped')) {
    logger.debug(`[inbound-pipeline] Skipping already-${existing.status} event ${event.dedupeKey}`);
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

  // ── 2b. Channel entitlement gate (channels plan D3/D9) ─────────────────
  // The webhook was already ACKed 200 upstream, so provider delivery health
  // never sees this. An unentitled channel is fully inert: no session, no
  // message, no n8n forward, no media ingest. Terminal skip → redeliveries
  // dedupe at step 1.
  if (!(await isChannelEntitled(connection.tenantId, connection.channel))) {
    eventLogEntry.status = 'skipped';
    eventLogEntry.error = 'channel_not_entitled';
    await eventLogRepo.save(eventLogEntry);
    logger.debug(
      `[inbound-pipeline] ${connection.channel} not entitled for tenant ${connection.tenantId} — event skipped`,
    );
    return;
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
    const { session, participant, binding, created } = await findOrCreateConversation(event, connection);

    // Hook 1 (leads-across-all-channels): a brand-new binding = a new contact
    // reachable on this channel → capture a Lead deterministically, no LLM.
    // Gated by the per-channel auto-capture toggle (default on). Fire-and-forget:
    // the service logs its own failures and must never block message processing
    // or the (already-sent) webhook ACK.
    if (created && (connection.config as { autoCaptureLeads?: boolean })?.autoCaptureLeads !== false) {
      void upsertLead({
        dataSource: AppDataSource,
        tenantId: connection.tenantId,
        sessionId: session.id,
        botId: session.botId ?? null,
        source: 'channel',
        channel: connection.channel,
        externalUserId: binding.externalUserId,
        name: binding.externalUserName,
      }).catch(() => {});
    }

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

    // Remember the latest inbound platform message id so a typing indicator can
    // be anchored to it later (WhatsApp keys typing to a specific message_id).
    if (event.externalMessageId) {
      await getRepository(ConversationBinding).update(
        { id: binding.id },
        { lastInboundMessageId: event.externalMessageId, lastInboundAt: event.timestamp },
      );
    }

    // ── 5b. Ingest inbound media (fire-and-forget) ───────────────────────
    // Download/scan an inbound image into a `ready` upload_session so it
    // auto-attaches to a later booking. NEVER awaited — must not delay the
    // webhook ack or forwarding, and must never throw into the pipeline.
    void maybeIngestInboundMedia(event, connection, session).catch((err) =>
      logger.warn('[inbound] media ingestion failed', {
        sessionId: session.id,
        error: err instanceof Error ? err.message : String(err),
      }),
    );

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
 * Resolve which bot a channel's inbound messages route to. The connection's
 * assigned bot when set and still valid (tenant-owned, active, not deleted);
 * otherwise the tenant's anchor bot. Falling back (rather than erroring) keeps
 * messages flowing if an assigned bot is later paused or deleted.
 */
async function resolveChannelBotId(connection: ChannelConnection): Promise<string> {
  const botRepo = getRepository(Bot);
  if (connection.botId) {
    const assigned = await botRepo.findOne({
      where: {
        id: connection.botId,
        tenantId: connection.tenantId,
        status: 'active',
        deletedAt: IsNull(),
      },
    });
    if (assigned) return assigned.id;
    logger.warn('[inbound] channel-assigned bot invalid/inactive; falling back to anchor', {
      connectionId: connection.id,
      assignedBotId: connection.botId,
      tenantId: connection.tenantId,
    });
  }
  const anchorBot = await botRepo.findOne({
    where: { tenantId: connection.tenantId, isDefault: true },
  });
  if (!anchorBot) {
    throw new Error(`No anchor bot found for tenant ${connection.tenantId}; cannot create channel session`);
  }
  return anchorBot.id;
}

/**
 * Find an existing conversation binding or create a new session + participant + binding.
 * Exported for regression testing of the per-tenant session creation (bot_id).
 */
export async function findOrCreateConversation(
  event: NormalizedEvent,
  connection: ChannelConnection,
): Promise<{ session: ChatSession; participant: Participant; binding: ConversationBinding; created: boolean }> {
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

  logger.info('[inbound] findOrCreateConversation binding lookup', {
    channelConnectionId: connection.id,
    channel: connection.channel,
    externalUserId: event.sender.externalUserId,
    externalThreadId: event.sender.externalThreadId,
    bindingFound: !!existingBinding,
    boundSessionId: existingBinding?.sessionId,
    boundSessionStatus: existingBinding?.session?.status,
  });

  if (existingBinding && existingBinding.session && existingBinding.session.status !== 'closed') {
    // Reuse active session
    const participantRepo = getRepository(Participant);
    const participant = await participantRepo.findOne({
      where: { sessionId: existingBinding.sessionId, type: 'user', isDeleted: false },
      order: { joinedAt: 'DESC' },
    });

    if (participant) {
      logger.info('[inbound] Reusing active session', {
        sessionId: existingBinding.sessionId, bindingId: existingBinding.id,
      });
      return {
        session: existingBinding.session as ChatSession,
        participant: participant as Participant,
        binding: existingBinding as ConversationBinding,
        created: false,
      };
    }
  }

  // Resolve the bot for this channel (chat_sessions.bot_id is NOT NULL):
  // the connection's assigned bot when set and still valid (owned, active,
  // not soft-deleted), otherwise the tenant's anchor bot. An invalid/inactive
  // assignment falls back to the anchor rather than dropping the message.
  const targetBotId = await resolveChannelBotId(connection);

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
        botId: targetBotId,
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

      // Update existing binding to point to new session.
      // NOTE: ConversationBinding.session is a @ManyToOne sharing the sessionId
      // column. It was loaded with relations:['session'] and still references the
      // old (closed) session, so on save TypeORM would resolve the FK from that
      // stale relation and clobber sessionId back to the closed session — which
      // left every reopened session without a binding ("No conversation binding
      // found" on outbound). Update the relation too so the FK persists correctly.
      existingBinding.session = savedSession;
      existingBinding.sessionId = savedSession.id;
      existingBinding.externalUserName = event.sender.displayName || existingBinding.externalUserName;
      existingBinding.externalAvatarUrl = event.sender.avatarUrl || existingBinding.externalAvatarUrl;
      const updatedBinding = await manager.save(ConversationBinding, existingBinding) as ConversationBinding;

      logger.info('[inbound] Closed session reopened — binding reassigned to new session', {
        newSessionId: savedSession.id, bindingId: updatedBinding.id,
        externalThreadId: updatedBinding.externalThreadId,
      });

      return {
        session: savedSession,
        participant: savedParticipant,
        binding: updatedBinding,
        created: false, // binding pre-existed (returning contact) — not a new lead
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
      botId: targetBotId,
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

    logger.info('[inbound] New session + binding created', {
      sessionId: savedSession.id, bindingId: savedBinding.id,
      externalThreadId: savedBinding.externalThreadId,
    });

    return {
      session: savedSession,
      participant: savedParticipant,
      binding: savedBinding,
      created: true, // brand-new binding → Hook 1 captures a Lead
    };
  });
}

/**
 * True when the tenant's bot has at least one active, file-upload-accepting
 * service — i.e. an inbound image could actually attach to a booking. Cheap
 * COUNT, no rows loaded.
 */
export async function botHasActiveFileService(tenantId: string, botId: string): Promise<boolean> {
  const repo = getRepository(ServiceType);
  const count = await repo.count({
    where: { tenantId, botId, isActive: true, fileUploadAllowed: true },
  });
  return count > 0;
}

/**
 * Gate + ingest an inbound channel image into a `ready` upload_session.
 *
 * Ingest only when ALL hold: a media URL is present and normalized
 * `type === 'image'` and it is NOT a sticker; the channel is messenger or
 * instagram; the tenant is entitled to file upload; and the bot has an active
 * file-accepting service. On a successful new/interrupted ingest, runs the scan
 * so the row converges to `ready`. Launched fire-and-forget by the caller.
 */
export async function maybeIngestInboundMedia(
  event: NormalizedEvent,
  connection: ChannelConnection,
  session: ChatSession,
): Promise<void> {
  // (a) media + image + not a sticker (cheapest)
  const msg = event.message;
  if (!msg?.mediaUrl || msg.type !== 'image' || msg.mediaMetadata?.stickerId) {
    return;
  }

  // (b) channel
  if (connection.channel !== 'messenger' && connection.channel !== 'instagram') {
    return;
  }

  // (c) entitlement — requireFeature throws if not entitled.
  try {
    await requireFeature(connection.tenantId, 'fileUpload', 'plan_limit_file_upload');
  } catch {
    return;
  }

  // (d) bot has an active file-accepting service.
  if (!(await botHasActiveFileService(connection.tenantId, session.botId))) {
    return;
  }

  const result = await getUploadService().ingestRemoteFile({
    url: msg.mediaUrl,
    tenantId: connection.tenantId,
    chatSessionId: session.id,
    botId: session.botId,
    externalUserId: event.sender.externalUserId,
    fileName: typeof msg.mediaMetadata?.fileName === 'string' ? msg.mediaMetadata.fileName : undefined,
    eventDedupeKey: event.dedupeKey,
    eventTimestamp: event.timestamp,
  });

  if (result && result.needsScan) {
    // Dynamic import: virus-scan-trigger pulls in the optional native `clamscan`
    // dep, which isn't present in all environments — keep it off the module-load
    // path (matches the widget upload-complete handler's pattern).
    const { performScan } = await import('../file-handling/virus-scan-trigger');
    await performScan(result.sessionId, result.fileKey);
  }
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
