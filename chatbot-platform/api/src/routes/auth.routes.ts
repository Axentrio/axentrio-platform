/**
 * Authentication Routes
 * POST /auth/widget - Widget authentication via API key (unchanged)
 * GET /auth/me - Get current user via Clerk auth + auto-provisioning
 */
import { Router, Response } from 'express';
import { AppDataSource } from '../database/data-source';
import { ChatSession } from '../database/entities/ChatSession';
import { logger } from '../utils/logger';
import { generateWidgetToken } from '../middleware/auth.middleware';
import { getTenantByApiKey } from '../middleware/tenant.middleware';
import { rateLimitWidget } from '../middleware/rate-limit.middleware';
import { requireClerkAuth, autoProvision, ProvisionedRequest } from '../middleware/clerk.middleware';
import { asyncHandler, BadRequestError, UnauthorizedError } from '../middleware/error-handler';
import { validate } from '../middleware/validate';
import { sendSuccess } from '../utils/response';
import { widgetAuthSchema } from '../schemas';

const router = Router();
const sessionRepository = AppDataSource.getRepository(ChatSession);

// Widget authentication request body
interface WidgetAuthRequest {
  apiKey: string;
  sessionId?: string;
  userId?: string;
  metadata?: Record<string, unknown>;
}

/**
 * POST /auth/widget
 * Authenticate widget and create/get session
 * Rate limited for security
 */
router.post(
  '/widget',
  rateLimitWidget,
  validate(widgetAuthSchema),
  asyncHandler(async (req: ProvisionedRequest, res: Response) => {
    const { apiKey, sessionId, userId, metadata } = req.body as WidgetAuthRequest;

    if (!apiKey) {
      throw new BadRequestError('API key is required');
    }

    // Validate API key and get tenant
    const tenant = await getTenantByApiKey(apiKey);

    if (!tenant) {
      throw new UnauthorizedError('Invalid API key');
    }

    // Get or create session
    let session: ChatSession;

    if (sessionId) {
      // Try to find existing session
      const existingSession = await sessionRepository.findOne({
        where: { id: sessionId, tenantId: tenant.id },
      });

      if (existingSession && existingSession.isActive()) {
        session = existingSession;
        session.updateActivity();
        await sessionRepository.save(session);
      } else {
        // Create new session if not found or closed
        session = sessionRepository.create({
          tenantId: tenant.id,
          visitorId: userId || 'anonymous',
          status: 'waiting' as const,
          startedAt: new Date(),
          lastActivityAt: new Date(),
          metadata: {
            ...metadata,
            userAgent: req.headers['user-agent'],
            ipAddress: req.ip,
            referrer: req.headers.referer,
          },
        });
        await sessionRepository.save(session);
      }
    } else {
      // Create new session
      session = sessionRepository.create({
        tenantId: tenant.id,
        visitorId: userId || 'anonymous',
        status: 'waiting' as const,
        startedAt: new Date(),
        lastActivityAt: new Date(),
        metadata: {
          ...metadata,
          userAgent: req.headers['user-agent'],
          ipAddress: req.ip,
          referrer: req.headers.referer,
        },
      });
      await sessionRepository.save(session);
    }

    // Generate widget token
    const token = generateWidgetToken(session.id, tenant.id, userId);

    logger.info('Widget authenticated', {
      sessionId: session.id,
      tenantId: tenant.id,
    });

    sendSuccess(res, {
      token,
      session: {
        id: session.id,
        status: session.status,
        tenantId: tenant.id,
      },
      tenant: {
        id: tenant.id,
        name: tenant.name,
        settings: {
          theme: tenant.settings?.theme,
          features: tenant.settings?.features,
          businessHours: tenant.settings?.businessHours,
        },
      },
    });
  })
);

/**
 * GET /auth/me
 * Get current authenticated user via Clerk + auto-provisioning
 */
router.get(
  '/me',
  requireClerkAuth,
  autoProvision,
  asyncHandler(async (req: ProvisionedRequest, res: Response) => {
    sendSuccess(res, {
      agentId: req.agentId,
      tenantId: req.tenantId,
      role: req.userRole,
      tenantName: req.tenantName,
      email: req.user?.email,
    });
  })
);

export default router;
