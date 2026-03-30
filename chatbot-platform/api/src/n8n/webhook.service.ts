/**
 * Webhook Service
 * Processes n8n responses and manages chat session interactions
 * Uses TypeORM repositories directly (no stub services)
 */

import { Repository } from 'typeorm';
import { logger } from '../utils/logger';
import { AppDataSource } from '../database/data-source';
import { ChatSession } from '../database/entities/ChatSession';
import { Message } from '../database/entities/Message';
import { HandoffRequest } from '../database/entities/HandoffRequest';
import { Participant } from '../database/entities/Participant';
import { emitToTenantAgents } from '../websocket/socket.handler';
import { EventEmitter } from '../utils/event-emitter';
import { routeOutboundMessage } from '../channels/outbound-router';
import {
  ResponsePayload,
  WebhookResponse,
  QuickReply,
  HandoffPayload,
  FileRequestPayload,
} from './types';

export interface WebhookServiceConfig {
  eventEmitter: EventEmitter;
  defaultDelay?: number;
  maxDelay?: number;
}

export class WebhookService {
  private config: WebhookServiceConfig;
  private sessionRepo: Repository<ChatSession>;
  private messageRepo: Repository<Message>;
  private handoffRepo: Repository<HandoffRequest>;

  constructor(config: WebhookServiceConfig) {
    this.config = config;
    this.sessionRepo = AppDataSource.getRepository(ChatSession);
    this.messageRepo = AppDataSource.getRepository(Message);
    this.handoffRepo = AppDataSource.getRepository(HandoffRequest);
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

      const session = await this.sessionRepo.findOne({ where: { id: sessionId } });
      if (!session) {
        logger.warn(`Session not found: ${sessionId}`);
        return {
          success: false,
          error: `Session not found: ${sessionId}`,
        };
      }

      // Reject bot messages for sessions that are in handoff or closed status
      if (session.status === 'handoff' || session.status === 'closed') {
        logger.warn(`Bot message rejected — session ${sessionId} is in ${session.status} status`);
        return {
          success: false,
          error: `Session is in ${session.status} status — bot messages not accepted`,
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
          messageId = await this.sendTextMessage(sessionId, session.tenantId, payload);
          break;

        case 'quick_reply':
          messageId = await this.sendQuickReplyMessage(sessionId, session.tenantId, payload);
          break;

        case 'image':
        case 'video':
        case 'audio':
        case 'file':
          messageId = await this.sendMediaMessage(sessionId, session.tenantId, payload, payload.type);
          break;

        case 'carousel':
          messageId = await this.sendCarouselMessage(sessionId, session.tenantId, payload);
          break;

        case 'template':
          messageId = await this.sendTemplateMessage(sessionId, session.tenantId, payload);
          break;

        default:
          messageId = await this.sendTextMessage(sessionId, session.tenantId, payload);
      }

      // Emit event for real-time delivery
      this.config.eventEmitter.emit('message:sent', {
        sessionId,
        messageId,
        payload,
        timestamp: new Date().toISOString(),
      });

      // Route through outbound router — handles WebSocket + external channels
      await routeOutboundMessage(
        payload,
        { sessionId, tenantId: session.tenantId, messageId },
        {
          event: 'message:receive',
          data: {
            id: messageId,
            type: payload.type || 'text',
            content: payload.content,
            senderType: 'bot',
            timestamp: new Date().toISOString(),
          },
        },
      );

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

      await this.messageRepo.update(messageId, {
        content: payload.content as string,
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

      await this.messageRepo.update(messageId, { isDeleted: true, deletedAt: new Date() });

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
      const session = await this.sessionRepo.findOne({ where: { id: sessionId } });
      if (!session) {
        return {
          success: false,
          error: `Session not found: ${sessionId}`,
        };
      }

      // Update session status to handoff
      session.requestHandoff();
      await this.sessionRepo.save(session);

      // Find or create a bot participant to use as requestedBy
      const participantRepo = AppDataSource.getRepository(Participant);
      let botParticipant = await participantRepo.findOne({
        where: { sessionId, type: 'bot', isDeleted: false },
      });
      if (!botParticipant) {
        botParticipant = participantRepo.create({
          sessionId,
          type: 'bot',
          name: 'AI Assistant',
          isAnonymous: false,
          joinedAt: new Date(),
        });
        botParticipant = await participantRepo.save(botParticipant);
      }

      // Create handoff request record
      const handoff = this.handoffRepo.create({
        sessionId,
        tenantId: session.tenantId,
        requestedBy: botParticipant.id,
        requestedAt: new Date(),
        reason: (payload?.reason || 'escalation_trigger') as HandoffRequest['reason'],
        priority: (payload?.priority || 'medium') as HandoffRequest['priority'],
        notes: payload?.summary,
      } as Partial<HandoffRequest>);
      const savedHandoff = await this.handoffRepo.save(handoff);

      // Notify agents
      emitToTenantAgents(session.tenantId, 'handoff:requested', {
        sessionId,
        handoffId: savedHandoff.id,
        reason: payload?.reason || 'Bot escalation',
        requestedAt: new Date().toISOString(),
      });

      this.config.eventEmitter.emit('handoff:triggered', {
        sessionId,
        handoffId: savedHandoff.id,
        reason: payload?.reason,
      });

      logger.info(`Handoff triggered for session ${sessionId}`, { handoffId: savedHandoff.id });

      return {
        success: true,
        messageId: savedHandoff.id,
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
   * Release human handoff for a session (return to bot)
   */
  public async releaseHandoff(sessionId: string): Promise<WebhookResponse> {
    try {
      await this.sessionRepo.update(sessionId, { status: 'bot' as ChatSession['status'], assignedAgentId: undefined });

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
   * Clear session context (no-op for now — context is in n8n)
   */
  public async clearSession(sessionId: string): Promise<WebhookResponse> {
    try {
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
   * Transfer session to another agent/queue
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

      // target can be an agentId
      await this.sessionRepo.update(sessionId, {
        assignedAgentId: payload.target as string,
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
   * Update user context (stored in session metadata)
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

      const session = await this.sessionRepo.findOne({ where: { id: sessionId } });
      if (!session) {
        return {
          success: false,
          error: `Session not found: ${sessionId}`,
        };
      }

      // Store user context in session metadata
      session.metadata = {
        ...session.metadata,
        customData: {
          ...(session.metadata?.customData || {}),
          ...payload,
        },
      };
      await this.sessionRepo.save(session);

      this.config.eventEmitter.emit('user:updated', {
        sessionId,
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

  private async getOrCreateBotParticipant(sessionId: string): Promise<string> {
    const participantRepo = AppDataSource.getRepository(Participant);
    let botParticipant = await participantRepo.findOne({
      where: { sessionId, type: 'bot' },
    });
    if (!botParticipant) {
      botParticipant = participantRepo.create({
        sessionId,
        type: 'bot',
        name: 'Bot',
        isAnonymous: false,
        joinedAt: new Date(),
      });
      await participantRepo.save(botParticipant);
    }
    return botParticipant.id;
  }

  private async saveMessage(
    sessionId: string,
    tenantId: string,
    type: string,
    content: string,
    metadata?: Record<string, unknown>
  ): Promise<string> {
    const participantId = await this.getOrCreateBotParticipant(sessionId);
    const message = this.messageRepo.create({
      sessionId,
      tenantId,
      participantId,
      type,
      content,
      metadata: metadata || undefined,
    } as Partial<Message>);
    const saved = await this.messageRepo.save(message) as unknown as Message;
    return saved.id;
  }

  private async sendTextMessage(sessionId: string, tenantId: string, payload: ResponsePayload): Promise<string> {
    const content = typeof payload.content === 'string'
      ? payload.content
      : JSON.stringify(payload.content);

    return this.saveMessage(sessionId, tenantId, 'text', content, payload.metadata);
  }

  private async sendQuickReplyMessage(sessionId: string, tenantId: string, payload: ResponsePayload): Promise<string> {
    const content = typeof payload.content === 'string'
      ? payload.content
      : 'Please select an option:';

    return this.saveMessage(sessionId, tenantId, 'text', content, {
      ...payload.metadata,
      quickReplies: this.normalizeQuickReplies(payload.quickReplies),
    });
  }

  private async sendMediaMessage(
    sessionId: string,
    tenantId: string,
    payload: ResponsePayload,
    mediaType: string
  ): Promise<string> {
    return this.saveMessage(sessionId, tenantId, mediaType, payload.content as string || '', {
      ...payload.metadata,
      attachments: payload.attachments,
    });
  }

  private async sendCarouselMessage(sessionId: string, tenantId: string, payload: ResponsePayload): Promise<string> {
    return this.saveMessage(sessionId, tenantId, 'text', '', {
      ...payload.metadata,
      cards: payload.content,
    });
  }

  private async sendTemplateMessage(sessionId: string, tenantId: string, payload: ResponsePayload): Promise<string> {
    return this.saveMessage(sessionId, tenantId, 'text', '', {
      ...payload.metadata,
      template: payload.content,
    });
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
          action: 'send' as const,
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
