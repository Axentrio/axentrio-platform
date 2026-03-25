/**
 * Error Handling Middleware
 * Centralized error handling with proper logging
 */

import { Request, Response, NextFunction } from 'express';
import { logger } from '../utils/logger';
import { config } from '../config/environment';

// Custom API Error class
export class ApiError extends Error {
  public readonly statusCode: number;
  public readonly code: string;
  public readonly details?: Record<string, unknown>;
  public readonly isOperational: boolean;

  constructor(
    message: string,
    statusCode: number = 500,
    code: string = 'INTERNAL_ERROR',
    details?: Record<string, unknown>,
    isOperational: boolean = true
  ) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    this.isOperational = isOperational;

    Error.captureStackTrace(this, this.constructor);
  }
}

// Specific error types
export class BadRequestError extends ApiError {
  constructor(message: string = 'Bad request', details?: Record<string, unknown>) {
    super(message, 400, 'BAD_REQUEST', details);
  }
}

export class UnauthorizedError extends ApiError {
  constructor(message: string = 'Unauthorized') {
    super(message, 401, 'UNAUTHORIZED');
  }
}

export class ForbiddenError extends ApiError {
  constructor(message: string = 'Forbidden') {
    super(message, 403, 'FORBIDDEN');
  }
}

export class NotFoundError extends ApiError {
  constructor(message: string = 'Resource not found') {
    super(message, 404, 'NOT_FOUND');
  }
}

export class ConflictError extends ApiError {
  constructor(message: string = 'Conflict', details?: Record<string, unknown>) {
    super(message, 409, 'CONFLICT', details);
  }
}

export class ValidationError extends ApiError {
  constructor(message: string = 'Validation failed', details?: Record<string, unknown>) {
    super(message, 422, 'VALIDATION_ERROR', details);
  }
}

export class RateLimitError extends ApiError {
  constructor(message: string = 'Rate limit exceeded', details?: Record<string, unknown>) {
    super(message, 429, 'RATE_LIMIT_EXCEEDED', details);
  }
}

// Error response interface
interface ErrorResponse {
  success: false;
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
    stack?: string;
  };
  meta: {
    timestamp: string;
    requestId: string;
    path: string;
  };
}

/**
 * Global error handler middleware
 */
export const errorHandler = (
  err: Error | ApiError,
  req: Request,
  res: Response,
  _next: NextFunction
): void => {
  // Determine if it's an operational error
  const isApiError = err instanceof ApiError;
  const statusCode = isApiError ? err.statusCode : 500;
  const errorCode = isApiError ? err.code : 'INTERNAL_ERROR';
  const isOperational = isApiError ? err.isOperational : false;

  // Log error
  const logData = {
    requestId: req.requestId,
    statusCode,
    errorCode,
    message: err.message,
    path: req.path,
    method: req.method,
    isOperational,
    stack: err.stack,
    userId: req.user?.id,
    tenantId: req.tenant?.id || req.user?.tenantId,
  };

  if (statusCode >= 500) {
    logger.error('Server error', logData);
  } else if (statusCode >= 400) {
    logger.warn('Client error', logData);
  }

  // Build error response
  const errorResponse: ErrorResponse = {
    success: false,
    error: {
      code: errorCode,
      message: isOperational || config.server.isDevelopment
        ? err.message
        : 'An unexpected error occurred',
    },
    meta: {
      timestamp: new Date().toISOString(),
      requestId: req.requestId || '',
      path: req.path,
    },
  };

  // Add details for operational errors
  if (isApiError && err.details) {
    errorResponse.error.details = err.details;
  }

  // Add stack trace in development
  if (config.server.isDevelopment && err.stack) {
    errorResponse.error.stack = err.stack;
  }

  res.status(statusCode).json(errorResponse);
};

/**
 * 404 Not Found handler
 */
export const notFoundHandler = (req: Request, res: Response): void => {
  logger.warn('Route not found', {
    requestId: req.requestId,
    path: req.path,
    method: req.method,
  });

  res.status(404).json({
    success: false,
    error: {
      code: 'NOT_FOUND',
      message: `Route ${req.method} ${req.path} not found`,
    },
    meta: {
      timestamp: new Date().toISOString(),
      requestId: req.requestId || '',
      path: req.path,
    },
  });
};

/**
 * Async handler wrapper
 * Wraps async route handlers to catch errors
 */
export const asyncHandler = (
  fn: (req: Request, res: Response, next: NextFunction) => Promise<void>
) => {
  return (req: Request, res: Response, next: NextFunction): void => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
};

/**
 * Unhandled rejection handler
 */
export const handleUnhandledRejection = (reason: unknown, _promise: Promise<unknown>): void => {
  logger.error('Unhandled Rejection', {
    reason: reason instanceof Error ? reason.message : String(reason),
    stack: reason instanceof Error ? reason.stack : undefined,
  });
  // Application should exit and be restarted by process manager
  process.exit(1);
};

/**
 * Uncaught exception handler
 */
export const handleUncaughtException = (error: Error): void => {
  logger.error('Uncaught Exception', {
    message: error.message,
    stack: error.stack,
  });
  // Application should exit and be restarted by process manager
  process.exit(1);
};

/**
 * Graceful shutdown handler
 */
export const handleGracefulShutdown = (server: { close: (callback: () => void) => void }): void => {
  logger.info('Received shutdown signal, starting graceful shutdown...');

  server.close(() => {
    logger.info('HTTP server closed');
    process.exit(0);
  });

  // Force shutdown after 30 seconds
  setTimeout(() => {
    logger.error('Forced shutdown due to timeout');
    process.exit(1);
  }, 30000);
};

export default {
  errorHandler,
  notFoundHandler,
  asyncHandler,
  handleUnhandledRejection,
  handleUncaughtException,
  handleGracefulShutdown,
  ApiError,
  BadRequestError,
  UnauthorizedError,
  ForbiddenError,
  NotFoundError,
  ConflictError,
  ValidationError,
  RateLimitError,
};
