/**
 * Authentication Middleware
 * Handles JWT validation for HTTP requests and WebSocket connections
 */
import { Request, Response, NextFunction } from 'express';
import jwt, { SignOptions } from 'jsonwebtoken';
import { Socket } from 'socket.io';
import { config } from '../config/environment';
import { logger } from '../utils/logger';
import { AppDataSource } from '../database/data-source';
import { Agent } from '../database/entities/Agent';
import type { RequestUser, UserRole } from '../types';
import { UnauthorizedError, ForbiddenError } from './error-handler';

export interface AuthenticatedRequest extends Request {
  user?: RequestUser;
}

export interface AuthenticatedSocket extends Socket {
  data: {
    user?: RequestUser;
    tenantId?: string;
    sessionId?: string;
    participantId?: string;
  };
}

// JWT payload interface
interface JWTPayload {
  userId: string;
  sessionId?: string;
  email: string;
  role: string;
  tenantId: string;
  type: 'agent' | 'widget';
  iat: number;
  exp: number;
}

const agentRepository = AppDataSource.getRepository(Agent);

/**
 * Verify JWT token
 */
export function verifyToken(token: string): JWTPayload {
  return jwt.verify(token, config.jwt.secret, {
    issuer: 'chatbot-platform',
    audience: 'chatbot-api',
  }) as JWTPayload;
}

/**
 * Generate JWT token for agent
 */
export function generateAgentToken(agent: Agent & { user?: { email?: string; role?: string } }): string {
  return jwt.sign(
    {
      userId: agent.id,
      email: agent.user?.email || '',
      role: agent.user?.role || 'agent',
      tenantId: agent.tenantId,
      type: 'agent',
    },
    config.jwt.secret,
    { expiresIn: config.jwt.expiresIn as SignOptions['expiresIn'], issuer: 'chatbot-platform', audience: 'chatbot-api' }
  );
}

/**
 * Generate JWT token for widget session
 */
export function generateWidgetToken(
  sessionId: string,
  tenantId: string,
  userId?: string
): string {
  return jwt.sign(
    {
      userId: userId || sessionId,
      sessionId,
      email: `widget-${sessionId}@session.local`,
      role: 'widget',
      tenantId,
      type: 'widget',
    },
    config.jwt.secret,
    { expiresIn: '7d', issuer: 'chatbot-platform', audience: 'chatbot-api' } // Widget sessions last longer
  );
}

/**
 * Generate refresh token for agent
 */
export function generateRefreshToken(agentId: string): string {
  return jwt.sign(
    { agentId, type: 'refresh' },
    config.jwt.refreshSecret,
    { expiresIn: config.jwt.refreshExpiresIn as SignOptions['expiresIn'], issuer: 'chatbot-platform' }
  );
}

/**
 * Refresh token rotation — verify refresh token and issue new pair
 */
export function refreshTokenRotation(
  refreshToken: string,
  agent: Agent & { user?: { email?: string; role?: string } }
): { accessToken: string; refreshToken: string } | null {
  try {
    const decoded = jwt.verify(refreshToken, config.jwt.refreshSecret, {
      issuer: 'chatbot-platform',
    }) as { agentId: string; type: string };

    if (decoded.type !== 'refresh') return null;

    return {
      accessToken: generateAgentToken(agent),
      refreshToken: generateRefreshToken(decoded.agentId),
    };
  } catch {
    return null;
  }
}

/**
 * HTTP Middleware: Authenticate agent requests
 */
export async function authenticateAgent(
  req: AuthenticatedRequest,
  _res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return next(new UnauthorizedError('Unauthorized: No token provided'));
    }

    const token = authHeader.substring(7);
    const payload = verifyToken(token);

    // Ensure it's an agent token
    if (payload.type !== 'agent') {
      return next(new ForbiddenError('Forbidden: Invalid token type'));
    }

    // Verify agent still exists and is active
    const agent = await agentRepository.findOne({
      where: { id: payload.userId },
    });

    if (!agent) {
      return next(new UnauthorizedError('Unauthorized: Agent not found or inactive'));
    }

    // Attach user info to request
    req.user = {
      id: payload.userId,
      email: payload.email,
      role: payload.role as UserRole,
      tenantId: payload.tenantId,
      type: 'agent',
    };

    next();
  } catch (error) {
    // TokenExpiredError must be checked BEFORE JsonWebTokenError because
    // TokenExpiredError extends JsonWebTokenError; reversing the order makes
    // the expired branch unreachable. (codex round 1 #12)
    if (error instanceof jwt.TokenExpiredError) {
      return next(new UnauthorizedError('Unauthorized: Token expired'));
    }
    if (error instanceof jwt.JsonWebTokenError) {
      return next(new UnauthorizedError('Unauthorized: Invalid token'));
    }
    return next(error as Error);
  }
}

/**
 * HTTP Middleware: Authenticate widget requests
 */
export async function authenticateWidget(
  req: AuthenticatedRequest,
  _res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return next(new UnauthorizedError('Unauthorized: No token provided'));
    }

    const token = authHeader.substring(7);
    const payload = verifyToken(token);

    // Ensure it's a widget token
    if (payload.type !== 'widget') {
      return next(new ForbiddenError('Forbidden: Invalid token type'));
    }

    // Attach user info to request
    req.user = {
      id: payload.userId,
      email: payload.email,
      role: 'agent' as UserRole,
      tenantId: payload.tenantId,
      type: 'widget',
    };

    // Also set req.widget for widget-specific handlers
    req.widget = {
      sessionId: payload.sessionId || payload.userId,
      tenantId: payload.tenantId,
      visitorId: payload.userId,
    };

    next();
  } catch (error) {
    // TokenExpiredError must be checked BEFORE JsonWebTokenError because
    // TokenExpiredError extends JsonWebTokenError; reversing the order makes
    // the expired branch unreachable. (codex round 1 #12)
    if (error instanceof jwt.TokenExpiredError) {
      return next(new UnauthorizedError('Unauthorized: Token expired'));
    }
    if (error instanceof jwt.JsonWebTokenError) {
      return next(new UnauthorizedError('Unauthorized: Invalid token'));
    }
    return next(error as Error);
  }
}

/**
 * WebSocket Middleware: Authenticate socket connections
 */
export async function authenticateSocket(
  socket: AuthenticatedSocket,
  next: (err?: Error) => void
): Promise<void> {
  try {
    const token = socket.handshake.auth.token as string;

    if (!token) {
      return next(new Error('Authentication error: No token provided'));
    }

    const payload = verifyToken(token);

    // For agent connections, verify agent exists and is active
    if (payload.type === 'agent') {
      const agent = await agentRepository.findOne({
        where: { id: payload.userId },
      });

      if (!agent) {
        return next(new Error('Authentication error: Agent not found or inactive'));
      }
    }

    // Attach user info to socket data
    socket.data.user = {
      id: payload.userId,
      email: payload.email,
      role: payload.role as UserRole,
      tenantId: payload.tenantId,
      type: payload.type,
    };

    logger.debug(`Socket authenticated: ${payload.type} - ${payload.userId}`);
    next();
  } catch (error) {
    // TokenExpiredError must be checked BEFORE JsonWebTokenError because
    // TokenExpiredError extends JsonWebTokenError; reversing the order makes
    // the expired branch unreachable. (codex round 1 #12)
    // Socket.IO middleware contract: keep next(new Error(...)). (plan §6.3)
    if (error instanceof jwt.TokenExpiredError) {
      return next(new Error('Authentication error: Token expired'));
    }
    if (error instanceof jwt.JsonWebTokenError) {
      return next(new Error('Authentication error: Invalid token'));
    }
    logger.error('Socket authentication error:', error);
    next(new Error('Authentication error: Internal server error'));
  }
}

/**
 * Middleware: Require specific role
 */
export function requireRole(...allowedRoles: string[]) {
  return (req: AuthenticatedRequest, _res: Response, next: NextFunction): void => {
    if (!req.user) {
      return next(new UnauthorizedError('Unauthorized: No user found'));
    }

    // super_admin bypasses all role checks
    if (req.user.role !== 'super_admin' && !allowedRoles.includes(req.user.role)) {
      return next(new ForbiddenError('Forbidden: Insufficient permissions'));
    }

    next();
  };
}
