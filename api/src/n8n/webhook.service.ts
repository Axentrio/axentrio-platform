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
import { routeOutboundMessage, sendChannelTypingIndicator } from '../channels/outbound-router';
import { applyOutputGuardrails } from '../guardrails/output-guardrails.service';
import {
  ResponsePayload,
  WebhookResponse,
  QuickReply,
  HandoffPayload,
  FileRequestPayload,
} from './types';

/** Replacement text sent when an n8n-generated reply is blocked in enforce mode. */
const OUTPUT_BLOCK_FALLBACK = "We're connecting you to an agent. Please hold on.";

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

      // Reject bot messages on a guardrail-paused conversation (spam/scam/bot-loop) —
      // covers the in-flight race where a concurrent block disabled the session
      // after the message was forwarded to n8n. Resume via /handoff/resume-ai.
      if (session.aiAutoReplyEnabled === false) {
        logger.warn(`Bot message rejected — session ${sessionId} is guardrail-paused`);
        return {
          success: false,
          error: 'Session is guardrail-paused — bot messages not accepted',
        };
      }

      // Apply delay if specified
      const actualDelay = Math.min(delay, this.config.maxDelay || 30000);
      if (actualDelay > 0) {
        logger.debug(`Delaying message by ${actualDelay}ms for session ${sessionId}`);
        await this.sleep(actualDelay);
        // A guardrail block could have landed DURING the delay — re-read the
        // current flag (not the stale session) right before persisting/sending.
        const live = await this.sessionRepo.findOne({
          where: { id: sessionId }, select: { id: true, aiAutoReplyEnabled: true } as never,
        });
        if (live && live.aiAutoReplyEnabled === false) {
          logger.warn(`Bot message rejected post-delay — session ${sessionId} is guardrail-paused`);
          return { success: false, error: 'Session is guardrail-paused — bot messages not accepted' };
        }
      }

      // Output guardrails (AC14): validate n8n-generated text BEFORE it is
      // persisted/sent. The custom-webhook prompt path omits the platform safety
      // preamble, so this is the primary output safety net for those tenants. In
      // enforce mode a blocked reply is REPLACED by a clean plain-text fallback
      // (no spread — drop any original quick replies / buttons / attachments /
      // metadata so unsafe actions can't ride along) and the session is handed to
      // a human after delivery; in shadow mode it is only logged.
      let outputBlocked = false;
      if (
        (payload.type === 'text' || payload.type === 'quick_reply') &&
        typeof payload.content === 'string'
      ) {
        const guard = await applyOutputGuardrails({
          tenantId: session.tenantId, session, channel: session.channel,
          content: payload.content,
          fallbackMessage: OUTPUT_BLOCK_FALLBACK,
          generationPath: 'n8n',
        });
        if (guard.blocked) {
          payload = { type: 'text', content: guard.content };
          outputBlocked = true;
        }
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
      const deliveryResult = await routeOutboundMessage(
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

      if (!deliveryResult.success) {
        // Message was persisted internally but the channel transport did NOT
        // deliver it (e.g. no conversation binding, inactive connection, Graph
        // send error). Surface it loudly — previously this was swallowed and
        // n8n was told the send succeeded, leaving replies stuck in `sending`.
        logger.error(`Channel delivery failed for session ${sessionId} — reply not delivered`, {
          messageId,
          channel: session.channel,
          channelConnectionId: session.channelConnectionId,
          error: deliveryResult.error,
        });
      } else {
        logger.info(`Message sent to session ${sessionId}`, { messageId, type: payload.type });
      }

      // Enforced output block: hand the session to a human so the custom webhook
      // can't keep producing blocked replies (matches coalescer/legacy/RAG).
      if (outputBlocked) {
        await this.triggerHandoff(sessionId, { reason: 'bot_error' });
      }

      return {
        success: true,
        messageId,
        channelDelivered: deliveryResult.success,
        channelError: deliveryResult.success ? undefined : deliveryResult.error,
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

      // Output guardrails (AC14): an n8n edit replaces customer-visible text, so
      // validate it too. In enforce mode a blocked edit applies the fallback text
      // instead (keep metadata.messageId so the right row is edited); shadow logs.
      if (typeof payload.content === 'string') {
        const session = await this.sessionRepo.findOne({ where: { id: sessionId } });
        if (session) {
          const guard = await applyOutputGuardrails({
            tenantId: session.tenantId, session, channel: session.channel,
            content: payload.content, fallbackMessage: OUTPUT_BLOCK_FALLBACK, generationPath: 'n8n',
          });
          if (guard.blocked) payload = { ...payload, content: guard.content };
        }
      }

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

      // Also surface the typing bubble to the end user on their external
      // channel (best-effort; no-op for widget / unsupported channels).
      if (isTyping) {
        void sendChannelTypingIndicator(sessionId).catch(() => {});
      }

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
