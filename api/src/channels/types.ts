import { Request } from 'express';
import { ChannelConnection, ChannelType } from '../database/entities/ChannelConnection';
import { ResponsePayload } from '../n8n/types/message.types';

// --- Inbound (platform → us) ---

export interface NormalizedEvent {
  type: 'message' | 'postback' | 'delivery' | 'read' | 'reaction' | 'referral' | 'status' | 'unknown';
  message?: {
    type: 'text' | 'image' | 'video' | 'audio' | 'file' | 'location' | 'contact' | 'sticker';
    content: string;
    mediaUrl?: string;
    mediaMetadata?: Record<string, unknown>;
    replyToExternalId?: string;
  };
  postback?: {
    payload: string;
    title?: string;
  };
  receipt?: {
    messageIds: string[];
    status: 'delivered' | 'read';
  };
  sender: {
    externalUserId: string;
    externalThreadId: string;
    displayName?: string;
    avatarUrl?: string;
    platformData?: Record<string, unknown>;
  };
  dedupeKey: string;
  timestamp: Date;
  rawEventType: string;
}

// --- Outbound (us → platform) ---

export interface OutboundChannelMessage {
  type: 'text' | 'image' | 'video' | 'audio' | 'file' | 'quick_reply' | 'carousel' | 'template' | 'typing';
  content?: string;
  quickReplies?: Array<{ title: string; payload: string }>;
  buttons?: Array<{ type: 'url' | 'postback'; title: string; value: string }>;
  mediaUrl?: string;
  mediaMetadata?: Record<string, unknown>;
  cards?: Array<{
    title: string;
    subtitle?: string;
    imageUrl?: string;
    buttons?: Array<{ type: 'url' | 'postback'; title: string; value: string }>;
  }>;
}

export interface DeliveryResult {
  success: boolean;
  platformMessageId?: string;
  error?: string;
  retryable?: boolean;
}

// --- Channel Capability Flags ---

export interface ChannelCapabilities {
  maxTextLength: number;
  supportsQuickReplies: boolean;
  maxQuickReplies: number;
  supportsButtons: boolean;
  maxButtons: number;
  supportsCarousel: boolean;
  maxCarouselCards: number;
  supportsImages: boolean;
  supportsVideo: boolean;
  supportsAudio: boolean;
  supportsFiles: boolean;
  supportsTypingIndicator: boolean;
  supportsReadReceipts: boolean;
  supportsMessageEdit: boolean;
  supportsMessageDelete: boolean;
  supportsStickers: boolean;
  hasMessagingWindow: boolean;
  messagingWindowHours?: number;
  requiresTemplatesOutsideWindow: boolean;
}

// --- Four-Concern Pipeline Interfaces ---

export interface ConnectionResolver {
  resolve(req: Request): Promise<ChannelConnection | null>;
}

export interface WebhookVerifier {
  handleVerificationChallenge(req: Request, connection: ChannelConnection): string | null;
  verifySignature(req: Request, connection: ChannelConnection): boolean;
}

export interface EventNormalizer {
  normalize(rawPayload: unknown, connection: ChannelConnection): NormalizedEvent[];
}

export interface OutboundTransport {
  send(
    message: OutboundChannelMessage,
    externalThreadId: string,
    connection: ChannelConnection,
  ): Promise<DeliveryResult>;
  sendTypingIndicator(externalThreadId: string, connection: ChannelConnection): Promise<void>;
  getCapabilities(): ChannelCapabilities;
}

// --- Channel Adapter (combines all four concerns) ---

export interface ChannelAdapter {
  channel: ChannelType;
  connectionResolver: ConnectionResolver;
  webhookVerifier: WebhookVerifier;
  eventNormalizer: EventNormalizer;
  outboundTransport: OutboundTransport;
}

// --- Response Formatter Utility ---

export function formatResponseForChannel(
  response: ResponsePayload,
  capabilities: ChannelCapabilities,
): OutboundChannelMessage[] {
  const messages: OutboundChannelMessage[] = [];
  const type = response.type || 'text';

  switch (type) {
    case 'text':
    case 'quick_reply': {
      const msg: OutboundChannelMessage = {
        type: 'text',
        content: typeof response.content === 'string' ? response.content : JSON.stringify(response.content),
      };
      if (response.quickReplies && capabilities.supportsQuickReplies) {
        msg.type = 'quick_reply';
        msg.quickReplies = response.quickReplies
          .slice(0, capabilities.maxQuickReplies)
          .map((qr) => typeof qr === 'string' ? { title: qr, payload: qr } : { title: qr.title, payload: qr.value || qr.title });
      }
      if (response.buttons && capabilities.supportsButtons) {
        msg.buttons = response.buttons
          .slice(0, capabilities.maxButtons)
          .map((b) => ({ type: b.type as 'url' | 'postback', title: b.title, value: b.url || b.value || '' }));
      }
      if (msg.content && msg.content.length > capabilities.maxTextLength) {
        msg.content = msg.content.slice(0, capabilities.maxTextLength - 3) + '...';
      }
      messages.push(msg);
      break;
    }
    case 'image':
    case 'video':
    case 'audio':
    case 'file': {
      if (
        (type === 'image' && !capabilities.supportsImages) ||
        (type === 'video' && !capabilities.supportsVideo) ||
        (type === 'audio' && !capabilities.supportsAudio) ||
        (type === 'file' && !capabilities.supportsFiles)
      ) {
        messages.push({
          type: 'text',
          content: typeof response.content === 'string' ? response.content : `[${type} attachment]`,
        });
      } else {
        messages.push({
          type,
          mediaUrl: typeof response.content === 'string' ? response.content : undefined,
          content: typeof response.content === 'string' ? response.content : undefined,
        });
      }
      break;
    }
    case 'carousel': {
      // Carousel data comes from n8n with arbitrary shapes, cast to any
      const attachments = (response.attachments || []) as any[];
      if (!capabilities.supportsCarousel) {
        for (const att of attachments.slice(0, 5)) {
          messages.push({
            type: 'text',
            content: `*${att.title || ''}*\n${att.description || ''}`,
            buttons: att.buttons?.map((b: any) => ({
              type: b.type as 'url' | 'postback',
              title: b.title,
              value: b.url || b.value || '',
            })),
          });
        }
        if (messages.length === 0) {
          messages.push({ type: 'text', content: typeof response.content === 'string' ? response.content : '[carousel]' });
        }
      } else {
        messages.push({
          type: 'carousel',
          cards: attachments.slice(0, capabilities.maxCarouselCards).map((att: any) => ({
            title: att.title || '',
            subtitle: att.description,
            imageUrl: att.url,
            buttons: att.buttons?.slice(0, capabilities.maxButtons).map((b: any) => ({
              type: b.type as 'url' | 'postback',
              title: b.title,
              value: b.url || b.value || '',
            })),
          })),
        });
      }
      break;
    }
    case 'typing': {
      if (capabilities.supportsTypingIndicator) {
        messages.push({ type: 'typing' });
      }
      break;
    }
    default: {
      messages.push({
        type: 'text',
        content: typeof response.content === 'string' ? response.content : JSON.stringify(response.content),
      });
    }
  }

  return messages;
}
