/**
 * Outbound Router
 * Routes bot/agent/n8n responses to the correct channel transport.
 * Widget sessions → WebSocket only (existing behavior)
 * External channel sessions → Platform API via adapter + WebSocket for portal
 */

import { AppDataSource } from '../database/data-source';
import { ChatSession } from '../database/entities/ChatSession';
import { ConversationBinding } from '../database/entities/ConversationBinding';
import { ChannelConnection } from '../database/entities/ChannelConnection';
import { MessageDelivery } from '../database/entities/MessageDelivery';
import { triggerHealthCheckDebounced } from './health-check.service';
import { ResponsePayload } from './response.types';
import { getChannelAdapter } from './channel-registry';
import { isChannelEntitled } from './channel-entitlement';
import { formatResponseForChannel, DeliveryResult } from './types';
import { emitToSession } from '../websocket/socket.handler';
import { logger } from '../utils/logger';

export interface OutboundContext {
  sessionId: string;
  tenantId: string;
  messageId: string;
}

/**
 * Routes an outbound response to the correct channel.
 * Always broadcasts to portal via WebSocket.
 * For external channels, also sends via platform API.
 */
export async function routeOutboundMessage(
  response: ResponsePayload,
  context: OutboundContext,
  socketEvent?: {
    event: string;
    data: Record<string, unknown>;
  },
  options?: { humanAgent?: boolean },
): Promise<DeliveryResult> {
  const sessionRepository = AppDataSource.getRepository(ChatSession);
  const bindingRepository = AppDataSource.getRepository(ConversationBinding);
  const connectionRepository = AppDataSource.getRepository(ChannelConnection);
  const deliveryRepository = AppDataSource.getRepository(MessageDelivery);

  // Always broadcast to portal agents via WebSocket
  if (socketEvent) {
    emitToSession(context.tenantId, context.sessionId, socketEvent.event, socketEvent.data);
  }

  // Look up session to determine channel
  const session = await sessionRepository.findOne({ where: { id: context.sessionId } });
  if (!session) {
    return { success: false, error: 'Session not found' };
  }

  // Widget channel — WebSocket emission above is sufficient
  if (session.channel === 'widget' || !session.channelConnectionId) {
    return { success: true };
  }

  // External channel: load the connection and check entitlement FIRST
  // (channels plan D10) — an unentitled channel must answer
  // `channel_not_entitled`, never an incidental adapter/binding error,
  // and no external API call of any kind may happen past this point.
  const connection = await connectionRepository.findOne({
    where: { id: session.channelConnectionId },
  });
  if (!connection || !connection.isActive()) {
    logger.warn('[outbound] Channel connection not active — cannot deliver', {
      sessionId: session.id, channel: session.channel,
      channelConnectionId: session.channelConnectionId,
      connectionStatus: connection?.status ?? 'not-found', messageId: context.messageId,
    });
    return { success: false, error: 'Channel connection not active' };
  }

  if (!(await isChannelEntitled(connection.tenantId, connection.channel))) {
    logger.warn('[outbound] Channel not entitled — delivery suppressed', {
      sessionId: session.id, channel: connection.channel, messageId: context.messageId,
    });
    return { success: false, error: 'channel_not_entitled' };
  }

  const adapter = getChannelAdapter(session.channel);
  if (!adapter) {
    logger.warn('[outbound] No adapter for channel — cannot deliver', {
      sessionId: session.id, channel: session.channel, messageId: context.messageId,
    });
    return { success: false, error: `No adapter for channel ${session.channel}` };
  }

  const binding = await bindingRepository.findOne({
    where: { sessionId: session.id, channelConnectionId: session.channelConnectionId },
  });
  if (!binding) {
    logger.warn('[outbound] No conversation binding found — cannot deliver to channel', {
      sessionId: session.id, channel: session.channel,
      channelConnectionId: session.channelConnectionId, messageId: context.messageId,
    });
    return { success: false, error: 'No conversation binding found' };
  }

  logger.info('[outbound] Delivering to channel', {
    sessionId: session.id, channel: connection.channel,
    externalThreadId: binding.externalThreadId, messageId: context.messageId,
  });

  // Format response for this channel's capabilities
  const capabilities = adapter.outboundTransport.getCapabilities();
  const channelMessages = formatResponseForChannel(response, capabilities);

  // A human-agent reply needs Meta's HUMAN_AGENT tag ONLY once the standard
  // messaging window has closed (using RESPONSE inside the window is the norm and
  // avoids tag-abuse review flags). Fail-safe to RESPONSE when lastInboundAt is
  // unknown. Bot replies (humanAgent !== true) are never tagged.
  const windowMs = (capabilities.messagingWindowHours ?? 24) * 60 * 60 * 1000;
  const outsideWindow =
    !!binding.lastInboundAt && Date.now() - binding.lastInboundAt.getTime() > windowMs;
  const useHumanAgentTag = options?.humanAgent === true && outsideWindow;

  for (const msg of channelMessages) {
    if (msg.type === 'typing') {
      await adapter.outboundTransport.sendTypingIndicator(binding.externalThreadId, connection);
      continue;
    }

    if (useHumanAgentTag) msg.humanAgent = true;

    const result = await adapter.outboundTransport.send(
      msg,
      binding.externalThreadId,
      connection,
    );

    // Track delivery
    const delivery = deliveryRepository.create({
      internalMessageId: context.messageId,
      channelConnectionId: connection.id,
      channel: connection.channel,
      platformMessageId: result.platformMessageId || null,
      status: result.success ? 'sent' : 'failed',
      attempts: 1,
      error: result.error || null,
    });
    await deliveryRepository.save(delivery);

    if (!result.success) {
      logger.error(`Channel delivery failed for message ${context.messageId}`, {
        channel: connection.channel,
        error: result.error,
      });
      // A delivery failure can mean the channel itself broke (token expired, page
      // disconnected, WhatsApp permission/window). If the connection still looks
      // active, probe it (debounced, fire-and-forget) so it flips to 'error' +
      // notifies the operator instead of silently staying green — without blocking
      // the reply path or storming the provider on a burst of failures.
      if (connection.status === 'active') {
        void triggerHealthCheckDebounced(connection.id);
      }
      return result;
    }
  }

  return { success: true };
}

/**
 * Send a typing indicator to the correct channel.
 */
export async function routeTypingIndicator(
  sessionId: string,
  tenantId: string,
  isTyping: boolean,
): Promise<void> {
  // Always send to WebSocket for portal
  emitToSession(tenantId, sessionId, 'typing:indicator', {
    isTyping,
    participantType: 'bot',
    timestamp: new Date().toISOString(),
  });

  if (!isTyping) return;
  await sendChannelTypingIndicator(sessionId);
}

/**
 * Push a typing indicator to the end user on their external channel (Messenger
 * typing_on, WhatsApp typing_indicator). Best-effort, and a no-op for widget
 * sessions, inactive/unentitled connections, and channels that don't support
 * typing. Widget + portal typing is handled over the WebSocket by the caller, so
 * this only covers the platform-side bubble.
 */
export async function sendChannelTypingIndicator(sessionId: string): Promise<void> {
  const session = await AppDataSource.getRepository(ChatSession).findOne({ where: { id: sessionId } });
  if (!session || session.channel === 'widget' || !session.channelConnectionId) return;

  const adapter = getChannelAdapter(session.channel);
  if (!adapter) return;

  const binding = await AppDataSource.getRepository(ConversationBinding).findOne({
    where: { sessionId, channelConnectionId: session.channelConnectionId },
  });
  const connection = await AppDataSource.getRepository(ChannelConnection).findOne({
    where: { id: session.channelConnectionId },
  });
  if (!binding || !connection?.isActive()) return;

  // Same gate as message delivery (channels plan D10) — typing indicators are
  // external API calls too.
  if (!(await isChannelEntitled(connection.tenantId, connection.channel))) return;

  try {
    await adapter.outboundTransport.sendTypingIndicator(binding.externalThreadId, connection, {
      lastInboundMessageId: binding.lastInboundMessageId ?? undefined,
    });
  } catch {
    // Typing indicators are best-effort
  }
}
