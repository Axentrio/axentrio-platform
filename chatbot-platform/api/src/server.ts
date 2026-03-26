/**
 * Chatbot Platform API Server
 * Express + Socket.io with Redis adapter for multi-server scaling
 */
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
import { requireClerkAuth, autoProvision } from './middleware/clerk.middleware';

// Webhook integration
import { createWebhookModule } from './n8n';
import { initializeForwarding } from './services/message-forwarding.service';
import { EventEmitter } from './utils/event-emitter';

// Middleware
import { rateLimitByIp } from './middleware/rate-limit.middleware';
import { errorHandler, notFoundHandler } from './middleware/error-handler';

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
apiRouter.use('/auth', authRoutes);
apiRouter.use('/chats', chatRoutes);
apiRouter.use('/handoffs', handoffRoutes);
apiRouter.use('/agents', agentRoutes);
apiRouter.use('/users', userRoutes);
apiRouter.use('/tenants', tenantRoutes);
apiRouter.use('/widget', widgetRoutes);
apiRouter.use('/files', fileRoutes);
apiRouter.use('/analytics', analyticsRoutes);
apiRouter.use('/notifications', notificationRoutes);
apiRouter.use('/tenants/me/webhooks', requireClerkAuth, autoProvision, webhookAdminRoutes);
apiRouter.use('/admin', adminRoutes);

app.use('/api/v1', apiRouter);

// Error handlers (must be last)
app.use(notFoundHandler);
app.use(errorHandler);

// Boot sequence
async function startServer(): Promise<void> {
  try {
    logger.info('Starting Chatbot Platform API...');

    await AppDataSource.initialize();
    logger.info('Database connection established');

    await initializeRedis();

    // Initialize Bull queue (depends on Redis — graceful fallback if unavailable)
    try {
      const { initializeQueues } = await import('./queue/message-queue');
      await initializeQueues();
      logger.info('Message queue initialized');
    } catch (err) {
      logger.warn('Queue initialization failed, falling back to synchronous processing', { error: err });
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

    initializeSocketIO(httpServer);

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

startServer();
export { app };
export default httpServer;
