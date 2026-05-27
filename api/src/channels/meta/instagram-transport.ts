import { ChannelConnection } from '../../database/entities/ChannelConnection';
import { OutboundChannelMessage, ChannelCapabilities } from '../types';
import { getMetaPageAccessToken } from '../credential-utils';
import { IG_GRAPH_API } from './graph-api';
import { GraphOutboundTransport, GraphSendRequest } from './graph-outbound-transport';

export class InstagramOutboundTransport extends GraphOutboundTransport {
  protected readonly logTag = '[instagram]';

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

  protected buildRequest(connection: ChannelConnection): GraphSendRequest | { error: string } {
    const accessToken = getMetaPageAccessToken(connection.credentials);
    if (!accessToken) return { error: 'No page access token' };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const igBusinessId = (connection.credentials as any).igBusinessId || connection.platformAccountId;
    return {
      url: `${IG_GRAPH_API}/${igBusinessId}/messages`,
      config: { params: { access_token: accessToken }, timeout: 10000 },
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  protected extractMessageId(data: any): string | undefined {
    return data?.message_id;
  }

  async sendTypingIndicator(_externalThreadId: string, _connection: ChannelConnection): Promise<void> {
    // Instagram does not support typing indicators
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
