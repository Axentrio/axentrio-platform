import { ChannelConnection } from '../../database/entities/ChannelConnection';
import { OutboundChannelMessage, ChannelCapabilities } from '../types';
import { getWhatsAppAccessToken } from '../credential-utils';
import { FB_GRAPH_API as GRAPH_API } from '../meta/graph-api';
import { GraphOutboundTransport, GraphSendRequest } from '../meta/graph-outbound-transport';

/**
 * WhatsApp Cloud API outbound transport.
 *
 * Sends to POST {graph}/{PHONE_NUMBER_ID}/messages with a Bearer token (the
 * system-user / phone-number access token), unlike Messenger/Instagram which
 * pass the token as a query param. `platformAccountId` holds the phone_number_id;
 * `externalThreadId` is the recipient's wa_id.
 */
export class WhatsAppOutboundTransport extends GraphOutboundTransport {
  protected readonly logTag = '[whatsapp]';

  getCapabilities(): ChannelCapabilities {
    return {
      maxTextLength: 4096,
      // Quick replies map to interactive "reply buttons" — capped at 3 by WhatsApp.
      supportsQuickReplies: true,
      maxQuickReplies: 3,
      supportsButtons: true,
      maxButtons: 3,
      // Carousel requires pre-approved templates; out of scope for the spike.
      supportsCarousel: false,
      maxCarouselCards: 0,
      supportsImages: true,
      supportsVideo: true,
      supportsAudio: true,
      supportsFiles: true,
      // Typing indicators are keyed to a specific inbound message_id, not a
      // thread, so they don't fit the OutboundTransport interface.
      supportsTypingIndicator: false,
      supportsReadReceipts: true,
      supportsMessageEdit: false,
      supportsMessageDelete: false,
      supportsStickers: false,
      hasMessagingWindow: true,
      messagingWindowHours: 24,
      requiresTemplatesOutsideWindow: true,
    };
  }

  protected buildRequest(connection: ChannelConnection): GraphSendRequest | { error: string } {
    const accessToken = getWhatsAppAccessToken(connection.credentials);
    if (!accessToken) return { error: 'No WhatsApp access token' };

    const phoneNumberId = connection.platformAccountId;
    if (!phoneNumberId) return { error: 'No phone number ID' };

    return {
      url: `${GRAPH_API}/${phoneNumberId}/messages`,
      config: { headers: { Authorization: `Bearer ${accessToken}` }, timeout: 10000 },
    };
  }

  // Cloud API returns { messages: [{ id: "wamid..." }] }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  protected extractMessageId(data: any): string | undefined {
    return data?.messages?.[0]?.id;
  }

  async sendTypingIndicator(_externalThreadId: string, _connection: ChannelConnection): Promise<void> {
    // WhatsApp typing indicators require a specific inbound message_id, which
    // the thread-scoped interface can't provide. No-op.
  }

  protected buildSendBody(
    message: OutboundChannelMessage,
    recipientId: string,
  ): Record<string, unknown> {
    const base: Record<string, unknown> = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: recipientId,
    };

    switch (message.type) {
      case 'text':
      case 'quick_reply': {
        const buttons = this.collectReplyButtons(message);
        if (buttons.length > 0) {
          return {
            ...base,
            type: 'interactive',
            interactive: {
              type: 'button',
              body: { text: message.content || 'Choose an option' },
              action: { buttons },
            },
          };
        }
        return {
          ...base,
          type: 'text',
          text: { preview_url: false, body: message.content || '' },
        };
      }
      case 'image':
      case 'video':
      case 'audio':
      case 'file': {
        const mediaType = message.type === 'file' ? 'document' : message.type;
        const media: Record<string, unknown> = { link: message.mediaUrl || message.content };
        // WhatsApp allows captions on image/video/document, not audio.
        if (message.content && message.type !== 'audio') {
          media.caption = message.content;
        }
        return { ...base, type: mediaType, [mediaType]: media };
      }
      default: {
        return {
          ...base,
          type: 'text',
          text: { preview_url: false, body: message.content || '' },
        };
      }
    }
  }

  /**
   * Map quick replies and postback buttons to WhatsApp interactive reply
   * buttons (max 3, titles capped at 20 chars). URL buttons can't be reply
   * buttons, so they're dropped here — formatResponseForChannel already
   * appends their content as text where appropriate.
   */
  private collectReplyButtons(
    message: OutboundChannelMessage,
  ): Array<{ type: 'reply'; reply: { id: string; title: string } }> {
    const replies: Array<{ id: string; title: string }> = [];

    for (const qr of message.quickReplies || []) {
      replies.push({ id: qr.payload.slice(0, 256), title: qr.title.slice(0, 20) });
    }
    for (const btn of message.buttons || []) {
      if (btn.type === 'postback') {
        replies.push({ id: btn.value.slice(0, 256), title: btn.title.slice(0, 20) });
      }
    }

    return replies.slice(0, 3).map((r) => ({ type: 'reply', reply: r }));
  }
}
