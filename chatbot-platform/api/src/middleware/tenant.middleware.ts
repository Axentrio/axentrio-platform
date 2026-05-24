/**
 * Tenant Middleware
 * Extracts and validates tenant from requests
 */
import { Request, Response, NextFunction } from 'express';
import { logger } from '../utils/logger';
import { AppDataSource } from '../database/data-source';
import { Tenant } from '../database/entities/Tenant';
import type { RequestTenant } from '../types';
import { AuthenticatedRequest, AuthenticatedSocket } from './auth.middleware';
import {
  BadRequestError,
  ForbiddenError,
  NotFoundError,
} from './error-handler';
import { resolveBotKey, type ResolvedBot } from '../services/bot-resolution.service';

const tenantRepository = AppDataSource.getRepository(Tenant);

export interface TenantRequest extends AuthenticatedRequest {
  tenant?: RequestTenant;
}

export interface TenantSocket extends AuthenticatedSocket {
  data: AuthenticatedSocket['data'] & {
    tenant?: RequestTenant;
  };
}

/**
 * Extract tenant ID from request
 * Priority: Header > Query param > User context
 */
function extractTenantId(req: Request): string | null {
  // Check X-Tenant-ID header
  const headerTenantId = req.headers['x-tenant-id'] as string;
  if (headerTenantId) {
    return headerTenantId;
  }

  // Check query parameter
  const queryTenantId = req.query.tenantId as string;
  if (queryTenantId) {
    return queryTenantId;
  }

  // Check authenticated user context
  if (req.user?.tenantId) {
    return req.user.tenantId;
  }

  return null;
}

/**
 * HTTP Middleware: Validate and attach tenant
 */
export async function validateTenant(
  req: TenantRequest,
  _res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const tenantId = extractTenantId(req);

    if (!tenantId) {
      return next(new BadRequestError('Bad Request: Tenant ID required'));
    }

    // Validate UUID format
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(tenantId)) {
      return next(new BadRequestError('Bad Request: Invalid tenant ID format'));
    }

    // Fetch tenant from database
    const tenant = await tenantRepository.findOne({
      where: { id: tenantId, status: 'active' as const },
    });

    if (!tenant) {
      return next(new NotFoundError('Not Found: Tenant not found or inactive'));
    }

    // For authenticated requests, verify user belongs to tenant
    if (req.user && req.user.tenantId !== tenantId) {
      return next(new ForbiddenError('Forbidden: User does not belong to tenant'));
    }

    // Attach tenant to request
    req.tenant = tenant;
    next();
  } catch (error) {
    return next(error as Error);
  }
}

/**
 * HTTP Middleware: Extract tenant without validation (optional)
 */
export async function extractTenant(
  req: TenantRequest,
  _res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const tenantId = extractTenantId(req);

    if (tenantId) {
      const tenant = await tenantRepository.findOne({
        where: { id: tenantId, status: 'active' as const },
      });

      if (tenant) {
        req.tenant = tenant;
      }
    }

    next();
  } catch (error) {
    logger.error('Tenant extraction error:', error);
    // Continue without tenant - don't block request
    next();
  }
}

/**
 * WebSocket Middleware: Validate tenant for socket connections
 */
export async function validateSocketTenant(
  socket: TenantSocket,
  next: (err?: Error) => void
): Promise<void> {
  try {
    // Get tenant ID from socket handshake or user context
    const tenantId =
      (socket.handshake.query.tenantId as string) || socket.data.user?.tenantId;

    if (!tenantId) {
      return next(new Error('Tenant validation error: Tenant ID required'));
    }

    // Validate UUID format
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(tenantId)) {
      return next(new Error('Tenant validation error: Invalid tenant ID format'));
    }

    // Fetch tenant from database
    const tenant = await tenantRepository.findOne({
      where: { id: tenantId, status: 'active' as const },
    });

    if (!tenant) {
      return next(new Error('Tenant validation error: Tenant not found or inactive'));
    }

    // Verify user belongs to tenant
    if (socket.data.user && socket.data.user.tenantId !== tenantId) {
      return next(new Error('Tenant validation error: User does not belong to tenant'));
    }

    // Attach tenant to socket data
    socket.data.tenantId = tenantId;
    socket.data.tenant = tenant;

    logger.debug(`Socket tenant validated: ${tenantId}`);
    next();
  } catch (error) {
    logger.error('Socket tenant validation error:', error);
    next(new Error('Tenant validation error: Internal server error'));
  }
}

/**
 * Get tenant by API key.
 *
 * Kept for backwards compatibility — resolves strictly against
 * `Tenant.apiKey` (the legacy embed). New code should prefer
 * `resolveBotByKey` (or `resolveBotKey` directly from the service) so it
 * can attribute traffic to a specific bot.
 */
export async function getTenantByApiKey(apiKey: string): Promise<Tenant | null> {
  try {
    return await tenantRepository.findOne({
      where: { apiKey, status: 'active' as const },
    });
  } catch (error) {
    logger.error('Error fetching tenant by API key:', error);
    return null;
  }
}

/**
 * Resolve a widget-embedded key (`bk_*` Bot.publicKey OR legacy
 * `Tenant.apiKey`) to `{ tenant, bot, isAnchorViaLegacyKey }`. Returns
 * `null` for unknown keys, soft-deleted bots, and suspended tenants.
 *
 * Paused bots are returned with `bot.status === 'paused'` — callers decide
 * the response. See `resolveBotKeyStrict` for an exception-based variant.
 */
export async function resolveBotByKey(key: string): Promise<ResolvedBot | null> {
  try {
    return await resolveBotKey(key);
  } catch (error) {
    logger.error('Error resolving bot by key:', error);
    return null;
  }
}
