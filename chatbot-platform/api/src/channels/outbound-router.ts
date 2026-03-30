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
import { ResponsePayload } from '../n8n/types/message.types';
import { getChannelAdapter } from './channel-registry';
import { formatResponseForChannel, DeliveryResult } from './types';
import { emitToSession } from '../websocket/socket.handler';
import { logger } from '../utils/logger';

const sessionRepository = AppDataSource.getRepository(ChatSession);
const bindingRepository = AppDataSource.getRepository(ConversationBinding);
const connectionRepository = AppDataSource.getRepository(ChannelConnection);
const deliveryRepository = AppDataSource.getRepository(MessageDelivery);

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
): Promise<DeliveryResult> {
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

  // External channel — route through adapter
  const adapter = getChannelAdapter(session.channel);
  if (!adapter) {
    return { success: false, error: `No adapter for channel ${session.channel}` };
  }

  const binding = await bindingRepository.findOne({
    where: { sessionId: session.id, channelConnectionId: session.channelConnectionId },
  });
  if (!binding) {
    return { success: false, error: 'No conversation binding found' };
  }

  const connection = await connectionRepository.findOne({
    where: { id: session.channelConnectionId },
  });
  if (!connection || !connection.isActive()) {
    return { success: false, error: 'Channel connection not active' };
  }

  // Format response for this channel's capabilities
  const capabilities = adapter.outboundTransport.getCapabilities();
  const channelMessages = formatResponseForChannel(response, capabilities);

  for (const msg of channelMessages) {
    if (msg.type === 'typing') {
      await adapter.outboundTransport.sendTypingIndicator(binding.externalThreadId, connection);
      continue;
    }

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

  const session = await sessionRepository.findOne({ where: { id: sessionId } });
  if (!session || session.channel === 'widget' || !session.channelConnectionId) return;

  const adapter = getChannelAdapter(session.channel);
  if (!adapter) return;

  const binding = await bindingRepository.findOne({
    where: { sessionId, channelConnectionId: session.channelConnectionId },
  });
  const connection = await connectionRepository.findOne({
    where: { id: session.channelConnectionId },
  });

  if (binding && connection?.isActive()) {
    try {
      await adapter.outboundTransport.sendTypingIndicator(binding.externalThreadId, connection);
    } catch {
      // Typing indicators are best-effort
    }
  }
}
