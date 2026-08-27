import { ChannelConnection } from '../../database/entities/ChannelConnection';
import { EventNormalizer, NormalizedEvent } from '../types';

// --- Telegram API Types ---

interface TelegramUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  last_name?: string;
  username?: string;
  language_code?: string;
}

interface TelegramChat {
  id: number;
  type: 'private' | 'group' | 'supergroup' | 'channel';
  title?: string;
  username?: string;
  first_name?: string;
  last_name?: string;
}

interface TelegramPhotoSize {
  file_id: string;
  file_unique_id: string;
  width: number;
  height: number;
  file_size?: number;
}

interface TelegramVideo {
  file_id: string;
  file_unique_id: string;
  width: number;
  height: number;
  duration: number;
  mime_type?: string;
  file_size?: number;
}

interface TelegramAudio {
  file_id: string;
  file_unique_id: string;
  duration: number;
  performer?: string;
  title?: string;
  mime_type?: string;
  file_size?: number;
}

interface TelegramDocument {
  file_id: string;
  file_unique_id: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

interface TelegramVoice {
  file_id: string;
  file_unique_id: string;
  duration: number;
  mime_type?: string;
  file_size?: number;
}

interface TelegramSticker {
  file_id: string;
  file_unique_id: string;
  width: number;
  height: number;
  is_animated: boolean;
  is_video: boolean;
  emoji?: string;
  set_name?: string;
}

interface TelegramLocation {
  longitude: number;
  latitude: number;
}

interface TelegramContact {
  phone_number: string;
  first_name: string;
  last_name?: string;
  user_id?: number;
}

interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  chat: TelegramChat;
  date: number;
  text?: string;
  photo?: TelegramPhotoSize[];
  video?: TelegramVideo;
  audio?: TelegramAudio;
  voice?: TelegramVoice;
  document?: TelegramDocument;
  sticker?: TelegramSticker;
  location?: TelegramLocation;
  contact?: TelegramContact;
  caption?: string;
  reply_to_message?: TelegramMessage;
}

interface TelegramCallbackQuery {
  id: string;
  from: TelegramUser;
  message?: TelegramMessage;
  data?: string;
}

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

// --- Normalizer ---

export class TelegramEventNormalizer implements EventNormalizer {
  normalize(rawPayload: unknown, _connection: ChannelConnection): NormalizedEvent[] {
    const update = rawPayload as TelegramUpdate;
    const events: NormalizedEvent[] = [];

    if (update.message) {
      const event = this.normalizeMessage(update.message, update.update_id);
      if (event) {
        events.push(event);
      }
    }

    if (update.callback_query) {
      const event = this.normalizeCallbackQuery(update.callback_query);
      if (event) {
        events.push(event);
      }
    }

    return events;
  }

  private normalizeMessage(msg: TelegramMessage, updateId: number): NormalizedEvent | null {
    // Skip bot's own messages
    if (msg.from?.is_bot === true) {
      return null;
    }

    const sender = this.buildSender(msg.from, msg.chat);
    const timestamp = new Date(msg.date * 1000);
    const dedupeKey = `telegram:${updateId}`;
    const replyToExternalId = msg.reply_to_message
      ? String(msg.reply_to_message.message_id)
      : undefined;

    const { message, rawEventType } = telegramMessagePayload(msg, replyToExternalId);

    return {
      type: 'message',
      message,
      sender,
      dedupeKey,
      timestamp,
      rawEventType,
    };
  }

  private normalizeCallbackQuery(cbq: TelegramCallbackQuery): NormalizedEvent | null {
    // Skip bot callbacks
    if (cbq.from.is_bot === true) {
      return null;
    }

    const chat = cbq.message?.chat;
    const sender = this.buildSender(cbq.from, chat);

    return {
      type: 'postback',
      postback: {
        payload: cbq.data || '',
        title: cbq.data || '',
      },
      sender,
      dedupeKey: `telegram:cb:${cbq.id}`,
      timestamp: cbq.message ? new Date(cbq.message.date * 1000) : new Date(),
      rawEventType: 'callback_query',
    };
  }

  private buildSender(
    from: TelegramUser | undefined,
    chat: TelegramChat | undefined,
  ): NormalizedEvent['sender'] {
    const displayParts: string[] = [];
    if (from?.first_name) displayParts.push(from.first_name);
    if (from?.last_name) displayParts.push(from.last_name);

    return {
      externalUserId: String(from?.id || 0),
      externalThreadId: String(chat?.id || from?.id || 0),
      displayName: displayParts.length > 0 ? displayParts.join(' ') : undefined,
      platformData: {
        username: from?.username,
        language_code: from?.language_code,
        chat_type: chat?.type,
      },
    };
  }
}

type TelegramMessagePayload = {
  message: NonNullable<NormalizedEvent['message']>;
  rawEventType: string;
};

/**
 * Determine message type and content. An unknown Telegram message type becomes
 * text with empty content, so the pipeline still sees a message.
 */
function telegramMessagePayload(
  msg: TelegramMessage,
  replyToExternalId: string | undefined,
): TelegramMessagePayload {
  if (msg.text) {
    return {
      message: { type: 'text', content: msg.text, replyToExternalId },
      rawEventType: 'message.text',
    };
  }

  const media = telegramMediaPayload(msg, replyToExternalId);
  if (media) return media;

  if (msg.sticker) {
    return {
      message: {
        type: 'sticker',
        content: msg.sticker.emoji || '',
        mediaMetadata: {
          fileId: msg.sticker.file_id,
          fileUniqueId: msg.sticker.file_unique_id,
          setName: msg.sticker.set_name,
          isAnimated: msg.sticker.is_animated,
          isVideo: msg.sticker.is_video,
        },
        replyToExternalId,
      },
      rawEventType: 'message.sticker',
    };
  }

  if (msg.location) {
    return {
      message: {
        type: 'location',
        content: `${msg.location.latitude},${msg.location.longitude}`,
        mediaMetadata: {
          latitude: msg.location.latitude,
          longitude: msg.location.longitude,
        },
        replyToExternalId,
      },
      rawEventType: 'message.location',
    };
  }

  if (msg.contact) {
    return {
      message: {
        type: 'contact',
        content: `${msg.contact.first_name} ${msg.contact.last_name || ''}`.trim(),
        mediaMetadata: {
          phoneNumber: msg.contact.phone_number,
          firstName: msg.contact.first_name,
          lastName: msg.contact.last_name,
          userId: msg.contact.user_id,
        },
        replyToExternalId,
      },
      rawEventType: 'message.contact',
    };
  }

  // Unknown message type - return as text with empty content
  return {
    message: { type: 'text', content: '', replyToExternalId },
    rawEventType: 'message.unknown',
  };
}

/** Photo / video / audio / voice / document payload, or null when the message carries none. */
function telegramMediaPayload(
  msg: TelegramMessage,
  replyToExternalId: string | undefined,
): TelegramMessagePayload | null {
  if (msg.photo && msg.photo.length > 0) {
    // Use the largest photo (last in array)
    const largest = msg.photo[msg.photo.length - 1];
    return {
      message: {
        type: 'image',
        content: msg.caption || '',
        mediaMetadata: {
          fileId: largest.file_id,
          fileUniqueId: largest.file_unique_id,
          width: largest.width,
          height: largest.height,
        },
        replyToExternalId,
      },
      rawEventType: 'message.photo',
    };
  }

  if (msg.video) {
    return {
      message: {
        type: 'video',
        content: msg.caption || '',
        mediaMetadata: {
          fileId: msg.video.file_id,
          fileUniqueId: msg.video.file_unique_id,
          duration: msg.video.duration,
          mimeType: msg.video.mime_type,
        },
        replyToExternalId,
      },
      rawEventType: 'message.video',
    };
  }

  if (msg.audio) {
    return {
      message: {
        type: 'audio',
        content: msg.caption || msg.audio.title || '',
        mediaMetadata: {
          fileId: msg.audio.file_id,
          fileUniqueId: msg.audio.file_unique_id,
          duration: msg.audio.duration,
          performer: msg.audio.performer,
          title: msg.audio.title,
          mimeType: msg.audio.mime_type,
        },
        replyToExternalId,
      },
      rawEventType: 'message.audio',
    };
  }

  if (msg.voice) {
    return {
      message: {
        type: 'audio',
        content: msg.caption || '',
        mediaMetadata: {
          fileId: msg.voice.file_id,
          fileUniqueId: msg.voice.file_unique_id,
          duration: msg.voice.duration,
          mimeType: msg.voice.mime_type,
        },
        replyToExternalId,
      },
      rawEventType: 'message.voice',
    };
  }

  if (msg.document) {
    return {
      message: {
        type: 'file',
        content: msg.caption || msg.document.file_name || '',
        mediaMetadata: {
          fileId: msg.document.file_id,
          fileUniqueId: msg.document.file_unique_id,
          fileName: msg.document.file_name,
          mimeType: msg.document.mime_type,
        },
        replyToExternalId,
      },
      rawEventType: 'message.document',
    };
  }

  return null;
}
