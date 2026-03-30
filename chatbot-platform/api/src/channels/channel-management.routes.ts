/**
 * Channel Management Routes
 * CRUD for channel connections (Telegram, etc.)
 */

import { Router, Request, Response } from 'express';
import { getRepository } from '../database/data-source';
import { ChannelConnection } from '../database/entities/ChannelConnection';
import { requireClerkAuth, autoProvision, ProvisionedRequest } from '../middleware/clerk.middleware';
import { resolveTenantContext } from '../middleware/super-admin.middleware';
import { asyncHandler, BadRequestError, NotFoundError } from '../middleware/error-handler';
import { sendSuccess, sendCreated } from '../utils/response';
import {
  setupTelegramConnection,
  disconnectTelegramConnection,
} from './telegram/setup.service';

const router = Router();

// All routes require authentication
router.use(requireClerkAuth, autoProvision, resolveTenantContext);

/**
 * GET /connections
 * List all channel connections for the current tenant (no credentials exposed).
 */
router.get(
  '/connections',
  asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const authReq = req as ProvisionedRequest;
    const tenantId = authReq.user?.tenantId;

    const repo = getRepository(ChannelConnection);
    const connections = await repo.find({
      where: { tenantId },
      order: { createdAt: 'DESC' },
      select: [
        'id',
        'tenantId',
        'channel',
        'status',
        'label',
        'platformAccountId',
        'config',
        'lastHealthCheckAt',
        'lastError',
        'createdAt',
        'updatedAt',
      ],
    });

    sendSuccess(res, connections);
  }),
);

/**
 * POST /telegram/connect
 * Connect a Telegram bot to the current tenant.
 * Body: { botToken: string; label?: string }
 */
router.post(
  '/telegram/connect',
  asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const authReq = req as ProvisionedRequest;
    const tenantId = authReq.user?.tenantId;

    if (!tenantId) {
      throw new BadRequestError('Tenant context required');
    }

    const { botToken, label } = req.body as { botToken?: string; label?: string };

    if (!botToken || typeof botToken !== 'string') {
      throw new BadRequestError('botToken is required');
    }

    const baseUrl = `${req.protocol}://${req.get('host')}`;

    const connection = await setupTelegramConnection(tenantId, botToken, baseUrl, label);

    // Strip credentials from the response
    const { credentials: _creds, webhookSecret: _secret, ...safeConnection } = connection;

    sendCreated(res, safeConnection);
  }),
);

/**
 * DELETE /:connectionId/disconnect
 * Disconnect a channel connection.
 */
router.delete(
  '/:connectionId/disconnect',
  asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const authReq = req as ProvisionedRequest;
    const tenantId = authReq.user?.tenantId;
    const { connectionId } = req.params;

    // Verify ownership
    const repo = getRepository(ChannelConnection);
    const existing = await repo.findOne({ where: { id: connectionId, tenantId } });

    if (!existing) {
      throw new NotFoundError('Channel connection not found');
    }

    let connection: ChannelConnection;
    if (existing.channel === 'telegram') {
      connection = await disconnectTelegramConnection(connectionId);
    } else {
      // Generic disconnect for other channels
      existing.status = 'disconnected';
      connection = await repo.save(existing) as ChannelConnection;
    }

    // Strip credentials from the response
    const { credentials: _creds, webhookSecret: _secret, ...safeConnection } = connection;

    sendSuccess(res, safeConnection);
  }),
);

export default router;
