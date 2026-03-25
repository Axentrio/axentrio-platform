/**
 * Outbound Service
 * Sends messages from chatbot platform to n8n webhooks
 * Includes payload building, context enrichment, and retry logic
 */

import axios, { AxiosInstance, AxiosRequestConfig, AxiosResponse } from 'axios';
import { logger } from '../utils/logger';
import { CircuitBreaker } from './circuit-breaker';
import { RetryService } from './retry.service';
import { FallbackService } from './fallback.service';
import { MetricsService } from '../services/metrics.service';
import {
  OutboundMessage,
  WebhookConfig,
  WebhookResponse,
  UserContext,
  ChatContext,
  PreviousMessage,
  QueuedMessage,
  MessagePayload,
} from './types';
import { validateJsonSchema } from '../utils/validation';
import { outboundMessageSchema, outboundMessageValidationOptions } from './schemas';

// logger imported from utils/logger

export interface OutboundServiceConfig {
  circuitBreaker: CircuitBreaker;
  retryService: RetryService;
  fallbackService: FallbackService;
  metricsService?: MetricsService;
  defaultTimeout?: number;
  maxRetries?: number;
  userAgent?: string;
}

export interface SendMessageOptions {
  timeout?: number;
  skipQueue?: boolean;
  priority?: 'low' | 'normal' | 'high';
}

export interface PayloadBuilderContext {
  sessionId: string;
  tenantId: string;
  userId: string;
  message: MessagePayload;
  req?: any; // Express request object for extracting context
  customContext?: Record<string, unknown>;
}

export class OutboundService {
  private config: OutboundServiceConfig;
  private httpClient: AxiosInstance;

  constructor(config: OutboundServiceConfig) {
    this.config = config;
    
    // Create axios instance with default config
    this.httpClient = axios.create({
      timeout: config.defaultTimeout || 5000,
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'User-Agent': config.userAgent || 'ChatbotPlatform-Webhook/1.0',
      },
      // Prevent axios from throwing on non-2xx status codes
      validateStatus: () => true,
    });

    // Add request interceptor for logging
    this.httpClient.interceptors.request.use(
      (config) => {
        logger.debug(`Outgoing webhook request: ${config.method?.toUpperCase()} ${config.url}`);
        return config;
      },
      (error) => {
        logger.error('Outgoing webhook request error', error);
        return Promise.reject(error);
      }
    );

    // Add response interceptor for logging
    this.httpClient.interceptors.response.use(
      (response) => {
        logger.debug(`Incoming webhook response: ${response.status} ${response.config.url}`);
        return response;
      },
      (error) => {
        logger.error('Incoming webhook response error', error);
        return Promise.reject(error);
      }
    );

    logger.info('OutboundService initialized');
  }

  /**
   * Send a message to n8n webhook
   * Main entry point for outbound messages
   */
  public async sendToWebhook(
    webhookConfig: WebhookConfig,
    message: OutboundMessage,
    options: SendMessageOptions = {}
  ): Promise<WebhookResponse> {
    const startTime = Date.now();
    const requestId = `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    logger.info(`[${requestId}] Sending message to webhook: ${webhookConfig.name}`, {
      sessionId: message.sessionId,
      event: message.event,
    });

    // Check if webhook is active
    if (!webhookConfig.active) {
      logger.warn(`[${requestId}] Webhook is inactive: ${webhookConfig.name}`);
      return {
        success: false,
        error: 'Webhook is inactive',
      };
    }

    // Check circuit breaker
    if (this.config.circuitBreaker.isOpen()) {
      logger.warn(`[${requestId}] Circuit breaker is OPEN, queueing message`);
      
      if (!options.skipQueue) {
        await this.queueMessage(webhookConfig, message);
      }

      return this.config.fallbackService.getFallbackResponse(message);
    }

    try {
      // Validate message format
      const validation = validateJsonSchema(message, outboundMessageSchema, outboundMessageValidationOptions);
      if (!validation.valid) {
        logger.error(`[${requestId}] Message validation failed`, validation.errors);
        return {
          success: false,
          error: 'Message validation failed',
        };
      }

      // Send the request
      const response = await this.executeWebhookRequest(
        webhookConfig,
        message,
        options.timeout || webhookConfig.timeout || this.config.defaultTimeout || 5000
      );

      const duration = Date.now() - startTime;

      // Handle response
      if (response.status >= 200 && response.status < 300) {
        // Success
        this.config.circuitBreaker.recordSuccess();
        this.config.metricsService?.incrementCounter('n8n_outbound_success');
        this.config.metricsService?.recordHistogram('n8n_outbound_duration', duration);

        logger.info(`[${requestId}] Webhook request successful`, {
          status: response.status,
          duration,
        });

        return {
          success: true,
          actions: response.data?.actions,
        };
      } else {
        // HTTP error
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

    } catch (error) {
      const duration = Date.now() - startTime;
      this.config.metricsService?.incrementCounter('n8n_outbound_errors');
      this.config.metricsService?.recordHistogram('n8n_outbound_duration', duration);

      logger.error(`[${requestId}] Webhook request failed`, error);

      // Record failure in circuit breaker
      this.config.circuitBreaker.recordFailure();

      // Queue for retry if not skipping queue
      if (!options.skipQueue) {
        await this.queueMessage(webhookConfig, message, error instanceof Error ? error.message : 'Unknown error');
      }

      // If circuit is now open, return fallback response
      if (this.config.circuitBreaker.isOpen()) {
        return this.config.fallbackService.getFallbackResponse(message);
      }

      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Build complete outbound message with context enrichment
   */
  public buildOutboundMessage(
    context: PayloadBuilderContext,
    event: string = 'message.received'
  ): OutboundMessage {
    const { sessionId, tenantId, userId, message, req, customContext } = context;

    // Build user context
    const userContext = this.buildUserContext(userId, req);

    // Build chat context with previous messages
    const chatContext = this.buildChatContext(sessionId, customContext, req);

    // Create the outbound message
    const outboundMessage: OutboundMessage = {
      event: event as OutboundMessage['event'],
      tenantId,
      sessionId,
      timestamp: new Date().toISOString(),
      payload: message,
      user: userContext,
      context: chatContext,
    };

    return outboundMessage;
  }

  /**
   * Build user context from request and user data
   */
  private buildUserContext(userId: string, req?: any): UserContext {
    const userContext: UserContext = {
      anonymousId: userId,
    };

    if (req) {
      // Extract browser info from User-Agent
      const userAgent = req.headers['user-agent'];
      if (userAgent) {
        userContext.browser = userAgent;
        userContext.device = this.parseDeviceInfo(userAgent);
      }

      // Hash IP address for privacy
      const ip = req.ip || req.connection?.remoteAddress;
      if (ip) {
        userContext.ip = this.hashIpAddress(ip);
      }

      // Extract geo location if available
      if (req.geo) {
        userContext.geo = req.geo;
      }
    }

    return userContext;
  }

  /**
   * Build chat context with previous messages and page info
   */
  private buildChatContext(
    sessionId: string,
    customContext?: Record<string, unknown>,
    req?: any
  ): ChatContext {
    const context: ChatContext = {
      previousMessages: [],
      customContext,
    };

    if (req) {
      // Page URL
      context.pageUrl = req.headers.referer || req.headers.origin;
      context.referrer = req.headers.referer;

      // UTM parameters
      const utmParams = this.extractUtmParams(req);
      if (Object.keys(utmParams).length > 0) {
        context.utmParams = utmParams;
      }
    }

    // Fetch previous messages (last 10)
    // This would typically come from a message repository
    context.previousMessages = this.getPreviousMessages(sessionId);

    return context;
  }

  /**
   * Get previous messages for context
   * In production, this would query the database
   */
  private getPreviousMessages(_sessionId: string): PreviousMessage[] {
    // Placeholder - would fetch from message repository
    // Return empty array for now
    return [];
  }

  /**
   * Execute the actual HTTP request to n8n webhook
   */
  private async executeWebhookRequest(
    webhookConfig: WebhookConfig,
    message: OutboundMessage,
    timeout: number
  ): Promise<AxiosResponse> {
    const config: AxiosRequestConfig = {
      method: 'POST',
      url: webhookConfig.url,
      data: message,
      timeout,
      headers: {
        ...webhookConfig.headers,
        'X-Webhook-ID': webhookConfig.id,
        'X-Tenant-ID': message.tenantId,
        'X-Session-ID': message.sessionId,
        'X-Event-Type': message.event,
        'X-Timestamp': message.timestamp,
      },
    };

    // Add signature header if secret is configured
    if (webhookConfig.secret) {
      const signature = this.generateSignature(message, webhookConfig.secret);
      config.headers!['X-Webhook-Signature'] = signature;
    }

    return this.httpClient.request(config);
  }

  /**
   * Queue a message for retry
   */
  private async queueMessage(
    webhookConfig: WebhookConfig,
    message: OutboundMessage,
    error?: string
  ): Promise<void> {
    const queuedMessage: QueuedMessage = {
      id: `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      message,
      webhookConfig,
      attempts: 1,
      maxAttempts: webhookConfig.retryPolicy?.maxRetries || 3,
      lastAttempt: new Date().toISOString(),
      error,
      createdAt: new Date().toISOString(),
    };

    await this.config.retryService.queueMessage(queuedMessage);
    
    logger.info(`Message queued for retry`, {
      messageId: queuedMessage.id,
      sessionId: message.sessionId,
    });
  }

  /**
   * Generate HMAC signature for webhook verification
   */
  private generateSignature(payload: unknown, secret: string): string {
    const crypto = require('crypto');
    const hmac = crypto.createHmac('sha256', secret);
    hmac.update(JSON.stringify(payload));
    return `sha256=${hmac.digest('hex')}`;
  }

  /**
   * Hash IP address for privacy
   */
  private hashIpAddress(ip: string): string {
    const crypto = require('crypto');
    return crypto.createHash('sha256').update(ip).digest('hex').substring(0, 16);
  }

  /**
   * Parse device info from User-Agent string
   */
  private parseDeviceInfo(userAgent: string): { type: 'desktop' | 'mobile' | 'tablet'; os?: string; browser?: string } {
    const device: { type: 'desktop' | 'mobile' | 'tablet'; os?: string; browser?: string } = {
      type: 'desktop',
    };

    // Detect device type
    if (/Mobile|Android|iPhone|iPod/.test(userAgent)) {
      device.type = 'mobile';
    } else if (/iPad|Tablet/.test(userAgent)) {
      device.type = 'tablet';
    }

    // Detect OS
    if (/Windows/.test(userAgent)) {
      device.os = 'Windows';
    } else if (/Mac/.test(userAgent)) {
      device.os = 'macOS';
    } else if (/Linux/.test(userAgent)) {
      device.os = 'Linux';
    } else if (/Android/.test(userAgent)) {
      device.os = 'Android';
    } else if (/iOS|iPhone|iPad/.test(userAgent)) {
      device.os = 'iOS';
    }

    // Detect browser
    if (/Chrome/.test(userAgent)) {
      device.browser = 'Chrome';
    } else if (/Firefox/.test(userAgent)) {
      device.browser = 'Firefox';
    } else if (/Safari/.test(userAgent)) {
      device.browser = 'Safari';
    } else if (/Edge/.test(userAgent)) {
      device.browser = 'Edge';
    }

    return device;
  }

  /**
   * Extract UTM parameters from request
   */
  private extractUtmParams(req: any): { source?: string; medium?: string; campaign?: string; term?: string; content?: string } {
    const utmParams: { source?: string; medium?: string; campaign?: string; term?: string; content?: string } = {};

    const query = req.query || {};

    if (query.utm_source) utmParams.source = query.utm_source;
    if (query.utm_medium) utmParams.medium = query.utm_medium;
    if (query.utm_campaign) utmParams.campaign = query.utm_campaign;
    if (query.utm_term) utmParams.term = query.utm_term;
    if (query.utm_content) utmParams.content = query.utm_content;

    return utmParams;
  }

  /**
   * Sleep utility for delays
   */
  /* istanbul ignore next */
  // @ts-ignore: kept for future use
  private _sleep(ms: number): Promise<void> { return new Promise(resolve => setTimeout(resolve, ms)); }
}

export default OutboundService;
