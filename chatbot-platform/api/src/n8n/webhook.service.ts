/**
 * Webhook Service
 * Processes n8n responses and manages chat session interactions
 */

import { logger } from '../utils/logger';
import { emitToSession } from '../websocket/socket.handler';
import { ChatSessionService } from '../services/chat-session.service';
import { MessageService } from '../services/message.service';
import { HandoffService } from '../services/handoff.service';
import { UserService } from '../services/user.service';
import { EventEmitter } from '../utils/event-emitter';
import {
  ResponsePayload,
  WebhookResponse,
  QuickReply,
  HandoffPayload,
  FileRequestPayload,
} from './types';

export interface WebhookServiceConfig {
  chatSessionService: ChatSessionService;
  messageService: MessageService;
  handoffService: HandoffService;
  userService: UserService;
  eventEmitter: EventEmitter;
  defaultDelay?: number;
  maxDelay?: number;
}

export class WebhookService {
  private config: WebhookServiceConfig;

  constructor(config: WebhookServiceConfig) {
    this.config = config;
    logger.info('WebhookService initialized');
  }

  /**
   * Send a message to a chat session
   */
  public async sendMessageToSession(
    sessionId: string,
    payload: ResponsePayload | undefined,
    delay: number = 0
  ): Promise<WebhookResponse> {
    try {
      if (!payload) {
        return {
          success: false,
          error: 'Payload is required for message.send action',
        };
      }

      // Validate session exists
      const session = await this.config.chatSessionService.getSession(sessionId);
      if (!session) {
        logger.warn(`Session not found: ${sessionId}`);
        return {
          success: false,
          error: `Session not found: ${sessionId}`,
        };
      }

      // Apply delay if specified
      const actualDelay = Math.min(delay, this.config.maxDelay || 30000);
      if (actualDelay > 0) {
        logger.debug(`Delaying message by ${actualDelay}ms for session ${sessionId}`);
        await this.sleep(actualDelay);
      }

      // Process different message types
      let messageId: string;

      switch (payload.type) {
        case 'text':
          messageId = await this.sendTextMessage(sessionId, payload);
          break;

        case 'quick_reply':
          messageId = await this.sendQuickReplyMessage(sessionId, payload);
          break;

        case 'image':
          messageId = await this.sendMediaMessage(sessionId, payload, 'image');
          break;

        case 'video':
          messageId = await this.sendMediaMessage(sessionId, payload, 'video');
          break;

        case 'audio':
          messageId = await this.sendMediaMessage(sessionId, payload, 'audio');
          break;

        case 'file':
          messageId = await this.sendMediaMessage(sessionId, payload, 'file');
          break;

        case 'carousel':
          messageId = await this.sendCarouselMessage(sessionId, payload);
          break;

        case 'template':
          messageId = await this.sendTemplateMessage(sessionId, payload);
          break;

        default:
          // Default to text message
          messageId = await this.sendTextMessage(sessionId, payload);
      }

      // Emit event for real-time delivery
      this.config.eventEmitter.emit('message:sent', {
        sessionId,
        messageId,
        payload,
        timestamp: new Date().toISOString(),
      });

      // Emit via WebSocket to the session room
      const tenantId = session.tenantId;
      if (tenantId) {
        emitToSession(tenantId, sessionId, 'message:receive', {
          id: messageId,
          type: payload.type || 'text',
          content: payload.content,
          senderType: 'bot',
          timestamp: new Date().toISOString(),
        });
      }

      logger.info(`Message sent to session ${sessionId}`, { messageId, type: payload.type });

      return {
        success: true,
        messageId,
      };

    } catch (error) {
      logger.error(`Failed to send message to session ${sessionId}`, error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Edit an existing message
   */
  public async editMessage(
    sessionId: string,
    payload: ResponsePayload | undefined
  ): Promise<WebhookResponse> {
    try {
      if (!payload?.metadata?.messageId) {
        return {
          success: false,
          error: 'messageId is required in metadata to edit a message',
        };
      }

      const messageId = payload.metadata.messageId as string;
      
      await this.config.messageService.editMessage(messageId, {
        content: payload.content as string,
        updatedAt: new Date().toISOString(),
      });

      this.config.eventEmitter.emit('message:edited', {
        sessionId,
        messageId,
        newContent: payload.content,
      });

      return {
        success: true,
        messageId,
      };

    } catch (error) {
      logger.error(`Failed to edit message in session ${sessionId}`, error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Delete a message
   */
  public async deleteMessage(
    sessionId: string,
    payload: ResponsePayload | undefined
  ): Promise<WebhookResponse> {
    try {
      if (!payload?.metadata?.messageId) {
        return {
          success: false,
          error: 'messageId is required in metadata to delete a message',
        };
      }

      const messageId = payload.metadata.messageId as string;
      
      await this.config.messageService.deleteMessage(messageId);

      this.config.eventEmitter.emit('message:deleted', {
        sessionId,
        messageId,
      });

      return {
        success: true,
        messageId,
      };

    } catch (error) {
      logger.error(`Failed to delete message in session ${sessionId}`, error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Send typing indicator to session
   */
  public async sendTypingIndicator(
    sessionId: string,
    isTyping: boolean
  ): Promise<WebhookResponse> {
    try {
      this.config.eventEmitter.emit('typing:update', {
        sessionId,
        isTyping,
        timestamp: new Date().toISOString(),
      });

      return {
        success: true,
      };

    } catch (error) {
      logger.error(`Failed to send typing indicator for session ${sessionId}`, error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Trigger human handoff for a session
   */
  public async triggerHandoff(
    sessionId: string,
    payload: HandoffPayload | undefined
  ): Promise<WebhookResponse> {
    try {
      const session = await this.config.chatSessionService.getSession(sessionId);
      if (!session) {
        return {
          success: false,
          error: `Session not found: ${sessionId}`,
        };
      }

      const handoffResult = await this.config.handoffService.requestHandoff({
        sessionId,
        tenantId: session.tenantId,
        userId: session.userId,
        reason: payload?.reason || 'Bot escalation',
        queue: payload?.queue || 'default',
        priority: payload?.priority || 'normal',
        agentId: payload?.agentId,
        department: payload?.department,
        tags: payload?.tags,
        summary: payload?.summary,
      });

      this.config.eventEmitter.emit('handoff:triggered', {
        sessionId,
        handoffId: handoffResult.id,
        reason: payload?.reason,
      });

      logger.info(`Handoff triggered for session ${sessionId}`, { handoffId: handoffResult.id });

      return {
        success: true,
        messageId: handoffResult.id,
      };

    } catch (error) {
      logger.error(`Failed to trigger handoff for session ${sessionId}`, error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Release human handoff for a session
   */
  public async releaseHandoff(sessionId: string): Promise<WebhookResponse> {
    try {
      await this.config.handoffService.releaseHandoff(sessionId);

      this.config.eventEmitter.emit('handoff:released', {
        sessionId,
        timestamp: new Date().toISOString(),
      });

      logger.info(`Handoff released for session ${sessionId}`);

      return {
        success: true,
      };

    } catch (error) {
      logger.error(`Failed to release handoff for session ${sessionId}`, error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Request file upload from user
   */
  public async requestFileUpload(
    sessionId: string,
    payload: FileRequestPayload | undefined
  ): Promise<WebhookResponse> {
    try {
      if (!payload) {
        return {
          success: false,
          error: 'Payload is required for file.request action',
        };
      }

      this.config.eventEmitter.emit('file:requested', {
        sessionId,
        types: payload.types,
        maxSize: payload.maxSize || 10485760,
        maxFiles: payload.maxFiles || 1,
        accept: payload.accept,
        prompt: payload.prompt,
      });

      return {
        success: true,
      };

    } catch (error) {
      logger.error(`Failed to request file upload for session ${sessionId}`, error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Clear session context and history
   */
  public async clearSession(sessionId: string): Promise<WebhookResponse> {
    try {
      await this.config.chatSessionService.clearSessionContext(sessionId);

      this.config.eventEmitter.emit('session:cleared', {
        sessionId,
        timestamp: new Date().toISOString(),
      });

      logger.info(`Session cleared: ${sessionId}`);

      return {
        success: true,
      };

    } catch (error) {
      logger.error(`Failed to clear session ${sessionId}`, error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Transfer session to another queue/department
   */
  public async transferSession(
    sessionId: string,
    payload: Record<string, unknown> | undefined
  ): Promise<WebhookResponse> {
    try {
      if (!payload?.target) {
        return {
          success: false,
          error: 'target is required for session.transfer action',
        };
      }

      await this.config.chatSessionService.transferSession(sessionId, {
        target: payload.target as string,
        reason: payload.reason as string,
      });

      this.config.eventEmitter.emit('session:transferred', {
        sessionId,
        target: payload.target,
        reason: payload.reason,
      });

      logger.info(`Session ${sessionId} transferred to ${payload.target}`);

      return {
        success: true,
      };

    } catch (error) {
      logger.error(`Failed to transfer session ${sessionId}`, error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Update user context
   */
  public async updateUserContext(
    sessionId: string,
    payload: Record<string, unknown> | undefined
  ): Promise<WebhookResponse> {
    try {
      if (!payload) {
        return {
          success: false,
          error: 'Payload is required for user.update action',
        };
      }

      const session = await this.config.chatSessionService.getSession(sessionId);
      if (!session) {
        return {
          success: false,
          error: `Session not found: ${sessionId}`,
        };
      }

      await this.config.userService.updateUserContext(session.userId, payload);

      this.config.eventEmitter.emit('user:updated', {
        sessionId,
        userId: session.userId,
        updates: payload,
      });

      return {
        success: true,
      };

    } catch (error) {
      logger.error(`Failed to update user context for session ${sessionId}`, error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  // ============================================================================
  // Private Helper Methods
  // ============================================================================

  private async sendTextMessage(sessionId: string, payload: ResponsePayload): Promise<string> {
    const content = typeof payload.content === 'string' 
      ? payload.content 
      : JSON.stringify(payload.content);

    const message = await this.config.messageService.createMessage({
      sessionId,
      type: 'text',
      content,
      metadata: payload.metadata,
      quickReplies: this.normalizeQuickReplies(payload.quickReplies),
    });

    return message.id;
  }

  private async sendQuickReplyMessage(sessionId: string, payload: ResponsePayload): Promise<string> {
    const content = typeof payload.content === 'string' 
      ? payload.content 
      : 'Please select an option:';

    const message = await this.config.messageService.createMessage({
      sessionId,
      type: 'quick_reply',
      content,
      quickReplies: this.normalizeQuickReplies(payload.quickReplies),
      metadata: payload.metadata,
    });

    return message.id;
  }

  private async sendMediaMessage(
    sessionId: string, 
    payload: ResponsePayload, 
    mediaType: string
  ): Promise<string> {
    const attachments = payload.attachments || [];
    
    if (attachments.length === 0 && payload.content) {
      attachments.push({
        url: payload.content as string,
        type: mediaType,
      });
    }

    const message = await this.config.messageService.createMessage({
      sessionId,
      type: mediaType as any,
      content: payload.content as string || '',
      attachments,
      metadata: payload.metadata,
    });

    return message.id;
  }

  private async sendCarouselMessage(sessionId: string, payload: ResponsePayload): Promise<string> {
    const message = await this.config.messageService.createMessage({
      sessionId,
      type: 'carousel',
      content: '',
      cards: payload.content as any,
      metadata: payload.metadata,
    });

    return message.id;
  }

  private async sendTemplateMessage(sessionId: string, payload: ResponsePayload): Promise<string> {
    const message = await this.config.messageService.createMessage({
      sessionId,
      type: 'template',
      content: '',
      template: payload.content as any,
      metadata: payload.metadata,
    });

    return message.id;
  }

  private normalizeQuickReplies(quickReplies: (string | QuickReply)[] | undefined): QuickReply[] {
    if (!quickReplies || quickReplies.length === 0) {
      return [];
    }

    return quickReplies.map((qr, index) => {
      if (typeof qr === 'string') {
        return {
          id: `qr_${index}`,
          title: qr,
          value: qr,
          action: 'send',
        };
      }
      return {
        id: qr.id || `qr_${index}`,
        title: qr.title,
        value: qr.value || qr.title,
        action: qr.action || 'send',
        icon: qr.icon,
        style: qr.style,
        metadata: qr.metadata,
        disabled: qr.disabled || false,
        visible: qr.visible !== false,
      };
    });
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
