import axios from 'axios';
import { ChannelConnection } from '../../database/entities/ChannelConnection';
import { OutboundChannelMessage, ChannelCapabilities } from '../types';
import { getMetaPageAccessToken } from '../credential-utils';
import { FB_GRAPH_API as GRAPH_API } from './graph-api';
import { GraphOutboundTransport, GraphSendRequest } from './graph-outbound-transport';

export class MessengerOutboundTransport extends GraphOutboundTransport {
  protected readonly logTag = '[messenger]';

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

  protected buildRequest(connection: ChannelConnection): GraphSendRequest | { error: string } {
    const accessToken = getMetaPageAccessToken(connection.credentials);
    if (!accessToken) return { error: 'No page access token' };

    const pageId = connection.platformAccountId;
    if (!pageId) return { error: 'No page ID' };

    return {
      url: `${GRAPH_API}/${pageId}/messages`,
      config: { params: { access_token: accessToken }, timeout: 10000 },
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  protected extractMessageId(data: any): string | undefined {
    return data?.message_id;
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

  protected buildSendBody(
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
