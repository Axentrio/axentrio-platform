/**
 * n8n Integration Module
 * 
 * This module provides complete n8n integration for the white-label chatbot platform.
 * 
 * Features:
 * - Inbound webhook handling (n8n → platform)
 * - Outbound webhook sending (platform → n8n)
 * - Circuit breaker pattern for resilience
 * - Exponential backoff retry mechanism
 * - Fallback responses when n8n is unavailable
 * - Redis-based message queue
 * - JSON schema validation
 * - Comprehensive TypeScript types
 * 
 * @module n8n
 */

// Services
export { WebhookController, WebhookControllerConfig } from './webhook.controller';
export { WebhookService, WebhookServiceConfig } from './webhook.service';
export { OutboundService, OutboundServiceConfig, SendMessageOptions, PayloadBuilderContext } from './outbound.service';
export { CircuitBreaker, CircuitBreakerConfig, CircuitBreakerStats } from './circuit-breaker';
export { RetryService, RetryServiceConfig, RetryJobData, QueueStatus } from './retry.service';
export { FallbackService, FallbackServiceConfig, FallbackContext } from './fallback.service';

// Routes
export { createWebhookRouter, WebhookRoutesConfig } from './webhook.routes';

// Schemas
export {
  outboundMessageSchema,
  inboundMessageSchema,
  handoffActionSchema,
  fileRequestSchema,
  quickReplySchema,
  quickReplyGroupSchema,
  carouselCardSchema,
  templateMessageSchema,
  locationRequestSchema,
  outboundMessageValidationOptions,
  inboundMessageValidationOptions,
  quickReplyValidationOptions,
} from './schemas';

// Types
export * from './types';

// Factory function for easy initialization
import { WebhookController } from './webhook.controller';
import { WebhookService } from './webhook.service';
import { OutboundService } from './outbound.service';
import { CircuitBreaker } from './circuit-breaker';
import { RetryService } from './retry.service';
import { FallbackService } from './fallback.service';
import { createWebhookRouter } from './webhook.routes';

export interface N8nModuleConfig {
  // Redis configuration for queue
  redisUrl: string;
  
  // Circuit breaker settings
  circuitBreaker?: {
    failureThreshold?: number;
    successThreshold?: number;
    timeout?: number;
  };
  
  // Retry settings
  retry?: {
    maxRetries?: number;
    initialDelay?: number;
    backoffMultiplier?: number;
    maxDelay?: number;
  };
  
  // Webhook settings
  webhook?: {
    secret?: string;
    timeout?: number;
    rateLimitWindowMs?: number;
    rateLimitMax?: number;
  };
  
  // Fallback settings
  fallback?: {
    defaultMessage?: string;
    handoffOnFailure?: boolean;
    enableQuickReplies?: boolean;
    quickReplies?: string[];
  };
  
  // Service dependencies
  services: {
    eventEmitter: any;
    metricsService?: any;
  };
}

export interface N8nModule {
  controller: WebhookController;
  webhookService: WebhookService;
  outboundService: OutboundService;
  circuitBreaker: CircuitBreaker;
  retryService: RetryService;
  fallbackService: FallbackService;
  router: any;
}

/**
 * Initialize the complete n8n integration module
 */
export function createN8nModule(config: N8nModuleConfig): N8nModule {
  // Create circuit breaker
  const circuitBreaker = new CircuitBreaker({
    name: 'n8n-webhook',
    failureThreshold: config.circuitBreaker?.failureThreshold || 5,
    successThreshold: config.circuitBreaker?.successThreshold || 3,
    timeout: config.circuitBreaker?.timeout || 30000,
  });

  // Create fallback service
  const fallbackService = new FallbackService({
    defaultMessage: config.fallback?.defaultMessage,
    handoffOnFailure: config.fallback?.handoffOnFailure ?? true,
    enableQuickReplies: config.fallback?.enableQuickReplies ?? true,
    quickReplies: config.fallback?.quickReplies,
    eventEmitter: config.services.eventEmitter,
  });

  // Create outbound service
  const outboundService = new OutboundService({
    circuitBreaker,
    retryService: null as any, // Will be set after retry service is created
    fallbackService,
    metricsService: config.services.metricsService,
    defaultTimeout: config.webhook?.timeout || 5000,
  });

  // Create retry service
  const retryService = new RetryService({
    redisUrl: config.redisUrl,
    outboundService,
    circuitBreaker,
    metricsService: config.services.metricsService,
    maxRetries: config.retry?.maxRetries || 3,
    initialDelay: config.retry?.initialDelay || 1000,
    backoffMultiplier: config.retry?.backoffMultiplier || 2,
    maxDelay: config.retry?.maxDelay || 30000,
  });

  // Set retry service in outbound service (circular dependency)
  (outboundService as any).config.retryService = retryService;

  // Create webhook service (uses repositories directly)
  const webhookService = new WebhookService({
    eventEmitter: config.services.eventEmitter,
  });

  // Create webhook controller
  const controller = new WebhookController({
    webhookService,
    circuitBreaker,
    retryService,
    fallbackService,
    metricsService: config.services.metricsService,
    secret: config.webhook?.secret,
  });

  // Create router
  const router = createWebhookRouter({
    webhookController: controller,
    rateLimitWindowMs: config.webhook?.rateLimitWindowMs || 60000,
    rateLimitMax: config.webhook?.rateLimitMax || 100,
  });

  return {
    controller,
    webhookService,
    outboundService,
    circuitBreaker,
    retryService,
    fallbackService,
    router,
  };
}

export default createN8nModule;
