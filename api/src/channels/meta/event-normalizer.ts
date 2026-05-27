import { NormalizedEvent, EventNormalizer } from '../types';
import { ChannelConnection } from '../../database/entities/ChannelConnection';
import crypto from 'crypto';

// --- Meta webhook types ---

interface MetaWebhookPayload {
  object: 'page' | 'instagram';
  entry: MetaEntry[];
}

interface MetaEntry {
  id: string;
  time: number;
  messaging?: MetaMessagingEvent[];
}

interface MetaMessagingEvent {
  sender: { id: string };
  recipient: { id: string };
  timestamp: number;
  message?: MetaMessage;
  postback?: MetaPostback;
  delivery?: MetaDelivery;
  read?: MetaRead;
  referral?: MetaReferral;
  reaction?: MetaReaction;
}

interface MetaMessage {
  mid: string;
  text?: string;
  attachments?: MetaAttachment[];
  quick_reply?: { payload: string };
  is_echo?: boolean;
  reply_to?: { mid: string };
}

interface MetaAttachment {
  type: 'image' | 'video' | 'audio' | 'file' | 'fallback' | 'template';
  payload?: {
    url?: string;
    sticker_id?: number;
  };
}

interface MetaPostback {
  title: string;
  payload: string;
  mid?: string;
}

interface MetaDelivery {
  mids?: string[];
  watermark: number;
}

interface MetaRead {
  watermark: number;
}

interface MetaReferral {
  ref?: string;
  source?: string;
  type?: string;
}

interface MetaReaction {
  reaction: string;
  emoji?: string;
  action: 'react' | 'unreact';
  mid: string;
}

/**
 * Normalize a Meta webhook payload into NormalizedEvent[].
 * Handles both Messenger ("page") and Instagram ("instagram") payloads.
 */
export function normalizeMetaPayload(payload: MetaWebhookPayload): Array<{
  event: NormalizedEvent;
  recipientId: string;
  channel: 'messenger' | 'instagram';
}> {
  const results: Array<{
    event: NormalizedEvent;
    recipientId: string;
    channel: 'messenger' | 'instagram';
  }> = [];

  const channel: 'messenger' | 'instagram' =
    payload.object === 'instagram' ? 'instagram' : 'messenger';

  for (const entry of payload.entry) {
    if (!entry.messaging) continue;

    for (const messaging of entry.messaging) {
      // Skip echo events (our own messages sent back)
      if (messaging.message?.is_echo) continue;

      const normalized = normalizeMessagingEvent(messaging, entry, channel);
      if (normalized) {
        results.push({
          event: normalized,
          recipientId: messaging.recipient.id,
          channel,
        });
      }
    }
  }

  return results;
}

/**
 * Adapter-interface normalizer. Filters the payload to the events for the
 * resolved connection (matched by channel + Page/IG id) and returns plain
 * NormalizedEvent[], matching the WhatsApp adapter shape.
 */
export class MetaEventNormalizer implements EventNormalizer {
  normalize(rawPayload: unknown, connection: ChannelConnection): NormalizedEvent[] {
    return normalizeMetaPayload(rawPayload as MetaWebhookPayload)
      .filter((r) => r.channel === connection.channel && r.recipientId === connection.platformAccountId)
      .map((r) => r.event);
  }
}

function normalizeMessagingEvent(
  messaging: MetaMessagingEvent,
  entry: MetaEntry,
  channel: 'messenger' | 'instagram',
): NormalizedEvent | null {
  const sender = {
    externalUserId: messaging.sender.id,
    externalThreadId: messaging.sender.id, // 1:1 messaging, thread = sender
    platformData: { channel },
  };

  // Quick reply (treat as postback)
  if (messaging.message?.quick_reply) {
    return {
      type: 'postback',
      postback: {
        payload: messaging.message.quick_reply.payload,
        title: messaging.message.text,
      },
      sender,
      dedupeKey: `meta:${channel}:${entry.id}:${messaging.sender.id}:qr:${messaging.message.mid}`,
      timestamp: new Date(messaging.timestamp),
      rawEventType: 'quick_reply',
    };
  }

  // Text or attachment message
  if (messaging.message) {
    const msg = messaging.message;

    if (msg.text && !msg.attachments?.length) {
      // Pure text message
      return {
        type: 'message',
        message: {
          type: 'text',
          content: msg.text,
          replyToExternalId: msg.reply_to?.mid,
        },
        sender,
        dedupeKey: `meta:${channel}:${entry.id}:${messaging.sender.id}:${msg.mid}`,
        timestamp: new Date(messaging.timestamp),
        rawEventType: 'message.text',
      };
    }

    if (msg.attachments && msg.attachments.length > 0) {
      // Use first attachment (most common case)
      const att = msg.attachments[0];
      const type = att.type === 'image' ? 'image'
        : att.type === 'video' ? 'video'
        : att.type === 'audio' ? 'audio'
        : att.type === 'file' ? 'file'
        : 'file'; // fallback/template → file

      return {
        type: 'message',
        message: {
          type,
          content: msg.text || '',
          mediaUrl: att.payload?.url,
          mediaMetadata: {
            attachmentType: att.type,
            stickerId: att.payload?.sticker_id,
          },
          replyToExternalId: msg.reply_to?.mid,
        },
        sender,
        dedupeKey: `meta:${channel}:${entry.id}:${messaging.sender.id}:${msg.mid}`,
        timestamp: new Date(messaging.timestamp),
        rawEventType: `message.${att.type}`,
      };
    }

    // Message with no text or attachments — skip
    return null;
  }

  // Postback
  if (messaging.postback) {
    const payloadHash = crypto
      .createHash('sha256')
      .update(messaging.postback.payload)
      .digest('hex')
      .slice(0, 16);

    return {
      type: 'postback',
      postback: {
        payload: messaging.postback.payload,
        title: messaging.postback.title,
      },
      sender,
      dedupeKey: `meta:${channel}:${entry.id}:${messaging.sender.id}:postback:${messaging.timestamp}:${payloadHash}`,
      timestamp: new Date(messaging.timestamp),
      rawEventType: 'postback',
    };
  }

  // Delivery receipt
  if (messaging.delivery?.mids) {
    return {
      type: 'delivery',
      receipt: {
        messageIds: messaging.delivery.mids,
        status: 'delivered',
      },
      sender,
      dedupeKey: `meta:${channel}:${entry.id}:delivery:${messaging.delivery.watermark}`,
      timestamp: new Date(messaging.timestamp),
      rawEventType: 'delivery',
    };
  }

  // Read receipt (log only — watermark doesn't map to specific IDs)
  if (messaging.read) {
    return {
      type: 'read',
      receipt: {
        messageIds: [],
        status: 'read',
      },
      sender,
      dedupeKey: `meta:${channel}:${entry.id}:read:${messaging.read.watermark}`,
      timestamp: new Date(messaging.timestamp),
      rawEventType: 'read',
    };
  }

  // Referral
  if (messaging.referral) {
    return {
      type: 'referral',
      sender,
      dedupeKey: `meta:${channel}:${entry.id}:referral:${messaging.timestamp}`,
      timestamp: new Date(messaging.timestamp),
      rawEventType: 'referral',
    };
  }

  // Reaction
  if (messaging.reaction) {
    return {
      type: 'status',
      sender,
      dedupeKey: `meta:${channel}:${entry.id}:reaction:${messaging.reaction.mid}:${messaging.reaction.action}`,
      timestamp: new Date(messaging.timestamp),
      rawEventType: 'reaction',
    };
  }

  return null;
}
