/**
 * Middleware Index
 * Export all middleware functions
 */
import { Request, Response, NextFunction } from 'express';
import { ForbiddenError } from './error-handler';

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
export function requireAdmin(req: Request, _res: Response, next: NextFunction): void {
  if (!req.user || (req.user.role !== 'admin' && req.user.role !== 'super_admin')) {
    return next(new ForbiddenError('Admin access required'));
  }
  next();
}

export { requireSuperAdmin, resolveTenantContext } from './super-admin.middleware';

// Re-export error classes and asyncHandler from error-handler so there is a
// single canonical class identity. Routes that import these from '../middleware'
// get the same classes as routes that import from '../middleware/error-handler',
// so `err instanceof ApiError` checks in the global error handler always match.
export {
  asyncHandler,
  ApiError,
  BadRequestError,
  UnauthorizedError,
  ForbiddenError,
  NotFoundError,
  ConflictError,
  ValidationError,
  RateLimitError,
} from './error-handler';
