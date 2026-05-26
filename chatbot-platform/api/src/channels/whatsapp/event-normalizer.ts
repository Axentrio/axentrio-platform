import { NormalizedEvent, EventNormalizer } from '../types';
import { ChannelConnection } from '../../database/entities/ChannelConnection';

// --- WhatsApp Cloud API webhook types (object: "whatsapp_business_account") ---

interface WhatsAppWebhookPayload {
  object: 'whatsapp_business_account';
  entry: WhatsAppEntry[];
}

interface WhatsAppEntry {
  id: string; // WABA ID
  changes: WhatsAppChange[];
}

interface WhatsAppChange {
  field: string; // "messages"
  value: WhatsAppValue;
}

interface WhatsAppValue {
  messaging_product: 'whatsapp';
  metadata: { display_phone_number: string; phone_number_id: string };
  contacts?: Array<{ profile?: { name?: string }; wa_id: string }>;
  messages?: WhatsAppMessage[];
  statuses?: WhatsAppStatus[];
}

interface WhatsAppMessage {
  from: string; // sender wa_id
  id: string; // wamid...
  timestamp: string; // unix seconds, as string
  type: string;
  text?: { body: string };
  image?: WhatsAppMedia;
  video?: WhatsAppMedia;
  audio?: WhatsAppMedia;
  document?: WhatsAppMedia;
  sticker?: WhatsAppMedia;
  location?: { latitude: number; longitude: number; name?: string; address?: string };
  contacts?: unknown[];
  interactive?: {
    type: 'button_reply' | 'list_reply';
    button_reply?: { id: string; title: string };
    list_reply?: { id: string; title: string; description?: string };
  };
  button?: { text: string; payload: string };
  reaction?: { message_id: string; emoji?: string };
  context?: { id?: string };
}

interface WhatsAppMedia {
  id: string;
  mime_type?: string;
  sha256?: string;
  caption?: string;
  filename?: string;
}

interface WhatsAppStatus {
  id: string;
  status: 'sent' | 'delivered' | 'read' | 'failed';
  timestamp: string;
  recipient_id: string;
  errors?: Array<{ code: number; title?: string; message?: string }>;
}

type NormalizedWhatsAppResult = {
  event: NormalizedEvent;
  recipientId: string; // phone_number_id, used to resolve the connection
  channel: 'whatsapp';
};

/**
 * Normalize a WhatsApp Cloud API webhook payload into NormalizedEvent[].
 * Each event carries `recipientId` = the business phone_number_id so the
 * webhook route can resolve the owning ChannelConnection.
 */
export function normalizeWhatsAppPayload(payload: WhatsAppWebhookPayload): NormalizedWhatsAppResult[] {
  const results: NormalizedWhatsAppResult[] = [];

  for (const entry of payload.entry || []) {
    for (const change of entry.changes || []) {
      const value = change.value;
      if (!value?.metadata?.phone_number_id) continue;

      const phoneNumberId = value.metadata.phone_number_id;
      const nameByWaId = new Map<string, string | undefined>(
        (value.contacts || []).map((c) => [c.wa_id, c.profile?.name]),
      );

      for (const message of value.messages || []) {
        const event = normalizeMessage(message, phoneNumberId, nameByWaId.get(message.from));
        if (event) results.push({ event, recipientId: phoneNumberId, channel: 'whatsapp' });
      }

      for (const status of value.statuses || []) {
        const event = normalizeStatus(status, phoneNumberId);
        if (event) results.push({ event, recipientId: phoneNumberId, channel: 'whatsapp' });
      }
    }
  }

  return results;
}

/**
 * Adapter-interface normalizer. Filters the payload down to the events for the
 * resolved connection's phone number and returns plain NormalizedEvent[], as
 * the ChannelAdapter pipeline expects.
 */
export class WhatsAppEventNormalizer implements EventNormalizer {
  normalize(rawPayload: unknown, connection: ChannelConnection): NormalizedEvent[] {
    return normalizeWhatsAppPayload(rawPayload as WhatsAppWebhookPayload)
      .filter((r) => r.recipientId === connection.platformAccountId)
      .map((r) => r.event);
  }
}

function normalizeMessage(
  msg: WhatsAppMessage,
  phoneNumberId: string,
  displayName: string | undefined,
): NormalizedEvent | null {
  const sender = {
    externalUserId: msg.from,
    externalThreadId: msg.from, // 1:1 messaging — thread = sender wa_id
    displayName,
    platformData: { channel: 'whatsapp' as const },
  };
  const timestamp = new Date(Number(msg.timestamp) * 1000);
  const dedupeKey = `wa:${phoneNumberId}:${msg.id}`;

  // Interactive reply (button or list) → postback
  if (msg.type === 'interactive' && msg.interactive) {
    const reply = msg.interactive.button_reply || msg.interactive.list_reply;
    if (reply) {
      return {
        type: 'postback',
        postback: { payload: reply.id, title: reply.title },
        sender,
        dedupeKey,
        timestamp,
        rawEventType: `interactive.${msg.interactive.type}`,
      };
    }
  }

  // Template quick-reply button → postback
  if (msg.type === 'button' && msg.button) {
    return {
      type: 'postback',
      postback: { payload: msg.button.payload, title: msg.button.text },
      sender,
      dedupeKey,
      timestamp,
      rawEventType: 'button',
    };
  }

  // Reaction → status (no content side-effect)
  if (msg.type === 'reaction' && msg.reaction) {
    return {
      type: 'status',
      sender,
      dedupeKey: `${dedupeKey}:reaction`,
      timestamp,
      rawEventType: 'reaction',
    };
  }

  // Text
  if (msg.type === 'text' && msg.text) {
    return {
      type: 'message',
      message: { type: 'text', content: msg.text.body, replyToExternalId: msg.context?.id },
      sender,
      dedupeKey,
      timestamp,
      rawEventType: 'message.text',
    };
  }

  // Media. WhatsApp delivers a media id, not a URL — the id must be resolved
  // via GET /{media-id} before download, so we stash it in mediaMetadata.
  const mediaType = mapMediaType(msg.type);
  if (mediaType) {
    const media = (msg as unknown as Record<string, WhatsAppMedia | undefined>)[msg.type];
    return {
      type: 'message',
      message: {
        type: mediaType,
        content: media?.caption || '',
        mediaMetadata: {
          mediaId: media?.id,
          mimeType: media?.mime_type,
          filename: media?.filename,
        },
        replyToExternalId: msg.context?.id,
      },
      sender,
      dedupeKey,
      timestamp,
      rawEventType: `message.${msg.type}`,
    };
  }

  // Location
  if (msg.type === 'location' && msg.location) {
    return {
      type: 'message',
      message: {
        type: 'location',
        content: msg.location.name || msg.location.address || '',
        mediaMetadata: { latitude: msg.location.latitude, longitude: msg.location.longitude },
      },
      sender,
      dedupeKey,
      timestamp,
      rawEventType: 'message.location',
    };
  }

  // Contacts
  if (msg.type === 'contacts') {
    return {
      type: 'message',
      message: { type: 'contact', content: '' },
      sender,
      dedupeKey,
      timestamp,
      rawEventType: 'message.contacts',
    };
  }

  // Unsupported / unknown message type — skip
  return null;
}

function mapMediaType(
  type: string,
): 'image' | 'video' | 'audio' | 'file' | 'sticker' | null {
  switch (type) {
    case 'image':
      return 'image';
    case 'video':
      return 'video';
    case 'audio':
      return 'audio';
    case 'document':
      return 'file';
    case 'sticker':
      return 'sticker';
    default:
      return null;
  }
}

function normalizeStatus(status: WhatsAppStatus, phoneNumberId: string): NormalizedEvent | null {
  const sender = {
    externalUserId: status.recipient_id,
    externalThreadId: status.recipient_id,
    platformData: { channel: 'whatsapp' as const },
  };
  const timestamp = new Date(Number(status.timestamp) * 1000);
  const dedupeKey = `wa:${phoneNumberId}:status:${status.id}:${status.status}`;

  if (status.status === 'delivered' || status.status === 'read') {
    return {
      type: status.status === 'read' ? 'read' : 'delivery',
      receipt: { messageIds: [status.id], status: status.status },
      sender,
      dedupeKey,
      timestamp,
      rawEventType: `status.${status.status}`,
    };
  }

  // 'sent' and 'failed' are logged but not acted on by the inbound pipeline.
  return {
    type: 'status',
    sender,
    dedupeKey,
    timestamp,
    rawEventType: `status.${status.status}`,
  };
}
