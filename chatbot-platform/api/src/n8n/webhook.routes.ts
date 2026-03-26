/**
 * Webhook Routes
 * Express routes for n8n webhook endpoints
 */

import { Router, Request, Response, NextFunction } from 'express';
import { WebhookController } from './webhook.controller';
import { rateLimit } from 'express-rate-limit';
import { body, validationResult } from 'express-validator';
import { logger } from '../utils/logger';

export interface WebhookRoutesConfig {
  webhookController: WebhookController;
  rateLimitWindowMs?: number;
  rateLimitMax?: number;
  requireAuth?: boolean;
}

/**
 * Create webhook router with all n8n integration endpoints
 */
export function createWebhookRouter(config: WebhookRoutesConfig): Router {
  const router = Router();
  const controller = config.webhookController;

  // Rate limiter for webhook endpoints
  const webhookRateLimiter = rateLimit({
    windowMs: config.rateLimitWindowMs || 60000, // 1 minute
    max: config.rateLimitMax || 100, // 100 requests per window
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req: Request, res: Response) => {
      logger.warn(`Rate limit exceeded for IP: ${req.ip}`);
      res.status(429).json({
        success: false,
        error: 'Too many requests, please try again later',
        retryAfter: Math.ceil((config.rateLimitWindowMs || 60000) / 1000),
      });
    },
  });

  const validateRequest = (req: Request, res: Response, next: NextFunction) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({
        success: false,
        error: 'Validation failed',
        details: errors.array(),
      });
      return;
    }
    next();
  };

  // ============================================================================
  // Public Webhook Endpoints (Called by n8n)
  // ============================================================================

  /**
   * @route   POST /api/v1/n8n/webhook/inbound
   * @desc    Receive messages/actions from n8n
   * @access  Public (with secret verification)
   * 
   * Body: InboundMessage
   * {
   *   "action": "message.send",
   *   "sessionId": "uuid",
   *   "payload": { ... },
   *   "delay": 0
   * }
   */
  router.post(
    '/inbound',
    webhookRateLimiter,
    [
      body('action')
        .notEmpty()
        .isString()
        .isIn([
          'message.send',
          'message.edit',
          'message.delete',
          'typing.start',
          'typing.stop',
          'handsoff.trigger',
          'handsoff.release',
          'file.request',
          'session.clear',
          'session.transfer',
          'user.update',
        ])
        .withMessage('Invalid or missing action'),
      body('sessionId')
        .notEmpty()
        .isUUID()
        .withMessage('Valid sessionId (UUID) is required'),
      body('payload')
        .optional()
        .isObject()
        .withMessage('Payload must be an object'),
      body('delay')
        .optional()
        .isInt({ min: 0, max: 30000 })
        .withMessage('Delay must be between 0 and 30000ms'),
      validateRequest,
    ],
    controller.handleInboundWebhook
  );

  /**
   * @route   GET /api/v1/n8n/webhook/health
   * @desc    Health check for n8n integration
   * @access  Public
   */
  router.get('/health', controller.healthCheck);

  // ============================================================================
  // Admin/Monitoring Endpoints
  // ============================================================================

  /**
   * @route   GET /api/v1/n8n/webhook/circuit-status
   * @desc    Get circuit breaker current status
   * @access  Admin
   */
  router.get('/circuit-status', controller.getCircuitStatus);

  /**
   * @route   POST /api/v1/n8n/webhook/circuit-reset
   * @desc    Manually reset circuit breaker
   * @access  Admin
   */
  router.post('/circuit-reset', controller.resetCircuitBreaker);

  /**
   * @route   GET /api/v1/n8n/webhook/queue-status
   * @desc    Get message queue status
   * @access  Admin
   */
  router.get('/queue-status', controller.getQueueStatus);

  /**
   * @route   POST /api/v1/n8n/webhook/retry/:messageId
   * @desc    Retry a specific failed message
   * @access  Admin
   */
  router.post('/retry/:messageId', controller.retryMessage);

  // ============================================================================
  // Webhook Events Endpoint (For testing)
  // ============================================================================

  /**
   * @route   GET /api/v1/n8n/webhook/events
   * @desc    Get list of available webhook events
   * @access  Public
   */
  router.get('/events', (_req: Request, res: Response) => {
    res.status(200).json({
      success: true,
      events: [
        {
          name: 'message.received',
          description: 'Triggered when a user sends a message',
          payload: {
            event: 'message.received',
            sessionId: 'uuid',
            payload: { type: 'text', content: 'Hello' },
          },
        },
        {
          name: 'message.sent',
          description: 'Triggered when a message is sent to user',
          payload: {
            event: 'message.sent',
            sessionId: 'uuid',
            payload: { type: 'text', content: 'Hi there!' },
          },
        },
        {
          name: 'session.started',
          description: 'Triggered when a new chat session starts',
          payload: {
            event: 'session.started',
            sessionId: 'uuid',
            user: { anonymousId: 'uuid' },
          },
        },
        {
          name: 'session.ended',
          description: 'Triggered when a chat session ends',
          payload: {
            event: 'session.ended',
            sessionId: 'uuid',
            reason: 'user_closed',
          },
        },
        {
          name: 'user.typing',
          description: 'Triggered when user starts/stops typing',
          payload: {
            event: 'user.typing',
            sessionId: 'uuid',
            isTyping: true,
          },
        },
        {
          name: 'file.uploaded',
          description: 'Triggered when user uploads a file',
          payload: {
            event: 'file.uploaded',
            sessionId: 'uuid',
            payload: {
              type: 'file',
              metadata: { filename: 'document.pdf', size: 1024 },
            },
          },
        },
        {
          name: 'handsoff.requested',
          description: 'Triggered when human handoff is requested',
          payload: {
            event: 'handsoff.requested',
            sessionId: 'uuid',
            reason: 'Bot escalation',
          },
        },
        {
          name: 'handsoff.accepted',
          description: 'Triggered when human agent accepts handoff',
          payload: {
            event: 'handsoff.accepted',
            sessionId: 'uuid',
            agentId: 'agent_123',
          },
        },
        {
          name: 'handsoff.released',
          description: 'Triggered when human handoff is released',
          payload: {
            event: 'handsoff.released',
            sessionId: 'uuid',
          },
        },
      ],
    });
  });

  logger.info('Webhook routes registered');
  return router;
}

export default createWebhookRouter;
