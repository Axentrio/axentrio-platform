/**
 * Webhook Controller
 * Handles incoming webhooks from n8n to the chatbot platform
 */

import { Request, Response } from 'express';
import { logger } from '../utils/logger';
import { config } from '../config/environment';
import { AppDataSource } from '../database/data-source';
import { Tenant } from '../database/entities/Tenant';
import { WebhookService } from './webhook.service';
import { CircuitBreaker } from './circuit-breaker';
import { RetryService } from './retry.service';
import { FallbackService } from './fallback.service';
import { inboundMessageSchema, inboundMessageValidationOptions } from './schemas';
import { InboundMessage, WebhookResponse } from './types';
import { validateJsonSchema } from '../utils/validation';
import { MetricsService } from '../services/metrics.service';

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

      // Validate message format against schema
      const validation = validateJsonSchema(req.body, inboundMessageSchema, inboundMessageValidationOptions);
      if (!validation.valid) {
        logger.warn(`[${requestId}] Message validation failed`, { errors: validation.errors });
        this.config.metricsService?.incrementCounter('n8n_webhook_validation_failures');
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
        this.config.metricsService?.incrementCounter('n8n_webhook_auth_failures');
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
      this.config.metricsService?.recordHistogram('n8n_webhook_duration', duration);
      this.config.metricsService?.incrementCounter('n8n_webhook_success');

      // Send response
      res.status(result.success ? 200 : 400).json(result);

    } catch (error) {
      const duration = Date.now() - startTime;
      this.config.metricsService?.recordHistogram('n8n_webhook_duration', duration);
      this.config.metricsService?.incrementCounter('n8n_webhook_errors');

      logger.error(`[${requestId}] Error processing inbound webhook`, error);
      
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
    
    res.status(200).json({
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
      
      res.status(200).json({
        success: true,
        message: 'Circuit breaker reset successfully',
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      logger.error('Failed to reset circuit breaker', error);
      res.status(500).json({
        success: false,
        error: 'Failed to reset circuit breaker',
      });
    }
  };

  /**
   * Get queued messages status
   * GET /api/v1/n8n/webhook/queue-status
   */
  public getQueueStatus = async (_req: Request, res: Response): Promise<void> => {
    try {
      const status = await this.config.retryService.getQueueStatus();
      
      res.status(200).json({
        success: true,
        queue: status,
      });
    } catch (error) {
      logger.error('Failed to get queue status', error);
      res.status(500).json({
        success: false,
        error: 'Failed to get queue status',
      });
    }
  };

  /**
   * Retry a specific failed message
   * POST /api/v1/n8n/webhook/retry/:messageId
   */
  public retryMessage = async (req: Request, res: Response): Promise<void> => {
    const { messageId } = req.params;
    
    try {
      const result = await this.config.retryService.retryMessage(messageId);
      
      if (result.success) {
        res.status(200).json({
          success: true,
          message: 'Message retry initiated',
          messageId,
        });
      } else {
        res.status(404).json({
          success: false,
          error: result.error || 'Message not found',
          messageId,
        });
      }
    } catch (error) {
      logger.error(`Failed to retry message ${messageId}`, error);
      res.status(500).json({
        success: false,
        error: 'Failed to retry message',
        messageId,
      });
    }
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
          result = await this.config.webhookService.triggerHandoff(sessionId, message.payload as any);
          this.config.circuitBreaker.recordSuccess();
          break;

        case 'handsoff.release':
          result = await this.config.webhookService.releaseHandoff(sessionId);
          this.config.circuitBreaker.recordSuccess();
          break;

        case 'file.request':
          result = await this.config.webhookService.requestFileUpload(sessionId, message.payload as any);
          this.config.circuitBreaker.recordSuccess();
          break;

        case 'session.clear':
          result = await this.config.webhookService.clearSession(sessionId);
          this.config.circuitBreaker.recordSuccess();
          break;

        case 'session.transfer':
          result = await this.config.webhookService.transferSession(sessionId, message.payload as any);
          this.config.circuitBreaker.recordSuccess();
          break;

        case 'user.update':
          result = await this.config.webhookService.updateUserContext(sessionId, message.payload as any);
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
   * Generate unique request ID
   */
  private generateRequestId(): string {
    return `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }
}
