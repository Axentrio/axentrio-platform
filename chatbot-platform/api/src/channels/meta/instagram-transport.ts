import axios from 'axios';
import { ChannelConnection } from '../../database/entities/ChannelConnection';
import { OutboundTransport, OutboundChannelMessage, DeliveryResult, ChannelCapabilities } from '../types';
import { getMetaPageAccessToken } from '../credential-utils';
import { logger } from '../../utils/logger';

const IG_GRAPH_API = 'https://graph.instagram.com/v21.0';

export class InstagramOutboundTransport implements OutboundTransport {
  getCapabilities(): ChannelCapabilities {
    return {
      maxTextLength: 1000,
      supportsQuickReplies: true,
      maxQuickReplies: 13,
      supportsButtons: true,
      maxButtons: 3,
      supportsCarousel: true,
      maxCarouselCards: 10,
      supportsImages: true,
      supportsVideo: true,
      supportsAudio: true,
      supportsFiles: false,
      supportsTypingIndicator: false,
      supportsReadReceipts: false,
      supportsMessageEdit: false,
      supportsMessageDelete: false,
      supportsStickers: false,
      hasMessagingWindow: true,
      messagingWindowHours: 24,
      requiresTemplatesOutsideWindow: false,
    };
  }

  async send(
    message: OutboundChannelMessage,
    externalThreadId: string,
    connection: ChannelConnection,
  ): Promise<DeliveryResult> {
    const accessToken = getMetaPageAccessToken(connection.credentials);
    const igBusinessId = (connection.credentials as any).igBusinessId || connection.platformAccountId;

    if (!accessToken) {
      return { success: false, error: 'No page access token', retryable: false };
    }

    try {
      const body = this.buildSendBody(message, externalThreadId);
      const response = await axios.post(
        `${IG_GRAPH_API}/${igBusinessId}/messages`,
        body,
        {
          params: { access_token: accessToken },
          timeout: 10000,
        },
      );

      return {
        success: true,
        platformMessageId: response.data?.message_id,
      };
    } catch (error) {
      const errMsg = axios.isAxiosError(error)
        ? error.response?.data?.error?.message || error.message
        : error instanceof Error ? error.message : 'Unknown error';
      const retryable = axios.isAxiosError(error)
        ? (error.response?.status || 0) >= 500 || error.response?.status === 429
        : true;

      logger.error(`[instagram] Send failed to ${externalThreadId}:`, errMsg);
      return { success: false, error: errMsg, retryable };
    }
  }

  async sendTypingIndicator(_externalThreadId: string, _connection: ChannelConnection): Promise<void> {
    // Instagram does not support typing indicators
  }

  private buildSendBody(
    message: OutboundChannelMessage,
    recipientId: string,
  ): Record<string, unknown> {
    const body: Record<string, unknown> = {
      recipient: { id: recipientId },
      // TODO: Support HUMAN_AGENT tag for live agent sessions.
      // When session status is 'active' (agent assigned), should use:
      //   messaging_type: 'MESSAGE_TAG', tag: 'HUMAN_AGENT'
      // This enables a 7-day messaging window for human agent replies.
      // Requires threading session status through to the transport's send method.
      messaging_type: 'RESPONSE',
    };

    switch (message.type) {
      case 'text':
      case 'quick_reply': {
        body.message = { text: message.content || '' };

        if (message.quickReplies && message.quickReplies.length > 0) {
          (body.message as any).quick_replies = message.quickReplies
            .slice(0, 13)
            .map((qr) => ({
              content_type: 'text',
              title: qr.title.slice(0, 20),
              payload: qr.payload.slice(0, 1000),
            }));
        }
        break;
      }
      case 'image': {
        body.message = {
          attachment: {
            type: 'image',
            payload: { url: message.mediaUrl || message.content },
          },
        };
        break;
      }
      case 'video': {
        body.message = {
          attachment: {
            type: 'video',
            payload: { url: message.mediaUrl || message.content },
          },
        };
        break;
      }
      case 'audio': {
        body.message = {
          attachment: {
            type: 'audio',
            payload: { url: message.mediaUrl || message.content },
          },
        };
        break;
      }
      default: {
        body.message = { text: message.content || '' };
      }
    }

    return body;
  }
}
