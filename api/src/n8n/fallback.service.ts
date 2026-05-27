/**
 * Fallback Service
 * Provides fallback responses when n8n is unavailable
 * Handles circuit breaker open state and webhook failures
 */

import { logger } from '../utils/logger';
import { EventEmitter } from '../utils/event-emitter';
import {
  InboundMessage,
  OutboundMessage,
  WebhookResponse,
  ResponsePayload,
  QuickReply,
} from './types';

export interface FallbackServiceConfig {
  defaultMessage?: string;
  handoffOnFailure?: boolean;
  enableQuickReplies?: boolean;
  quickReplies?: string[];
  customFallbacks?: Record<string, () => WebhookResponse>;
  eventEmitter?: EventEmitter;
}

export interface FallbackContext {
  sessionId: string;
  tenantId?: string;
  userMessage?: string;
  failureReason?: string;
  attemptCount?: number;
  timestamp?: string;
}

export class FallbackService {
  private config: FallbackServiceConfig;
  private fallbackHistory: Map<string, FallbackContext[]>;

  constructor(config: FallbackServiceConfig = {}) {
    this.config = {
      defaultMessage: "I'm sorry, I'm having trouble connecting right now. Please try again in a moment.",
      handoffOnFailure: true,
      enableQuickReplies: true,
      quickReplies: ['Try again', 'Contact support'],
      ...config,
    };

    this.fallbackHistory = new Map();

    logger.info('FallbackService initialized', {
      handoffOnFailure: this.config.handoffOnFailure,
      enableQuickReplies: this.config.enableQuickReplies,
    });
  }

  /**
   * Get fallback response when circuit breaker is open
   */
  public handleCircuitOpen(inboundMessage: InboundMessage): WebhookResponse {
    const { sessionId, tenantId } = inboundMessage;

    logger.info(`Generating fallback for circuit open`, { sessionId });

    // Track fallback usage
    this.trackFallback(sessionId, {
      sessionId,
      tenantId,
      failureReason: 'circuit_open',
    });

    // Build appropriate fallback response
    const response = this.buildFallbackResponse({
      sessionId,
      tenantId,
      failureReason: 'circuit_open',
    });

    // Emit event for monitoring
    this.config.eventEmitter?.emit('fallback:circuit_open', {
      sessionId,
      timestamp: new Date().toISOString(),
    });

    return response;
  }

  /**
   * Get fallback response for webhook timeout
   */
  public handleTimeout(sessionId: string, tenantId?: string): WebhookResponse {
    logger.info(`Generating fallback for timeout`, { sessionId });

    this.trackFallback(sessionId, {
      sessionId,
      tenantId,
      failureReason: 'timeout',
    });

    const response = this.buildFallbackResponse({
      sessionId,
      tenantId,
      failureReason: 'timeout',
    });

    this.config.eventEmitter?.emit('fallback:timeout', {
      sessionId,
      timestamp: new Date().toISOString(),
    });

    return response;
  }

  /**
   * Get fallback response for webhook error
   */
  public handleError(
    sessionId: string, 
    error: string, 
    tenantId?: string,
    attemptCount?: number
  ): WebhookResponse {
    logger.info(`Generating fallback for error`, { sessionId, error, attemptCount });

    this.trackFallback(sessionId, {
      sessionId,
      tenantId,
      failureReason: 'error',
      attemptCount,
    });

    // If we've tried multiple times, suggest human handoff
    if (attemptCount && attemptCount >= 3) {
      return this.buildHandoffFallback({
        sessionId,
        tenantId,
        failureReason: error,
        attemptCount,
      });
    }

    const response = this.buildFallbackResponse({
      sessionId,
      tenantId,
      failureReason: 'error',
      attemptCount,
    });

    this.config.eventEmitter?.emit('fallback:error', {
      sessionId,
      error,
      timestamp: new Date().toISOString(),
    });

    return response;
  }

  /**
   * Get generic fallback response
   */
  public getFallbackResponse(outboundMessage: OutboundMessage): WebhookResponse {
    const { sessionId, tenantId } = outboundMessage;

    logger.info(`Generating generic fallback response`, { sessionId });

    return this.buildFallbackResponse({
      sessionId,
      tenantId,
    });
  }

  /**
   * Get fallback response for specific event type
   */
  public getEventFallback(event: string, sessionId: string, _tenantId?: string): WebhookResponse {
    // Check for custom fallback handler
    if (this.config.customFallbacks?.[event]) {
      return this.config.customFallbacks[event]();
    }

    // Default fallbacks by event type
    const eventFallbacks: Record<string, string> = {
      'message.received': "I'm processing your message. One moment please...",
      'session.started': "Welcome! I'm here to help. What can I do for you today?",
      'file.uploaded': "I've received your file. Processing it now...",
      'handsoff.requested': "Connecting you to a human agent...",
    };

    const message = eventFallbacks[event] || this.config.defaultMessage!;

    return {
      success: true,
      actions: [{
        action: 'message.send',
        sessionId,
        payload: {
          type: 'text',
          content: message,
          quickReplies: this.config.enableQuickReplies ? this.getQuickReplies('default') : undefined,
        },
      }],
    };
  }

  /**
   * Get fallback history for a session
   */
  public getFallbackHistory(sessionId: string): FallbackContext[] {
    return this.fallbackHistory.get(sessionId) || [];
  }

  /**
   * Clear fallback history for a session
   */
  public clearFallbackHistory(sessionId: string): void {
    this.fallbackHistory.delete(sessionId);
    logger.debug(`Cleared fallback history for session ${sessionId}`);
  }

  /**
   * Check if session has exceeded fallback threshold
   */
  public hasExceededFallbackThreshold(sessionId: string, threshold: number = 3): boolean {
    const history = this.fallbackHistory.get(sessionId) || [];
    return history.length >= threshold;
  }

  /**
   * Register custom fallback handler
   */
  public registerCustomFallback(event: string, handler: () => WebhookResponse): void {
    if (!this.config.customFallbacks) {
      this.config.customFallbacks = {};
    }
    this.config.customFallbacks[event] = handler;
    logger.info(`Registered custom fallback for event: ${event}`);
  }

  // ============================================================================
  // Private Methods
  // ============================================================================

  /**
   * Build a standard fallback response
   */
  private buildFallbackResponse(context: FallbackContext): WebhookResponse {
    const { sessionId, failureReason, attemptCount } = context;

    // Determine message based on context
    let message = this.config.defaultMessage!;

    if (failureReason === 'timeout') {
      message = "I'm taking longer than expected to respond. Please try again or contact support if the issue persists.";
    } else if (failureReason === 'circuit_open') {
      message = "I'm experiencing some technical difficulties. Let me connect you with someone who can help.";
    } else if (attemptCount && attemptCount > 1) {
      message = `I'm still having trouble (${attemptCount} attempts). Would you like to try again or speak with a human agent?`;
    }

    // Determine quick replies based on context
    const quickReplies = this.getQuickReplies(failureReason || 'default', attemptCount);

    const actions: InboundMessage[] = [
      {
        action: 'message.send',
        sessionId,
        payload: {
          type: 'text',
          content: message,
          quickReplies,
        },
      },
    ];

    // Trigger handoff if configured and threshold exceeded
    if (this.config.handoffOnFailure && this.hasExceededFallbackThreshold(sessionId, 2)) {
      actions.push({
        action: 'handsoff.trigger',
        sessionId,
        payload: {
          content: `Automatic escalation after ${this.getFallbackHistory(sessionId).length} fallback responses`,
          metadata: { priority: 'high' },
        } as ResponsePayload,
      });
    }

    return {
      success: true,
      actions,
    };
  }

  /**
   * Build a handoff fallback response
   */
  private buildHandoffFallback(context: FallbackContext): WebhookResponse {
    const { sessionId, failureReason } = context;

    return {
      success: true,
      actions: [
        {
          action: 'message.send',
          sessionId,
          payload: {
            type: 'text',
            content: "I'm having persistent issues responding to your request. Let me connect you with a human agent who can help.",
          },
        },
        {
          action: 'handsoff.trigger',
          sessionId,
          payload: {
            content: failureReason || 'Multiple fallback responses triggered',
            metadata: { priority: 'high', tags: ['system_failure', 'auto_escalated'] },
          } as ResponsePayload,
        },
      ],
    };
  }

  /**
   * Get appropriate quick replies for the situation
   */
  private getQuickReplies(context: string, attemptCount?: number): QuickReply[] {
    const quickReplies: QuickReply[] = [];

    if (attemptCount && attemptCount >= 2) {
      quickReplies.push(
        { id: 'retry', title: 'Try again', value: 'retry', action: 'send' },
        { id: 'human', title: 'Talk to human', value: 'human', action: 'send', icon: '👤' }
      );
    } else if (context === 'circuit_open' || context === 'timeout') {
      quickReplies.push(
        { id: 'retry', title: 'Try again', value: 'retry', action: 'send' },
        { id: 'support', title: 'Contact support', value: 'support', action: 'send', icon: '📧' }
      );
    } else {
      // Default quick replies
      if (this.config.quickReplies) {
        this.config.quickReplies.forEach((qr, index) => {
          quickReplies.push({
            id: `qr_${index}`,
            title: qr,
            value: qr.toLowerCase().replace(/\s+/g, '_'),
            action: 'send',
          });
        });
      }
    }

    return quickReplies;
  }

  /**
   * Track fallback usage for a session
   */
  private trackFallback(sessionId: string, context: FallbackContext): void {
    const history = this.fallbackHistory.get(sessionId) || [];
    history.push({
      ...context,
      timestamp: new Date().toISOString(),
    });

    // Keep only last 10 entries per session
    if (history.length > 10) {
      history.shift();
    }

    this.fallbackHistory.set(sessionId, history);
  }
}

export default FallbackService;
