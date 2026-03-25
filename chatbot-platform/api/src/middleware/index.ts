/**
 * Middleware Index
 * Export all middleware functions
 */
import { Request, Response, NextFunction } from 'express';

export {
  authenticateAgent,
  authenticateWidget,
  authenticateSocket,
  requireRole,
  verifyToken,
  generateAgentToken,
  generateWidgetToken,
  AuthenticatedRequest,
  AuthenticatedSocket,
} from './auth.middleware';

export {
  validateTenant,
  extractTenant,
  validateSocketTenant,
  getTenantByApiKey,
  TenantRequest,
  TenantSocket,
} from './tenant.middleware';

export {
  rateLimit,
  rateLimitByIp,
  rateLimitByTenant,
  rateLimitWidget,
  checkSocketRateLimit,
  getRateLimitStatus,
} from './rate-limit.middleware';

export {
  requireClerkAuth,
  autoProvision,
  resolveClerkIds,
  ProvisionedRequest,
} from './clerk.middleware';

// Aliases for compatibility
export { authenticateAgent as authenticateJwt } from './auth.middleware';

// Rate limiter alias
export { rateLimitByIp as loginRateLimiter } from './rate-limit.middleware';

// Alias for admin role check
export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  const user = (req as any).user;
  if (!user || user.role !== 'admin') {
    res.status(403).json({ error: 'Forbidden: Admin access required' });
    return;
  }
  next();
}

// Async handler wrapper
export function asyncHandler(fn: (req: Request, res: Response, next: NextFunction) => Promise<any>) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

// Error classes
export class ValidationError extends Error {
  statusCode = 400;
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

export class UnauthorizedError extends Error {
  statusCode = 401;
  constructor(message: string = 'Unauthorized') {
    super(message);
    this.name = 'UnauthorizedError';
  }
}

export class NotFoundError extends Error {
  statusCode = 404;
  constructor(message: string = 'Not Found') {
    super(message);
    this.name = 'NotFoundError';
  }
}

export class ForbiddenError extends Error {
  statusCode = 403;
  constructor(message: string = 'Forbidden') {
    super(message);
    this.name = 'ForbiddenError';
  }
}
