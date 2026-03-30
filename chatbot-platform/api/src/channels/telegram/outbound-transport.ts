import axios from 'axios';
import { ChannelConnection } from '../../database/entities/ChannelConnection';
import {
  OutboundTransport,
  OutboundChannelMessage,
  DeliveryResult,
  ChannelCapabilities,
} from '../types';

const TELEGRAM_API_BASE = 'https://api.telegram.org';
const CALLBACK_DATA_MAX_LENGTH = 64;

export class TelegramOutboundTransport implements OutboundTransport {
  getCapabilities(): ChannelCapabilities {
    return {
      maxTextLength: 4096,
      supportsQuickReplies: true,
      maxQuickReplies: 100,
      supportsButtons: true,
      maxButtons: 100,
      supportsCarousel: false,
      maxCarouselCards: 0,
      supportsImages: true,
      supportsVideo: true,
      supportsAudio: true,
      supportsFiles: true,
      supportsTypingIndicator: true,
      supportsReadReceipts: false,
      supportsMessageEdit: false,
      supportsMessageDelete: false,
      supportsStickers: true,
      hasMessagingWindow: false,
      requiresTemplatesOutsideWindow: false,
    };
  }

  async send(
    message: OutboundChannelMessage,
    externalThreadId: string,
    connection: ChannelConnection,
  ): Promise<DeliveryResult> {
    try {
      switch (message.type) {
        case 'text':
        case 'quick_reply':
          return this.sendTextMessage(message, externalThreadId, connection);
        case 'image':
          return this.sendPhoto(message, externalThreadId, connection);
        case 'video':
          return this.sendVideo(message, externalThreadId, connection);
        case 'audio':
          return this.sendAudio(message, externalThreadId, connection);
        case 'file':
          return this.sendDocument(message, externalThreadId, connection);
        case 'typing':
          await this.sendTypingIndicator(externalThreadId, connection);
          return { success: true };
        default:
          // Fallback: send as text
          return this.sendTextMessage(message, externalThreadId, connection);
      }
    } catch (error: unknown) {
      const axiosErr = error as { response?: { status?: number; data?: unknown }; message?: string };
      const retryable = axiosErr.response?.status
        ? axiosErr.response.status >= 500 || axiosErr.response.status === 429
        : true;
      return {
        success: false,
        error: axiosErr.message || 'Unknown error sending Telegram message',
        retryable,
      };
    }
  }

  async sendTypingIndicator(externalThreadId: string, connection: ChannelConnection): Promise<void> {
    const token = this.getBotToken(connection);
    await axios.post(`${TELEGRAM_API_BASE}/bot${token}/sendChatAction`, {
      chat_id: externalThreadId,
      action: 'typing',
    });
  }

  private async sendTextMessage(
    message: OutboundChannelMessage,
    externalThreadId: string,
    connection: ChannelConnection,
  ): Promise<DeliveryResult> {
    const token = this.getBotToken(connection);
    const payload: Record<string, unknown> = {
      chat_id: externalThreadId,
      text: message.content || '',
      parse_mode: 'HTML',
    };

    const replyMarkup = this.buildReplyMarkup(message);
    if (replyMarkup) {
      payload.reply_markup = replyMarkup;
    }

    const response = await axios.post(`${TELEGRAM_API_BASE}/bot${token}/sendMessage`, payload);
    return {
      success: true,
      platformMessageId: String(response.data.result?.message_id),
    };
  }

  private async sendPhoto(
    message: OutboundChannelMessage,
    externalThreadId: string,
    connection: ChannelConnection,
  ): Promise<DeliveryResult> {
    const token = this.getBotToken(connection);
    const payload: Record<string, unknown> = {
      chat_id: externalThreadId,
      photo: message.mediaUrl || message.content || '',
      caption: message.content && message.mediaUrl ? message.content : undefined,
      parse_mode: 'HTML',
    };

    const replyMarkup = this.buildReplyMarkup(message);
    if (replyMarkup) {
      payload.reply_markup = replyMarkup;
    }

    const response = await axios.post(`${TELEGRAM_API_BASE}/bot${token}/sendPhoto`, payload);
    return {
      success: true,
      platformMessageId: String(response.data.result?.message_id),
    };
  }

  private async sendVideo(
    message: OutboundChannelMessage,
    externalThreadId: string,
    connection: ChannelConnection,
  ): Promise<DeliveryResult> {
    const token = this.getBotToken(connection);
    const payload: Record<string, unknown> = {
      chat_id: externalThreadId,
      video: message.mediaUrl || message.content || '',
      caption: message.content && message.mediaUrl ? message.content : undefined,
      parse_mode: 'HTML',
    };

    const response = await axios.post(`${TELEGRAM_API_BASE}/bot${token}/sendVideo`, payload);
    return {
      success: true,
      platformMessageId: String(response.data.result?.message_id),
    };
  }

  private async sendAudio(
    message: OutboundChannelMessage,
    externalThreadId: string,
    connection: ChannelConnection,
  ): Promise<DeliveryResult> {
    const token = this.getBotToken(connection);
    const payload: Record<string, unknown> = {
      chat_id: externalThreadId,
      audio: message.mediaUrl || message.content || '',
      caption: message.content && message.mediaUrl ? message.content : undefined,
      parse_mode: 'HTML',
    };

    const response = await axios.post(`${TELEGRAM_API_BASE}/bot${token}/sendAudio`, payload);
    return {
      success: true,
      platformMessageId: String(response.data.result?.message_id),
    };
  }

  private async sendDocument(
    message: OutboundChannelMessage,
    externalThreadId: string,
    connection: ChannelConnection,
  ): Promise<DeliveryResult> {
    const token = this.getBotToken(connection);
    const payload: Record<string, unknown> = {
      chat_id: externalThreadId,
      document: message.mediaUrl || message.content || '',
      caption: message.content && message.mediaUrl ? message.content : undefined,
      parse_mode: 'HTML',
    };

    const response = await axios.post(`${TELEGRAM_API_BASE}/bot${token}/sendDocument`, payload);
    return {
      success: true,
      platformMessageId: String(response.data.result?.message_id),
    };
  }

  private buildReplyMarkup(
    message: OutboundChannelMessage,
  ): Record<string, unknown> | null {
    const rows: Array<Array<Record<string, unknown>>> = [];

    // Quick replies: 2 buttons per row as inline keyboard
    if (message.quickReplies && message.quickReplies.length > 0) {
      for (let i = 0; i < message.quickReplies.length; i += 2) {
        const row: Array<Record<string, unknown>> = [];
        row.push({
          text: message.quickReplies[i].title,
          callback_data: message.quickReplies[i].payload.slice(0, CALLBACK_DATA_MAX_LENGTH),
        });
        if (i + 1 < message.quickReplies.length) {
          row.push({
            text: message.quickReplies[i + 1].title,
            callback_data: message.quickReplies[i + 1].payload.slice(0, CALLBACK_DATA_MAX_LENGTH),
          });
        }
        rows.push(row);
      }
    }

    // Buttons: each on its own row
    if (message.buttons && message.buttons.length > 0) {
      for (const btn of message.buttons) {
        if (btn.type === 'url') {
          rows.push([{ text: btn.title, url: btn.value }]);
        } else {
          rows.push([{
            text: btn.title,
            callback_data: btn.value.slice(0, CALLBACK_DATA_MAX_LENGTH),
          }]);
        }
      }
    }

    if (rows.length === 0) {
      return null;
    }

    return { inline_keyboard: rows };
  }

  private getBotToken(connection: ChannelConnection): string {
    const token = connection.credentials?.botToken as string | undefined;
    if (!token) {
      throw new Error('Telegram bot token not found in connection credentials');
    }
    return token;
  }
}
