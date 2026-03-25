/**
 * Winston Logger Configuration
 * Provides structured logging for the application
 */
import winston from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';
import { config } from '../config/environment';

// Define log format
const logFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.errors({ stack: true }),
  winston.format.splat(),
  winston.format.json()
);

// Console format for development
const consoleFormat = winston.format.combine(
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

// Create transports array
const transports: winston.transport[] = [
  // Console transport
  new winston.transports.Console({
    format: config.server.isProduction ? logFormat : consoleFormat,
  }),
];

// Add file transports in production
if (config.server.isProduction) {
  transports.push(
    new winston.transports.File({
      filename: `${config.logging.dir}/error.log`,
      level: 'error',
      format: logFormat,
    }),
    new winston.transports.File({
      filename: `${config.logging.dir}/combined.log`,
      format: logFormat,
    })
  );
}

// Create logger instance
export const logger = winston.createLogger({
  level: config.logging.level,
  defaultMeta: {
    service: 'chatbot-platform-api',
    environment: config.server.env,
  },
  transports,
  exitOnError: false,
});

// Add daily rotate file transport in production
if (config.server.isProduction) {
  logger.add(new DailyRotateFile({
    filename: `${config.logging.dir}/app-%DATE%.log`,
    datePattern: 'YYYY-MM-DD',
    maxFiles: `${config.logging.maxFiles}d`,
    format: logFormat,
  }));
}

// Stream for Morgan HTTP logging
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
