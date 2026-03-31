/**
 * Chatbot Platform API Server
 * Express + Socket.io with Redis adapter for multi-server scaling
 */
import { initSentry, Sentry } from './config/sentry';
initSentry();

import 'reflect-metadata';
import express from 'express';
import { createServer } from 'http';
import cors from 'cors';
import helmet from 'helmet';

import { clerkMiddleware } from '@clerk/express';
import { config } from './config/environment';
import { logger } from './utils/logger';
import { AppDataSource } from './database/data-source';
import { initializeRedis, closeRedis } from './config/redis';
import { initializeSocketIO } from './websocket/socket.handler';

// Security middleware
import { cspMiddleware } from './security/csp.middleware';
import { xssMiddleware } from './security/xss-protection';

// Routes
import authRoutes from './routes/auth.routes';
import chatRoutes from './routes/chat.routes';
import handoffRoutes from './routes/handsoff.routes';
import agentRoutes from './routes/agents.routes';
import { tenantRouter as tenantRoutes } from './routes/tenants';
import { widgetRouter as widgetRoutes } from './routes/widget';
import fileRoutes from './routes/files.routes';
import analyticsRoutes from './routes/analytics.routes';
import notificationRoutes from './routes/notifications.routes';
import userRoutes from './routes/users.routes';
import clerkWebhookRoutes from './routes/clerk-webhook.routes';
import webhookAdminRoutes from './routes/webhook-admin.routes';
import adminRoutes from './routes/admin.routes';
import knowledgeRoutes from './knowledge/knowledge.routes';
import aiSettingsRoutes from './knowledge/ai-settings.routes';
import cannedResponseRoutes from './routes/canned-responses.routes';
import { requireClerkAuth, autoProvision } from './middleware/clerk.middleware';

// Webhook integration
import { createWebhookModule } from './n8n';
import { initializeForwarding } from './services/message-forwarding.service';
import ragSearchRoutes from './n8n/rag-search.routes';
import { EventEmitter } from './utils/event-emitter';

// Channel integrations
import metaWebhookRoutes from './channels/meta/webhook.routes';
import channelWebhookRoutes from './channels/channel-webhook.routes';
import channelManagementRoutes from './channels/channel-management.routes';
import { registerChannelAdapter } from './channels/channel-registry';
import { telegramAdapter } from './channels/telegram';
import { messengerAdapter, instagramAdapter } from './channels/meta';
import metaOAuthRoutes, { metaOAuthCallbackRouter } from './channels/meta/oauth.routes';

// Middleware
import { rateLimitByIp } from './middleware/rate-limit.middleware';
import { errorHandler, notFoundHandler } from './middleware/error-handler';
import { requestIdMiddleware } from './middleware/request-id.middleware';
import { timeoutMiddleware } from './middleware/timeout.middleware';

const app = express();
const httpServer = createServer(app);

// Health check (no prefix, for Railway)
app.get('/health', (_req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    env: config.server.env,
  });
});

// Clerk webhook — must use raw body parser, registered before express.json()
// Narrowed to /clerk sub-path to avoid consuming body for other /webhooks/* routes
app.use('/api/v1/webhooks/clerk', express.raw({ type: 'application/json' }), clerkWebhookRoutes);

// Meta webhook — must use raw body parser for HMAC verification
app.use('/api/v1/channels/meta/webhook', express.raw({ type: 'application/json' }), metaWebhookRoutes);

// Request ID — must come before all other middleware
app.use(requestIdMiddleware);

// Security middleware stack
app.use(helmet({ contentSecurityPolicy: config.server.isProduction }));
if (config.server.isProduction) {
  app.use(cspMiddleware);
  app.use(xssMiddleware);
}
app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (mobile apps, curl, server-to-server)
    if (!origin) {
      callback(null, true);
      return;
    }

    const allowed = [
      ...(Array.isArray(config.cors.origin) ? config.cors.origin : [config.cors.origin]),
    ].filter(Boolean);

    // In development, also allow common localhost origins
    const devOrigins = config.server.isDevelopment
      ? ['http://localhost:4080', 'http://localhost:3000', 'http://localhost:5173']
      : [];

    const allAllowed = [...allowed, ...devOrigins];

    if (
      allAllowed.includes('*') ||
      allAllowed.includes(origin) ||
      origin.endsWith('.clerk.accounts.dev')
    ) {
      callback(null, true);
    } else {
      logger.warn(`CORS request blocked from origin: ${origin}`);
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: config.cors.credentials,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Tenant-ID', 'X-Session-ID', 'X-Tenant-Context'],
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(rateLimitByIp);

// Meta OAuth callback — after CORS but before Clerk (Facebook redirects here unauthenticated)
app.use('/api/v1/channels/meta/oauth', metaOAuthCallbackRouter);

// Clerk middleware (global — populates auth state for all requests)
app.use(clerkMiddleware());

// Request logging in development
if (config.server.isDevelopment) {
  app.use((req, _res, next) => {
    logger.debug(`${req.method} ${req.path}`);
    next();
  });
}

// API routes under /api/v1
const apiRouter = express.Router();
apiRouter.use('/analytics', timeoutMiddleware(60000), analyticsRoutes);
apiRouter.use(timeoutMiddleware(30000));
apiRouter.use('/auth', authRoutes);
apiRouter.use('/chats', chatRoutes);
apiRouter.use('/handoffs', handoffRoutes);
apiRouter.use('/agents', agentRoutes);
apiRouter.use('/users', userRoutes);
apiRouter.use('/tenants', tenantRoutes);
apiRouter.use('/widget', widgetRoutes);
apiRouter.use('/files', fileRoutes);
apiRouter.use('/notifications', notificationRoutes);
apiRouter.use('/tenants/me/webhooks', requireClerkAuth, autoProvision, webhookAdminRoutes);
apiRouter.use('/admin', adminRoutes);
apiRouter.use('/knowledge', knowledgeRoutes);
apiRouter.use('/canned-responses', cannedResponseRoutes);
apiRouter.use('/tenants/me', aiSettingsRoutes);

app.use('/api/v1', apiRouter);

// Sentry error handler (must be before other error handlers)
Sentry.setupExpressErrorHandler(app);

// Error handlers (must be last)
app.use(notFoundHandler);
app.use(errorHandler);

// Boot sequence
async function startServer(): Promise<void> {
  try {
    logger.info('Starting Chatbot Platform API...');

    await AppDataSource.initialize();
    logger.info('Database connection established');

    // Run pending migrations on startup
    const pending = await AppDataSource.showMigrations();
    if (pending) {
      logger.info('Running pending database migrations...');
      await AppDataSource.runMigrations();
      logger.info('Database migrations completed');
    } else {
      logger.info('Database schema is up to date');
    }

    await initializeRedis();

    // Initialize Bull queue (depends on Redis — graceful fallback if unavailable)
    try {
      const { initializeQueues } = await import('./queue/message-queue');
      await initializeQueues();
      logger.info('Message queue initialized');
    } catch (err) {
      logger.warn('Queue initialization failed, falling back to synchronous processing', { error: err });
    }

    // Register knowledge ingestion processor
    try {
      const { registerProcessor } = await import('./queue/message-queue');
      const { createIngestionProcessor } = await import('./knowledge/ingestion.worker');
      const { createS3Client } = await import('./config/s3.config');
      const s3Client = config.s3?.bucket ? createS3Client() : null;
      registerProcessor('knowledge-processing', createIngestionProcessor(AppDataSource, s3Client));
      logger.info('Knowledge ingestion processor registered');
    } catch (err) {
      logger.warn('Knowledge ingestion processor registration failed', { error: err });
    }

    // Initialize webhook integration module
    try {
      const webhookModule = createWebhookModule({
        redisUrl: config.redis.url || `redis://${config.redis.host}:${config.redis.port}`,
        circuitBreaker: {
          failureThreshold: 5,
          successThreshold: 3,
          timeout: 30000,
        },
        retry: {
          maxRetries: config.queue.maxAttempts || 3,
          initialDelay: config.queue.backoffDelay || 1000,
          backoffMultiplier: 2,
        },
        services: {
          eventEmitter: new EventEmitter(),
        },
      });

      apiRouter.use('/webhooks', webhookModule.router);

      // Wire outbound message forwarding
      initializeForwarding(webhookModule.outboundService, webhookModule.fallbackService);

      logger.info('Webhook integration module initialized');
    } catch (err) {
      logger.warn('Webhook module initialization failed — webhooks disabled', { error: err });
    }

    // Internal RAG search endpoint for n8n (independent of webhook module)
    apiRouter.use('/internal/rag', ragSearchRoutes);

    initializeSocketIO(httpServer);

    // Register channel adapters and mount channel webhook routes
    registerChannelAdapter(telegramAdapter);
    registerChannelAdapter(messengerAdapter);
    registerChannelAdapter(instagramAdapter);
    apiRouter.use(channelWebhookRoutes);
    apiRouter.use('/channels', channelManagementRoutes);
    apiRouter.use('/channels/meta/oauth', metaOAuthRoutes); // Authenticated routes (url, pages, connect)
    // Note: OAuth callback mounted at app level before Clerk for unauthenticated Facebook redirect
    logger.info('Channel adapters registered: telegram, messenger, instagram');

    // Cleanup old webhook event logs and message deliveries (7-day retention)
    const cleanupChannelLogs = async () => {
      try {
        const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
        await AppDataSource.query(
          `DELETE FROM "webhook_event_log" WHERE "createdAt" < $1 AND "status" IN ('processed', 'skipped')`,
          [cutoff],
        );
        await AppDataSource.query(
          `DELETE FROM "message_deliveries" WHERE "createdAt" < $1 AND "status" IN ('sent', 'delivered', 'read')`,
          [cutoff],
        );
      } catch (error) {
        logger.error('Channel event log cleanup failed', { error });
      }
    };
    setInterval(cleanupChannelLogs, 24 * 60 * 60 * 1000);

    // Audit log cleanup — batched to avoid table locks
    const cleanupAuditLogs = async () => {
      try {
        let totalDeleted = 0;
        let batchDeleted: number;

        do {
          const deletedRows: Array<{ id: string }> = await AppDataSource.query(
            `DELETE FROM audit_logs WHERE id IN (
              SELECT id FROM audit_logs
              WHERE created_at < NOW() - ($1 || ' days')::INTERVAL
              ORDER BY created_at ASC
              LIMIT 1000
            )
            RETURNING id`,
            [config.audit.retentionDays]
          );
          batchDeleted = deletedRows.length;
          totalDeleted += batchDeleted;
        } while (batchDeleted === 1000);

        if (totalDeleted > 0) {
          logger.info('Audit log cleanup complete', { deletedCount: totalDeleted });
        }
      } catch (error) {
        logger.error('Audit log cleanup failed', { error });
      }
    };

    // Run cleanup after 10 seconds, then every 24 hours
    setTimeout(cleanupAuditLogs, 10_000);
    setInterval(cleanupAuditLogs, 24 * 60 * 60 * 1000);

    const PORT = config.server.port;
    httpServer.listen(PORT, () => {
      logger.info(`Server running on port ${PORT}`);
      logger.info(`Health check: http://localhost:${PORT}/health`);
    });
  } catch (error) {
    logger.error('Failed to start server:', error);
    process.exit(1);
  }
}

// Graceful shutdown
async function shutdown(signal: string): Promise<void> {
  logger.info(`Received ${signal}. Shutting down...`);
  httpServer.close();

  try {
    if (AppDataSource.isInitialized) await AppDataSource.destroy();
    await closeRedis();
    logger.info('Graceful shutdown completed');
    process.exit(0);
  } catch (error) {
    logger.error('Error during shutdown:', error);
    process.exit(1);
  }
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('uncaughtException', (err) => {
  logger.error('Uncaught exception:', err);
  shutdown('uncaughtException');
});
process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled rejection:', reason);
});

// Only start the server when running directly (not when imported by tests)
if (process.env.NODE_ENV !== 'test') {
  startServer();
}
export { app };
export default httpServer;
