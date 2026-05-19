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
import { initializeRedis, closeRedis, isRedisAvailable } from './config/redis';
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
import billingRoutes from './routes/billing.routes';
import knowledgeRoutes from './knowledge/knowledge.routes';
import aiSettingsRoutes from './knowledge/ai-settings.routes';
import widgetAppearanceRoutes from './widget/widget-appearance.routes';
import { widgetVersionHash, widgetPath as widgetJsPath } from './widget/widget-version';
import integrationsRoutes from './knowledge/integrations.routes';
import cannedResponseRoutes from './routes/canned-responses.routes';
import skillsRoutes from './routes/skills.routes';
import automationsRoutes from './routes/automations.routes';
import sessionManagementRoutes from './routes/session-management.routes';
import { requireClerkAuth, autoProvision } from './middleware/clerk.middleware';

// Webhook integration
import { createWebhookModule } from './n8n';
import { initializeForwarding, initializeAgentService } from './services/message-forwarding.service';
import ragSearchRoutes from './n8n/rag-search.routes';
import bookingRoutes from './n8n/booking.routes';
import { EventEmitter } from './utils/event-emitter';

// Platform agent
import { ToolRegistry } from './agent/tool-registry';
import { PromptBuilder } from './agent/prompt-builder';
import { MeteringService } from './agent/metering.service';
import { TraceLogger } from './agent/trace-logger';
import { AgentService } from './agent/agent.service';

// Channel integrations
import metaWebhookRoutes from './channels/meta/webhook.routes';
import { billingWebhookRoutes } from './webhooks/billing-webhook.routes';
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
  });
});

// Clerk webhook — must use raw body parser, registered before express.json()
// Narrowed to /clerk sub-path to avoid consuming body for other /webhooks/* routes
app.use('/api/v1/webhooks/clerk', express.raw({ type: 'application/json' }), clerkWebhookRoutes);

// Meta webhook — must use raw body parser for HMAC verification
app.use('/api/v1/channels/meta/webhook', express.raw({ type: 'application/json' }), metaWebhookRoutes);

// Billing webhooks — must use raw body parser for HMAC verification.
// Mount BEFORE app-level express.json() so verifyWebhook receives the raw
// Buffer intact. See § Webhook event handling middleware ordering invariant
// in .scratch/plan-billing.md.
app.use('/api/v1/webhooks/billing', express.raw({ type: 'application/json' }), billingWebhookRoutes);

// Request ID — must come before any routes so every response (including widget
// routes mounted below and the /widget.js static serve) carries x-request-id
// and req.requestId is available to handlers and the global error handler.
app.use(requestIdMiddleware);

// Serve widget.js — before all middleware (no auth, open CORS, cached).
// Single canonical source: chatbot-platform/api/public/widget.js. The Docker
// build copies it via `COPY api/ .` + `COPY /app/public ./public`, and local
// dev (ts-node-dev) resolves the same path because __dirname is api/src.
//
// Cache strategy: short max-age + ETag derived from a SHA-256 of the file
// bytes computed at boot. Browsers revalidate every 5 minutes; on an unchanged
// deploy the ETag matches and the response is 304 (no payload). On a real
// edit the hash changes, so embeds pick up the new bytes within 5 minutes
// instead of the old 1-hour stale window. Customers who want strict
// cache-busting can embed `<script src=".../widget.js?v=<widgetVersion>">`
// — the query string is informational; same file is served either way.
const widgetEtag = `"${widgetVersionHash}"`;
app.get('/widget.js', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  res.setHeader('Cache-Control', 'public, max-age=300, must-revalidate');
  res.setHeader('ETag', widgetEtag);
  res.setHeader('Content-Type', 'application/javascript');

  if (req.headers['if-none-match'] === widgetEtag) {
    res.status(304).end();
    return;
  }

  res.sendFile(widgetJsPath, (err) => {
    if (err) {
      logger.error('Failed to serve widget.js', { path: widgetJsPath, error: err.message });
      res.status(404).send('// widget.js not found');
    }
  });
});

// Widget API — open CORS for cross-origin embedding on customer sites
// Must be before helmet/CSP which sets restrictive CORP headers
app.use('/api/v1/widget', (req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  next();
}, express.json(), widgetRoutes);

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
      ? ['http://localhost:4080', 'http://localhost:3000', 'http://localhost:5173', 'http://localhost:8888']
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
apiRouter.use('/chats', sessionManagementRoutes);
apiRouter.use('/handoffs', handoffRoutes);
apiRouter.use('/agents', agentRoutes);
apiRouter.use('/users', userRoutes);
apiRouter.use('/tenants', tenantRoutes);
apiRouter.use('/widget', widgetRoutes);
apiRouter.use('/files', fileRoutes);
apiRouter.use('/notifications', notificationRoutes);
apiRouter.use('/tenants/me/webhooks', requireClerkAuth, autoProvision, webhookAdminRoutes);
apiRouter.use('/admin', adminRoutes);
apiRouter.use('/billing', billingRoutes);
apiRouter.use('/knowledge', knowledgeRoutes);
apiRouter.use('/canned-responses', cannedResponseRoutes);
apiRouter.use('/tenants/me', aiSettingsRoutes);
apiRouter.use('/tenants/me', widgetAppearanceRoutes);
apiRouter.use('/tenants/me', integrationsRoutes);
apiRouter.use('/tenants', skillsRoutes);
apiRouter.use('/tenants', automationsRoutes);

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
    if (config.server.isProduction && !isRedisAvailable()) {
      throw new Error('Redis is required in production but failed to connect');
    }

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

    // Register Stripe billing provider — boot env validation already
    // guaranteed the secret/webhook/price IDs are present outside test.
    try {
      const { StripeBillingProvider } = await import('./billing/providers/stripe');
      const { registerBillingProvider } = await import('./billing/provider-registry');
      registerBillingProvider(new StripeBillingProvider());
      logger.info('Stripe billing provider registered');
    } catch (err) {
      logger.error('Stripe billing provider registration failed', { error: err });
      if (config.server.isProduction) {
        throw err;
      }
    }

    // Register billing trial-expiry processor + daily safety-net sweep.
    // The sweep is the *authoritative* recovery path for trial expiry; the
    // per-tenant delayed job is just a latency optimization. If the sweep
    // can't be registered in production, the system is silently broken —
    // fail startup so deploys catch it immediately.
    // Plan: .scratch/plan-billing.md § Implementation outline step 5.
    try {
      const { registerTrialExpiryProcessor, scheduleDailySweep } = await import(
        './billing/trial-expiry-job'
      );
      registerTrialExpiryProcessor();
      await scheduleDailySweep();
      logger.info('Billing trial-expiry processor + daily sweep registered');
    } catch (err) {
      logger.error('Billing trial-expiry registration failed', { error: err });
      if (config.server.isProduction) {
        throw new Error(
          `Billing trial-expiry sweep failed to register: ${
            err instanceof Error ? err.message : String(err)
          }. Sweep is the authoritative recovery path; refusing to start in production.`,
        );
      }
    }

    // Initialize webhook integration module
    try {
      const webhookModule = createWebhookModule({
        redisUrl: config.redis.url || `redis://${config.redis.host}:${config.redis.port}`,
        circuitBreaker: {
          failureThreshold: parseInt(process.env.N8N_CIRCUIT_BREAKER_THRESHOLD || '5'),
          successThreshold: parseInt(process.env.N8N_CIRCUIT_BREAKER_SUCCESS || '3'),
          timeout: parseInt(process.env.N8N_CIRCUIT_BREAKER_TIMEOUT || '30000'),
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

    // Initialize platform agent service
    try {
      const { getRedisClient } = await import('./config/redis');
      const redisClient = getRedisClient();
      const toolRegistry = new ToolRegistry();
      const promptBuilder = new PromptBuilder();
      const metering = new MeteringService(redisClient as any);
      const traceLogger = new TraceLogger();
      const agentSvc = new AgentService(toolRegistry, promptBuilder, metering, traceLogger);
      initializeAgentService(agentSvc);
      logger.info('Platform agent service initialized');
    } catch (err) {
      logger.warn('Platform agent initialization failed — agent path disabled', { error: err });
    }

    // Initialize automation engine
    try {
      const { initializeAutomations } = await import('./automations');
      initializeAutomations();
      logger.info('Automation engine initialized');
    } catch (err) {
      logger.warn('Automation engine initialization failed', { error: err });
    }

    // Internal RAG search endpoint for n8n (independent of webhook module)
    apiRouter.use('/internal/rag', ragSearchRoutes);

    // Internal booking endpoints for n8n
    apiRouter.use('/internal/booking', bookingRoutes);

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

    // Auto-close stale sessions — sessions with no activity for 30 minutes
    // Batched to avoid locking many rows at once under load.
    const STALE_BATCH_SIZE = 200;
    const STALE_MAX_BATCHES = 50; // Cap at 10k sessions per run
    const autoCloseStaleSessions = async () => {
      try {
        const cutoff = new Date(Date.now() - 30 * 60 * 1000); // 30 minutes
        let totalClosed = 0;
        let batchClosed: number;
        let batches = 0;
        do {
          const rows: Array<{ id: string }> = await AppDataSource.query(
            `UPDATE chat_sessions
             SET status = 'closed', ended_at = NOW(), updated_at = NOW()
             WHERE id IN (
               SELECT id FROM chat_sessions
               WHERE status IN ('bot', 'waiting')
               AND last_activity_at < $1
               AND last_activity_at IS NOT NULL
               LIMIT $2
               FOR UPDATE SKIP LOCKED
             )
             RETURNING id`,
            [cutoff, STALE_BATCH_SIZE]
          );
          batchClosed = Array.isArray(rows) ? rows.length : 0;
          totalClosed += batchClosed;
          batches++;
        } while (batchClosed === STALE_BATCH_SIZE && batches < STALE_MAX_BATCHES);

        if (totalClosed > 0) {
          logger.info(`Auto-closed ${totalClosed} stale sessions`);
        }
      } catch (error) {
        logger.error('Stale session cleanup failed', { error });
      }
    };
    setInterval(autoCloseStaleSessions, 5 * 60 * 1000); // Run every 5 minutes

    // Cleanup old agent traces (30-day retention)
    const cleanupAgentTraces = async () => {
      try {
        const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
        await AppDataSource.query(
          `DELETE FROM agent_traces WHERE created_at < $1`,
          [cutoff]
        );
      } catch (error) {
        logger.error('Agent trace cleanup failed', { error });
      }
    };
    setInterval(cleanupAgentTraces, 24 * 60 * 60 * 1000); // Daily

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
let isShuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;

  logger.info(`Received ${signal}. Starting graceful shutdown...`);

  // Force exit after 30s if graceful shutdown stalls
  const forceExit = setTimeout(() => {
    logger.error('Graceful shutdown timed out, forcing exit');
    process.exit(1);
  }, 30000);

  httpServer.close(() => {
    logger.info('HTTP server stopped accepting new connections');
  });

  try {
    if (AppDataSource.isInitialized) await AppDataSource.destroy();
    await closeRedis();
    clearTimeout(forceExit);
    logger.info('Graceful shutdown completed');
    process.exit(0);
  } catch (error) {
    logger.error('Error during shutdown:', error);
    clearTimeout(forceExit);
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
  shutdown('unhandledRejection');
});

// Only start the server when running directly (not when imported by tests)
if (process.env.NODE_ENV !== 'test') {
  startServer();
}
export { app };
export default httpServer;
