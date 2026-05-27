/**
 * Winston Logger Configuration
 * Structured JSON logging for Railway (stdout-only in production)
 */
import winston from 'winston';
import { config } from '../config/environment';

// JSON format for production (Railway log drain captures stdout)
const prodFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.errors({ stack: true }),
  winston.format.splat(),
  winston.format.json()
);

// Colorized console format for development
const devFormat = winston.format.combine(
  winston.format.colorize(),
  winston.format.timestamp({ format: 'HH:mm:ss' }),
  winston.format.printf(({ level, message, timestamp, ...metadata }) => {
    let msg = `${timestamp} [${level}]: ${message}`;
    if (Object.keys(metadata).length > 0) {
      msg += ` ${JSON.stringify(metadata)}`;
    }
    return msg;
  })
);

// Single console transport — Railway captures stdout automatically
const transport = new winston.transports.Console({
  format: config.server.isProduction ? prodFormat : devFormat,
});

transport.on('error', (err) => {
  const message = err instanceof Error ? err.stack || err.message : String(err);
  process.stderr.write(`Winston transport error: ${message}\n`);
});

export const logger = winston.createLogger({
  level: config.logging.level,
  defaultMeta: {
    service: 'chatbot-platform-api',
    environment: config.server.env,
  },
  transports: [transport],
  exitOnError: false,
});

// Keep the export for compatibility with utils/index.ts
export const morganStream = {
  write: (message: string): void => {
    logger.info(message.trim());
  },
};

// Helper functions for common log patterns
export const logRequest = (req: { method: string; url: string; ip?: string }, message?: string): void => {
  logger.info(message || 'Incoming request', {
    method: req.method,
    url: req.url,
    ip: req.ip,
  });
};

export const logError = (error: Error, context?: Record<string, unknown>): void => {
  logger.error(error.message, {
    stack: error.stack,
    ...context,
  });
};

export const logSocketEvent = (event: string, socketId: string, data?: Record<string, unknown>): void => {
  logger.debug(`Socket event: ${event}`, {
    socketId,
    ...data,
  });
};

export default logger;
