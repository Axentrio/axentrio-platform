/**
 * Channel Management Routes
 * CRUD for channel connections (Telegram, etc.)
 */

import { Router, Request, Response } from 'express';
import { getRepository } from '../database/data-source';
import { ChannelConnection } from '../database/entities/ChannelConnection';
import { WebhookEventLog } from '../database/entities/WebhookEventLog';
import { MessageDelivery } from '../database/entities/MessageDelivery';
import { requireClerkAuth, autoProvision, ProvisionedRequest } from '../middleware/clerk.middleware';
import { resolveTenantContext } from '../middleware/super-admin.middleware';
import { asyncHandler, BadRequestError, NotFoundError } from '../middleware/error-handler';
import { sendSuccess, sendCreated } from '../utils/response';
import {
  setupTelegramConnection,
  disconnectTelegramConnection,
} from './telegram/setup.service';
import { disconnectMetaConnection } from './meta/disconnect.service';
import {
  setupWhatsAppConnection,
  disconnectWhatsAppConnection,
} from './whatsapp/setup.service';
import { runHealthCheck } from './health-check.service';
import { requireFeature } from '../billing/enforce';
import { getOwnedBot, BotNotFoundConfigError } from '../services/bot-config.service';

const router = Router();

// All routes require authentication
router.use(requireClerkAuth, autoProvision, resolveTenantContext);

/**
 * GET /connections
 * List all channel connections for the current tenant. Includes derived
 * activity timestamps (lastInboundAt, lastOutboundAt). No credentials exposed.
 */
router.get(
  '/connections',
  asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const authReq = req as ProvisionedRequest;
    const tenantId = authReq.user?.tenantId;

    const repo = getRepository(ChannelConnection);
    const connections = (await repo.find({
      where: { tenantId },
      order: { createdAt: 'DESC' },
      select: [
        'id',
        'tenantId',
        'botId',
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
    })) as ChannelConnection[];

    const enriched = await enrichWithActivity(connections);
    sendSuccess(res, enriched);
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

    // Plan-gate. The legacy numeric `channels` count cap was retired in the
    // M0 plan-catalog reshape — channel availability is per-tier-by-feature
    // now. `unifiedInbox` is the proxy: paid tiers have it, the `free`
    // cancellation sink does not. A cancelled tenant cannot connect new
    // channels; everyone else can connect any supported channel.
    await requireFeature(tenantId, 'unifiedInbox', 'plan_limit_channels');

    const baseUrl = `${req.protocol}://${req.get('host')}`;

    const connection = await setupTelegramConnection(tenantId, botToken, baseUrl, label);

    // Strip credentials from the response
    const { credentials: _creds, webhookSecret: _secret, ...safeConnection } = connection;

    sendCreated(res, safeConnection);
  }),
);

/**
 * POST /whatsapp/connect
 * Connect a WhatsApp Cloud API number to the current tenant (single-tenant /
 * manual onboarding). Body: { phoneNumberId, accessToken, wabaId?, label? }
 */
router.post(
  '/whatsapp/connect',
  asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const authReq = req as ProvisionedRequest;
    const tenantId = authReq.user?.tenantId;

    if (!tenantId) {
      throw new BadRequestError('Tenant context required');
    }

    const { phoneNumberId, accessToken, wabaId, label } = req.body as {
      phoneNumberId?: string;
      accessToken?: string;
      wabaId?: string;
      label?: string;
    };

    if (!phoneNumberId || typeof phoneNumberId !== 'string') {
      throw new BadRequestError('phoneNumberId is required');
    }
    if (!accessToken || typeof accessToken !== 'string') {
      throw new BadRequestError('accessToken is required');
    }

    // Same plan gate as other channels — see /telegram/connect note.
    await requireFeature(tenantId, 'unifiedInbox', 'plan_limit_channels');

    const connection = await setupWhatsAppConnection(tenantId, {
      phoneNumberId,
      accessToken,
      wabaId,
      label,
    });

    const { credentials: _creds, webhookSecret: _secret, ...safeConnection } = connection;
    sendCreated(res, safeConnection);
  }),
);

/**
 * POST /:connectionId/health-check
 * Run a health check against the platform for this connection.
 * Verifies stored credentials are still valid; updates lastHealthCheckAt + lastError.
 */
router.post(
  '/:connectionId/health-check',
  asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const authReq = req as ProvisionedRequest;
    const tenantId = authReq.user?.tenantId;
    const { connectionId } = req.params;

    const repo = getRepository(ChannelConnection);
    const existing = await repo.findOne({ where: { id: connectionId, tenantId } });
    if (!existing) {
      throw new NotFoundError('Channel connection not found');
    }

    const updated = await runHealthCheck(connectionId);
    const { credentials: _creds, webhookSecret: _secret, ...safeConnection } = updated;

    sendSuccess(res, safeConnection);
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
    } else if (existing.channel === 'messenger' || existing.channel === 'instagram') {
      await disconnectMetaConnection(connectionId);
      // Re-fetch after disconnect to get updated state
      connection = await repo.findOne({ where: { id: connectionId } }) as ChannelConnection;
    } else if (existing.channel === 'whatsapp') {
      connection = await disconnectWhatsAppConnection(connectionId);
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

/**
 * PATCH /:connectionId/bot
 * Assign (or clear) the bot this channel routes inbound messages to.
 * Body: { botId: string | null } — null reverts to the tenant's anchor bot.
 * The bot must belong to the tenant and be active.
 */
router.patch(
  '/:connectionId/bot',
  asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const authReq = req as ProvisionedRequest;
    const tenantId = authReq.user!.tenantId;
    const { connectionId } = req.params;
    const { botId } = (req.body ?? {}) as { botId?: string | null };

    if (botId !== null && typeof botId !== 'string') {
      throw new BadRequestError('botId must be a bot id string or null');
    }

    const repo = getRepository(ChannelConnection);
    const connection = await repo.findOne({ where: { id: connectionId, tenantId } });
    if (!connection) {
      throw new NotFoundError('Channel connection not found');
    }

    if (botId) {
      let bot;
      try {
        bot = await getOwnedBot(botId, tenantId);
      } catch (err) {
        if (err instanceof BotNotFoundConfigError) throw new NotFoundError('Bot not found');
        throw err;
      }
      if (bot.status !== 'active') {
        throw new BadRequestError('Cannot route a channel to a paused bot — activate it first.');
      }
      connection.botId = bot.id;
    } else {
      connection.botId = null;
    }

    const saved = (await repo.save(connection)) as ChannelConnection;
    const { credentials: _creds, webhookSecret: _secret, ...safeConnection } = saved;
    sendSuccess(res, safeConnection);
  }),
);

type ConnectionWithActivity = Record<string, unknown> & {
  id: string;
  lastInboundAt: Date | null;
  lastOutboundAt: Date | null;
};

/**
 * Enrich connection rows with derived `lastInboundAt` (max WebhookEventLog.createdAt)
 * and `lastOutboundAt` (max MessageDelivery.createdAt). Single GROUP BY query per
 * source so we stay efficient on tenants with lots of channels.
 */
async function enrichWithActivity(
  connections: ChannelConnection[],
): Promise<ConnectionWithActivity[]> {
  if (connections.length === 0) return [];

  const ids = connections.map((c) => c.id);

  const inboundRows = await getRepository(WebhookEventLog)
    .createQueryBuilder('w')
    .select('w.channelConnectionId', 'connectionId')
    .addSelect('MAX(w.createdAt)', 'lastAt')
    .where('w.channelConnectionId IN (:...ids)', { ids })
    .groupBy('w.channelConnectionId')
    .getRawMany<{ connectionId: string; lastAt: Date | string }>();

  const outboundRows = await getRepository(MessageDelivery)
    .createQueryBuilder('m')
    .select('m.channelConnectionId', 'connectionId')
    .addSelect('MAX(m.createdAt)', 'lastAt')
    .where('m.channelConnectionId IN (:...ids)', { ids })
    .andWhere('m.status IN (:...statuses)', { statuses: ['sent', 'delivered', 'read'] })
    .groupBy('m.channelConnectionId')
    .getRawMany<{ connectionId: string; lastAt: Date | string }>();

  const inboundByConn = new Map(inboundRows.map((r) => [r.connectionId, normalizeDate(r.lastAt)]));
  const outboundByConn = new Map(outboundRows.map((r) => [r.connectionId, normalizeDate(r.lastAt)]));

  return connections.map((c) => ({
    ...(c as unknown as Record<string, unknown>),
    id: c.id,
    lastInboundAt: inboundByConn.get(c.id) ?? null,
    lastOutboundAt: outboundByConn.get(c.id) ?? null,
  }));
}

function normalizeDate(value: Date | string | null | undefined): Date | null {
  if (!value) return null;
  return value instanceof Date ? value : new Date(value);
}

export default router;
