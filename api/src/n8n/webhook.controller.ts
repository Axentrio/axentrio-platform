/**
 * Webhook Controller
 * Handles incoming webhooks from n8n to the chatbot platform
 */

import { Request, Response } from 'express';
import { logger } from '../utils/logger';
import { config } from '../config/environment';
import { AppDataSource } from '../database/data-source';
import { Tenant } from '../database/entities/Tenant';
import { ChatSession } from '../database/entities/ChatSession';
import { HandoffRequest } from '../database/entities/HandoffRequest';
import { WebhookService } from './webhook.service';
import { CircuitBreaker } from './circuit-breaker';
import { RetryService } from './retry.service';
import { FallbackService } from './fallback.service';
import { inboundMessageSchema, inboundMessageValidationOptions } from './schemas';
import { InboundMessage, WebhookResponse, HandoffPayload, FileRequestPayload } from './types';
import { validateJsonSchema } from '../utils/validation';
import { MetricsService } from '../services/metrics.service';
import { WebhookDeliveryLog } from '../database/entities/WebhookDeliveryLog';
import { sendSuccess } from '../utils/response';
import { ApiError, NotFoundError } from '../middleware/error-handler';
import { ERROR_CODES } from '../middleware/error-codes';

// logger imported from utils/logger

export interface WebhookControllerConfig {
  webhookService: WebhookService;
  circuitBreaker: CircuitBreaker;
  retryService: RetryService;
  fallbackService: FallbackService;
  metricsService: MetricsService;
  secret?: string;
  maxPayloadSize?: number;
}

export class WebhookController {
  private config: WebhookControllerConfig;

  constructor(config: WebhookControllerConfig) {
    this.config = config;
    logger.info('WebhookController initialized');
  }

  /**
   * Main webhook handler for n8n incoming messages
   * POST /api/v1/n8n/webhook/inbound
   */
  public handleInboundWebhook = async (req: Request, res: Response): Promise<void> => {
    const startTime = Date.now();
    const requestId = req.headers['x-request-id'] as string || this.generateRequestId();
    
    logger.debug(`[${requestId}] Received inbound webhook`, {
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });

    try {
      // Validate request body exists
      if (!req.body || Object.keys(req.body).length === 0) {
        logger.warn(`[${requestId}] Empty request body`);
        res.status(400).json({
          success: false,
          error: 'Bad Request: Empty request body',
        });
        return;
      }

      // Reject oversized payloads — max 50KB for message content
      const MAX_CONTENT_SIZE = 50_000;
      const contentLength = typeof req.body?.payload?.content === 'string'
        ? req.body.payload.content.length
        : 0;
      if (contentLength > MAX_CONTENT_SIZE) {
        logger.warn(`[${requestId}] Payload content too large: ${contentLength} chars (max ${MAX_CONTENT_SIZE})`);
        res.status(413).json({
          success: false,
          error: `Payload too large: content is ${contentLength} chars (max ${MAX_CONTENT_SIZE})`,
        });
        return;
      }

      // Validate message format against schema
      const validation = validateJsonSchema(req.body, inboundMessageSchema, inboundMessageValidationOptions);
      if (!validation.valid) {
        logger.warn(`[${requestId}] Message validation failed`, { errors: validation.errors });
        this.config.metricsService?.incrementCounter('webhook_inbound_validation_failures');
        res.status(400).json({
          success: false,
          error: 'Bad Request: Invalid message format',
          details: validation.errors,
        });
        return;
      }

      const message = req.body as InboundMessage;

      // Per-tenant webhook secret verification
      // Parse body first to get tenantId, then verify against tenant's secret
      if (!(await this.verifyPerTenantSecret(req, message.tenantId))) {
        logger.warn(`[${requestId}] Webhook secret verification failed`);
        this.config.metricsService?.incrementCounter('webhook_inbound_auth_failures');
        res.status(401).json({
          success: false,
          error: 'Unauthorized: Invalid or missing webhook secret',
        });
        return;
      }

      // Log received action
      logger.info(`[${requestId}] Processing inbound action: ${message.action}`, {
        sessionId: message.sessionId,
        tenantId: message.tenantId,
      });

      // Process the message through the webhook service
      const result = await this.processInboundMessage(message, requestId);

      // Record metrics
      const duration = Date.now() - startTime;
      this.config.metricsService?.recordHistogram('webhook_inbound_duration', duration);
      this.config.metricsService?.incrementCounter('webhook_inbound_success');

      // Log delivery
      this.logInboundDelivery(
        message.tenantId || 'unknown',
        message.action,
        req.originalUrl,
        result.success ? 'success' : 'failed',
        result.success ? 200 : 400,
        duration,
        result.success ? undefined : result.error,
        req.body
      );

      // Send response
      res.status(result.success ? 200 : 400).json(result);

    } catch (error) {
      const duration = Date.now() - startTime;
      this.config.metricsService?.recordHistogram('webhook_inbound_duration', duration);
      this.config.metricsService?.incrementCounter('webhook_inbound_errors');

      logger.error(`[${requestId}] Error processing inbound webhook`, error);

      // Log delivery failure
      this.logInboundDelivery(
        req.body?.tenantId || 'unknown',
        req.body?.action || 'unknown',
        req.originalUrl,
        'failed',
        500,
        duration,
        error instanceof Error ? error.message : 'Internal server error',
        req.body
      );

      res.status(500).json({
        success: false,
        error: 'Internal Server Error: Failed to process webhook',
        requestId,
      });
    }
  };

  /**
   * Health check endpoint for n8n integration
   * GET /api/v1/n8n/webhook/health
   */
  public healthCheck = async (_req: Request, res: Response): Promise<void> => {
    const circuitState = this.config.circuitBreaker.getState();
    
    res.status(200).json({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      circuitBreaker: {
        state: circuitState.state,
        failures: circuitState.failures,
      },
      services: {
        webhook: true,
        circuitBreaker: true,
        retry: true,
        fallback: true,
      },
    });
  };

  /**
   * Get circuit breaker status
   * GET /api/v1/n8n/webhook/circuit-status
   */
  public getCircuitStatus = async (_req: Request, res: Response): Promise<void> => {
    const state = this.config.circuitBreaker.getState();
    const stats = this.config.circuitBreaker.getStats();

    sendSuccess(res, {
      state: state.state,
      failures: state.failures,
      successCount: state.successCount,
      lastFailureTime: state.lastFailureTime,
      lastSuccessTime: state.lastSuccessTime,
      nextAttemptTime: state.nextAttemptTime,
      stats,
    });
  };

  /**
   * Reset circuit breaker (admin endpoint)
   * POST /api/v1/n8n/webhook/circuit-reset
   */
  public resetCircuitBreaker = async (_req: Request, res: Response): Promise<void> => {
    try {
      this.config.circuitBreaker.reset();
      logger.info('Circuit breaker manually reset');
    } catch (error) {
      logger.error('Failed to reset circuit breaker', error);
      throw new ApiError(
        'Failed to reset circuit breaker',
        500,
        ERROR_CODES.UPSTREAM_FAILED,
      );
    }

    sendSuccess(res, {
      message: 'Circuit breaker reset successfully',
      timestamp: new Date().toISOString(),
    });
  };

  /**
   * Get queued messages status
   * GET /api/v1/n8n/webhook/queue-status
   */
  public getQueueStatus = async (_req: Request, res: Response): Promise<void> => {
    let status;
    try {
      status = await this.config.retryService.getQueueStatus();
    } catch (error) {
      logger.error('Failed to get queue status', error);
      throw new ApiError(
        'Failed to get queue status',
        500,
        ERROR_CODES.UPSTREAM_FAILED,
      );
    }

    sendSuccess(res, { queue: status });
  };

  /**
   * Retry a specific failed message
   * POST /api/v1/n8n/webhook/retry/:messageId
   */
  public retryMessage = async (req: Request, res: Response): Promise<void> => {
    const { messageId } = req.params;

    let result;
    try {
      result = await this.config.retryService.retryMessage(messageId);
    } catch (error) {
      logger.error(`Failed to retry message ${messageId}`, error);
      throw new ApiError(
        'Failed to retry message',
        500,
        ERROR_CODES.UPSTREAM_FAILED,
      );
    }

    if (!result.success) {
      throw new NotFoundError(result.error || 'Message not found');
    }

    sendSuccess(res, {
      message: 'Message retry initiated',
      messageId,
    });
  };

  /**
   * Process the inbound message based on action type
   */
  private async processInboundMessage(
    message: InboundMessage,
    requestId: string
  ): Promise<WebhookResponse> {
    const { action, sessionId, payload, delay = 0 } = message;

    // Check circuit breaker before processing
    if (this.config.circuitBreaker.isOpen()) {
      logger.warn(`[${requestId}] Circuit breaker is OPEN, triggering fallback`);
      return this.config.fallbackService.handleCircuitOpen(message);
    }

    // Session state guard — reject bot actions for closed sessions
    // Allow handsoff.release and session.clear to work on any session state
    const exemptActions = ['handsoff.release', 'session.clear', 'typing.start', 'typing.stop'];
    if (!exemptActions.includes(action)) {
      const sessionRepo = AppDataSource.getRepository(ChatSession);
      const session = await sessionRepo.findOne({ where: { id: sessionId } });
      if (session?.status === 'closed') {
        logger.warn(`[${requestId}] Action ${action} rejected — session ${sessionId} is closed`);
        return { success: false, error: `Session is closed — action ${action} not accepted` };
      }
      // For non-handoff actions, also reject if session is in handoff (human owns it)
      if (session?.status === 'handoff' && action !== 'handsoff.trigger') {
        logger.warn(`[${requestId}] Action ${action} rejected — session ${sessionId} is in handoff`);
        return { success: false, error: `Session is in handoff — bot action ${action} not accepted` };
      }
      // Prevent duplicate handoff requests
      if (action === 'handsoff.trigger' && session?.status === 'handoff') {
        const handoffRepo = AppDataSource.getRepository(HandoffRequest);
        const existing = await handoffRepo.findOne({
          where: { sessionId, status: 'requested' as HandoffRequest['status'] },
        });
        if (existing) {
          logger.warn(`[${requestId}] Duplicate handoff rejected — session ${sessionId} already has pending handoff ${existing.id}`);
          return { success: false, error: 'Handoff already pending for this session' };
        }
      }
    }

    try {
      let result: WebhookResponse;

      switch (action) {
        case 'message.send':
          result = await this.config.webhookService.sendMessageToSession(sessionId, payload, delay);
          this.config.circuitBreaker.recordSuccess();
          break;

        case 'message.edit':
          result = await this.config.webhookService.editMessage(sessionId, payload);
          this.config.circuitBreaker.recordSuccess();
          break;

        case 'message.delete':
          result = await this.config.webhookService.deleteMessage(sessionId, payload);
          this.config.circuitBreaker.recordSuccess();
          break;

        case 'typing.start':
          result = await this.config.webhookService.sendTypingIndicator(sessionId, true);
          this.config.circuitBreaker.recordSuccess();
          break;

        case 'typing.stop':
          result = await this.config.webhookService.sendTypingIndicator(sessionId, false);
          this.config.circuitBreaker.recordSuccess();
          break;

        case 'handsoff.trigger':
          result = await this.config.webhookService.triggerHandoff(sessionId, message.payload as HandoffPayload | undefined);
          this.config.circuitBreaker.recordSuccess();
          break;

        case 'handsoff.release':
          result = await this.config.webhookService.releaseHandoff(sessionId);
          this.config.circuitBreaker.recordSuccess();
          break;

        case 'file.request':
          result = await this.config.webhookService.requestFileUpload(sessionId, message.payload as FileRequestPayload | undefined);
          this.config.circuitBreaker.recordSuccess();
          break;

        case 'session.clear':
          result = await this.config.webhookService.clearSession(sessionId);
          this.config.circuitBreaker.recordSuccess();
          break;

        case 'session.transfer':
          result = await this.config.webhookService.transferSession(sessionId, message.payload as Record<string, unknown> | undefined);
          this.config.circuitBreaker.recordSuccess();
          break;

        case 'user.update':
          result = await this.config.webhookService.updateUserContext(sessionId, message.payload as Record<string, unknown> | undefined);
          this.config.circuitBreaker.recordSuccess();
          break;

        default:
          logger.warn(`[${requestId}] Unknown action type: ${action}`);
          return {
            success: false,
            error: `Unknown action type: ${action}`,
          };
      }

      return result;

    } catch (error) {
      // Record failure in circuit breaker
      this.config.circuitBreaker.recordFailure();
      
      logger.error(`[${requestId}] Error processing action ${action}`, error);
      
      // If circuit is now open, trigger fallback
      if (this.config.circuitBreaker.isOpen()) {
        logger.warn(`[${requestId}] Circuit breaker opened due to failures`);
        return this.config.fallbackService.handleCircuitOpen(message);
      }

      throw error;
    }
  }

  /**
   * Verify webhook secret against per-tenant secret
   * Looks up the tenant by tenantId and verifies the request signature
   * If no webhookSecret is set on the tenant, skip verification (easy initial setup)
   */
  private async verifyPerTenantSecret(req: Request, tenantId?: string): Promise<boolean> {
    if (!tenantId) {
      // No tenantId in request — fall back to global secret check
      if (!this.config.secret) return true;
      const providedSecret = req.headers['x-webhook-secret'] as string ||
                            req.headers['authorization']?.replace('Bearer ', '');
      return this.timingSafeCompare(providedSecret || '', this.config.secret);
    }

    try {
      const tenantRepo = AppDataSource.getRepository(Tenant);
      const tenant = await tenantRepo.findOne({ where: { id: tenantId } });

      if (!tenant) {
        logger.warn(`Tenant not found for webhook verification: ${tenantId}`);
        return false;
      }

      // If no webhookSecret set on tenant, reject in production, warn in dev
      if (!tenant.webhookSecret) {
        if (config.server.isProduction) {
          logger.warn(`Tenant ${tenantId} has no webhookSecret configured — rejecting webhook in production`);
          return false;
        }
        logger.warn(`Tenant ${tenantId} has no webhookSecret configured — allowing in development only`);
        return true;
      }

      const providedSecret = req.headers['x-webhook-secret'] as string ||
                            req.headers['authorization']?.replace('Bearer ', '');

      return this.timingSafeCompare(providedSecret || '', tenant.webhookSecret);
    } catch (error) {
      logger.error('Error during per-tenant secret verification', error);
      return false;
    }
  }

  /**
   * Timing-safe string comparison
   */
  private timingSafeCompare(a: string, b: string): boolean {
    if (a.length !== b.length) {
      return false;
    }
    
    let result = 0;
    for (let i = 0; i < a.length; i++) {
      result |= a.charCodeAt(i) ^ b.charCodeAt(i);
    }
    return result === 0;
  }

  /**
   * Log an inbound delivery attempt (non-blocking)
   */
  private logInboundDelivery(
    tenantId: string,
    event: string,
    url: string,
    status: 'success' | 'failed',
    httpStatus: number,
    durationMs: number,
    error?: string,
    body?: unknown
  ): void {
    try {
      const repo = AppDataSource.getRepository(WebhookDeliveryLog);
      let truncatedBody: Record<string, unknown> | undefined;
      if (body) {
        const str = JSON.stringify(body);
        truncatedBody = str.length > 2048
          ? { _truncated: true, preview: str.slice(0, 2048) }
          : body as Record<string, unknown>;
      }

      // Fire-and-forget — don't await to avoid slowing the response
      repo.save(repo.create({
        tenantId,
        event,
        direction: 'inbound' as const,
        url,
        status,
        httpStatus,
        durationMs,
        error,
        requestBody: truncatedBody,
      })).catch(err => {
        logger.warn('Failed to write inbound delivery log', { error: err });
      });
    } catch (err) {
      logger.warn('Failed to write inbound delivery log', { error: err });
    }
  }

  /**
   * Generate unique request ID
   */
  private generateRequestId(): string {
    return `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }
}
