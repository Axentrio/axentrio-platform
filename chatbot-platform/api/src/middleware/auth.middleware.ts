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

export interface AuthenticatedRequest extends Request {
  user?: RequestUser;
}

export interface AuthenticatedSocket extends Socket {
  data: {
    user?: RequestUser;
    tenantId?: string;
    sessionId?: string;
  };
}

// JWT payload interface
interface JWTPayload {
  userId: string;
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
      email: `widget-${sessionId}@session.local`,
      role: 'widget',
      tenantId,
      type: 'widget',
    },
    config.jwt.secret,
    { expiresIn: '7d' } // Widget sessions last longer
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
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      res.status(401).json({ error: 'Unauthorized: No token provided' });
      return;
    }

    const token = authHeader.substring(7);
    const payload = verifyToken(token);

    // Ensure it's an agent token
    if (payload.type !== 'agent') {
      res.status(403).json({ error: 'Forbidden: Invalid token type' });
      return;
    }

    // Verify agent still exists and is active
    const agent = await agentRepository.findOne({
      where: { id: payload.userId },
    });

    if (!agent) {
      res.status(401).json({ error: 'Unauthorized: Agent not found or inactive' });
      return;
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
    if (error instanceof jwt.JsonWebTokenError) {
      res.status(401).json({ error: 'Unauthorized: Invalid token' });
      return;
    }
    if (error instanceof jwt.TokenExpiredError) {
      res.status(401).json({ error: 'Unauthorized: Token expired' });
      return;
    }
    logger.error('Authentication error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * HTTP Middleware: Authenticate widget requests
 */
export async function authenticateWidget(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      res.status(401).json({ error: 'Unauthorized: No token provided' });
      return;
    }

    const token = authHeader.substring(7);
    const payload = verifyToken(token);

    // Ensure it's a widget token
    if (payload.type !== 'widget') {
      res.status(403).json({ error: 'Forbidden: Invalid token type' });
      return;
    }

    // Attach user info to request
    req.user = {
      id: payload.userId,
      email: payload.email,
      role: 'agent' as UserRole,
      tenantId: payload.tenantId,
      type: 'widget',
    };

    next();
  } catch (error) {
    if (error instanceof jwt.JsonWebTokenError) {
      res.status(401).json({ error: 'Unauthorized: Invalid token' });
      return;
    }
    if (error instanceof jwt.TokenExpiredError) {
      res.status(401).json({ error: 'Unauthorized: Token expired' });
      return;
    }
    logger.error('Widget authentication error:', error);
    res.status(500).json({ error: 'Internal server error' });
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
    if (error instanceof jwt.JsonWebTokenError) {
      return next(new Error('Authentication error: Invalid token'));
    }
    if (error instanceof jwt.TokenExpiredError) {
      return next(new Error('Authentication error: Token expired'));
    }
    logger.error('Socket authentication error:', error);
    next(new Error('Authentication error: Internal server error'));
  }
}

/**
 * Middleware: Require specific role
 */
export function requireRole(...allowedRoles: string[]) {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({ error: 'Unauthorized: No user found' });
      return;
    }

    if (!allowedRoles.includes(req.user.role)) {
      res.status(403).json({ error: 'Forbidden: Insufficient permissions' });
      return;
    }

    next();
  };
}
