/**
 * Channel Management Routes
 * CRUD for channel connections (Telegram, etc.)
 */

import { Router, Request, Response } from 'express';
import { Not } from 'typeorm';
import { getRepository } from '../database/data-source';
import { ChannelConnection } from '../database/entities/ChannelConnection';
import { WebhookEventLog } from '../database/entities/WebhookEventLog';
import { MessageDelivery } from '../database/entities/MessageDelivery';
import { requireClerkAuth, autoProvision, ProvisionedRequest } from '../middleware/clerk.middleware';
import { resolveTenantContext } from '../middleware/super-admin.middleware';
import { asyncHandler, ApiError, BadRequestError, NotFoundError } from '../middleware/error-handler';
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
import {
  completeWhatsAppEmbeddedSignup,
  getWhatsAppEmbeddedSignupPublicConfig,
  isWhatsAppEmbeddedSignupReady,
} from './whatsapp/embedded-signup.service';
import { ERROR_CODES } from '../middleware/error-codes';
import { runHealthCheck } from './health-check.service';
import { requireChannelEntitled } from './channel-entitlement';
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
      // Disconnected connections are treated as deleted from the user's view;
      // the row is retained in the DB for audit/webhook-cleanup history.
      where: { tenantId, status: Not('disconnected') },
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

    // Per-channel plan gate (channels plan D7) — replaces the old
    // `unifiedInbox` proxy now that channel availability has real keys.
    await requireChannelEntitled(tenantId, 'telegram');

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

    // Per-channel plan gate — see /telegram/connect note.
    await requireChannelEntitled(tenantId, 'whatsapp');

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
 * GET /whatsapp/embedded-signup/config
 * Public (authenticated) flag for the portal Connect button. Secrets stay off
 * this payload. Off until Tech Provider + whatsapp_business_* Advanced access.
 */
router.get(
  '/whatsapp/embedded-signup/config',
  asyncHandler(async (_req: Request, res: Response): Promise<void> => {
    sendSuccess(res, getWhatsAppEmbeddedSignupPublicConfig());
  }),
);

/**
 * POST /whatsapp/embedded-signup
 * Complete Embedded Signup: exchange the 30s code (no redirect_uri), register
 * the phone, subscribe the WABA, persist the connection.
 * Body: { code, phoneNumberId, wabaId }
 */
router.post(
  '/whatsapp/embedded-signup',
  asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const authReq = req as ProvisionedRequest;
    const tenantId = authReq.user?.tenantId;

    if (!tenantId) {
      throw new BadRequestError('Tenant context required');
    }

    if (!isWhatsAppEmbeddedSignupReady()) {
      throw new ApiError(
        'WhatsApp Embedded Signup is not enabled on this app yet',
        503,
        ERROR_CODES.UPSTREAM_FAILED,
      );
    }

    const { code, phoneNumberId, wabaId } = req.body as {
      code?: string;
      phoneNumberId?: string;
      wabaId?: string;
    };

    if (!code || typeof code !== 'string') {
      throw new BadRequestError('code is required');
    }
    if (!phoneNumberId || typeof phoneNumberId !== 'string') {
      throw new BadRequestError('phoneNumberId is required');
    }
    if (!wabaId || typeof wabaId !== 'string') {
      throw new BadRequestError('wabaId is required');
    }

    await requireChannelEntitled(tenantId, 'whatsapp');

    const connection = await completeWhatsAppEmbeddedSignup(tenantId, {
      code,
      phoneNumberId,
      wabaId,
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

    // runHealthCheck calls the provider's API — an unentitled channel must be
    // fully inert (channels plan D3), so the gate covers health checks too.
    await requireChannelEntitled(tenantId!, existing.channel);

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

/**
 * PATCH /:connectionId/auto-capture
 * Toggle whether inbound conversations on this channel auto-create Leads
 * (leads-across-all-channels D5 — volume control + GDPR consent lever).
 * Body: { enabled: boolean }. Stored on `connection.config.autoCaptureLeads`;
 * absent/true ⇒ capture (default on).
 */
router.patch(
  '/:connectionId/auto-capture',
  asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const authReq = req as ProvisionedRequest;
    const tenantId = authReq.user!.tenantId;
    const { connectionId } = req.params;
    const { enabled } = (req.body ?? {}) as { enabled?: unknown };

    if (typeof enabled !== 'boolean') {
      throw new BadRequestError('enabled must be a boolean');
    }

    const repo = getRepository(ChannelConnection);
    const connection = await repo.findOne({ where: { id: connectionId, tenantId } });
    if (!connection) {
      throw new NotFoundError('Channel connection not found');
    }

    connection.config = { ...(connection.config ?? {}), autoCaptureLeads: enabled };
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
