import axios from 'axios';
import { ChannelConnection } from '../../database/entities/ChannelConnection';
import { OutboundTransport, OutboundChannelMessage, DeliveryResult, ChannelCapabilities } from '../types';
import { getMetaPageAccessToken } from '../credential-utils';
import { logger } from '../../utils/logger';

const GRAPH_API = 'https://graph.facebook.com/v21.0';

export class MessengerOutboundTransport implements OutboundTransport {
  getCapabilities(): ChannelCapabilities {
    return {
      maxTextLength: 2000,
      supportsQuickReplies: true,
      maxQuickReplies: 13,
      supportsButtons: true,
      maxButtons: 3,
      supportsCarousel: true,
      maxCarouselCards: 10,
      supportsImages: true,
      supportsVideo: true,
      supportsAudio: true,
      supportsFiles: true,
      supportsTypingIndicator: true,
      supportsReadReceipts: false,
      supportsMessageEdit: false,
      supportsMessageDelete: false,
      supportsStickers: false,
      hasMessagingWindow: true,
      messagingWindowHours: 24,
      requiresTemplatesOutsideWindow: true,
    };
  }

  async send(
    message: OutboundChannelMessage,
    externalThreadId: string,
    connection: ChannelConnection,
  ): Promise<DeliveryResult> {
    const accessToken = getMetaPageAccessToken(connection.credentials);
    if (!accessToken) {
      return { success: false, error: 'No page access token', retryable: false };
    }

    const pageId = connection.platformAccountId;
    if (!pageId) {
      return { success: false, error: 'No page ID', retryable: false };
    }

    try {
      const body = this.buildSendBody(message, externalThreadId);
      const response = await axios.post(
        `${GRAPH_API}/${pageId}/messages`,
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

      logger.error(`[messenger] Send failed to ${externalThreadId}:`, errMsg);
      return { success: false, error: errMsg, retryable };
    }
  }

  async sendTypingIndicator(externalThreadId: string, connection: ChannelConnection): Promise<void> {
    const accessToken = getMetaPageAccessToken(connection.credentials);
    const pageId = connection.platformAccountId;
    if (!accessToken || !pageId) return;

    try {
      await axios.post(
        `${GRAPH_API}/${pageId}/messages`,
        {
          recipient: { id: externalThreadId },
          sender_action: 'typing_on',
          messaging_type: 'RESPONSE',
        },
        { params: { access_token: accessToken }, timeout: 5000 },
      );
    } catch {
      // Typing indicators are best-effort
    }
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

        if (message.buttons && message.buttons.length > 0) {
          body.message = {
            attachment: {
              type: 'template',
              payload: {
                template_type: 'button',
                text: message.content || 'Choose an option',
                buttons: message.buttons.slice(0, 3).map((btn) =>
                  btn.type === 'url'
                    ? { type: 'web_url', title: btn.title, url: btn.value }
                    : { type: 'postback', title: btn.title, payload: btn.value },
                ),
              },
            },
          };
        }
        break;
      }
      case 'image':
      case 'video':
      case 'audio':
      case 'file': {
        body.message = {
          attachment: {
            type: message.type === 'file' ? 'file' : message.type,
            payload: { url: message.mediaUrl || message.content, is_reusable: true },
          },
        };
        break;
      }
      case 'carousel': {
        if (message.cards && message.cards.length > 0) {
          body.message = {
            attachment: {
              type: 'template',
              payload: {
                template_type: 'generic',
                elements: message.cards.slice(0, 10).map((card) => ({
                  title: card.title,
                  subtitle: card.subtitle,
                  image_url: card.imageUrl,
                  buttons: card.buttons?.slice(0, 3).map((btn) =>
                    btn.type === 'url'
                      ? { type: 'web_url', title: btn.title, url: btn.value }
                      : { type: 'postback', title: btn.title, payload: btn.value },
                  ),
                })),
              },
            },
          };
        }
        break;
      }
      default: {
        body.message = { text: message.content || '' };
      }
    }

    return body;
  }
}
