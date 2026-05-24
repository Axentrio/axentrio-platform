/**
 * Bot management routes (multi-bot Phase 2 — clean CRUD).
 *
 * Tenant-scoped management of a tenant's Bots: list / create / rename /
 * pause / delete / embed. The anchor bot (`isDefault`) is protected — it
 * cannot be paused or deleted in v1 (it owns the legacy tenant.apiKey).
 *
 * DEFERRED to the billing epic landing: the per-tier bot quota gate on create
 * and activate (see the TODO in POST / and PATCH /:id). DEFERRED to Phase 3:
 * auto-seeding a dedicated KnowledgeBase on create (blocked by the current
 * one-KB-per-tenant unique constraint) — a new bot starts with no attached
 * KBs and answers from nothing until KBs are attached.
 */

import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { IsNull } from 'typeorm';
import { AppDataSource } from '../database/data-source';
import { Bot, BotSettings } from '../database/entities/Bot';
import { requireClerkAuth, autoProvision, ProvisionedRequest } from '../middleware/clerk.middleware';
import { resolveTenantContext } from '../middleware/super-admin.middleware';
import { asyncHandler, NotFoundError, ForbiddenError } from '../middleware/error-handler';
import { validate } from '../middleware/validate';
import { sendSuccess, sendCreated, sendNoContent } from '../utils/response';
import { config } from '../config/environment';
import { DEFAULT_SKILLS } from '../config/default-skills';
import { createBotSchema, updateBotSchema } from '../schemas/bot.schema';

const router = Router();
const botRepository = AppDataSource.getRepository(Bot);

const MUTATE_ROLES = ['admin', 'supervisor', 'super_admin'];
const MAX_KEY_ATTEMPTS = 5;

router.use(requireClerkAuth, autoProvision, resolveTenantContext);

function requireMutateRole(role: string | undefined): void {
  if (!role || !MUTATE_ROLES.includes(role)) {
    throw new ForbiddenError('Only admins can manage bots');
  }
}

function generatePublicKey(): string {
  return `bk_${crypto.randomBytes(24).toString('hex')}`;
}

function isUniqueViolation(err: unknown): boolean {
  return !!err && typeof err === 'object' && (err as { code?: string }).code === '23505';
}

/** Default per-bot config for a newly-created (non-anchor) bot — clean slate. */
function defaultBotSettings(name: string): BotSettings {
  return {
    ai: {
      enabled: true,
      usePlatformAgent: true,
      provider: 'openai',
      model: 'gpt-4o-mini',
      brandVoice: { name: `${name} Assistant`, tone: 'friendly', customInstructions: '' },
      guardrails: {
        topicsToAvoid: [],
        escalationKeywords: ['speak to someone', 'human agent', 'talk to a person'],
        confidenceThreshold: 0.7,
        maxResponseLength: 500,
        greetingMessage: 'Welcome! How can I help you today?',
        fallbackMessage: 'Let me connect you with our team.',
        offHoursMessage: "We're currently outside business hours. We'll get back to you soon.",
      },
    },
    skills: [...DEFAULT_SKILLS],
  };
}

function embedSnippet(publicKey: string): string {
  return `<script src="${config.api.url}/widget.js" data-api-key="${publicKey}" async></script>`;
}

function toListItem(bot: Bot) {
  return {
    id: bot.id,
    name: bot.name,
    status: bot.status,
    isDefault: bot.isDefault,
    publicKey: bot.publicKey,
    createdAt: bot.createdAt,
    updatedAt: bot.updatedAt,
  };
}

/**
 * GET /bots — list the tenant's (non-deleted) bots + usage count.
 * NOTE: `limit` is null until the per-tier bot quota lands with the billing epic.
 */
router.get(
  '/',
  asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const tenantId = (req as ProvisionedRequest).tenantId;
    const bots = await botRepository.find({
      where: { tenantId, deletedAt: IsNull() },
      order: { isDefault: 'DESC', createdAt: 'ASC' },
    });
    sendSuccess(res, {
      bots: bots.map(toListItem),
      used: bots.length,
      limit: null, // TODO(billing): per-tier bot limit once the billing epic lands
    });
  })
);

/**
 * POST /bots — create a bot. Transactional: serialise per-tenant, generate a
 * unique public key (retry on collision), insert. The quota gate is deferred.
 */
router.post(
  '/',
  validate(createBotSchema),
  asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const authReq = req as ProvisionedRequest;
    requireMutateRole(authReq.userRole);
    const tenantId = authReq.tenantId!;
    const { name } = req.body as { name: string };

    const bot = await AppDataSource.transaction(async (manager) => {
      // Serialise concurrent creates for this tenant (also the lock point for
      // the future quota gate). The anchor bot guarantees ≥1 row to lock.
      await manager.query('SELECT 1 FROM chatbot_bots WHERE tenant_id = $1 FOR UPDATE', [tenantId]);

      // TODO(billing): enforceCountLimit({ ..., capability: 'bots' }) here once
      // `bots` is added to PlanLimits/Entitlements and the billing epic is committed.

      for (let attempt = 0; attempt < MAX_KEY_ATTEMPTS; attempt++) {
        const draft = manager.create(Bot, {
          tenantId,
          name,
          publicKey: generatePublicKey(),
          status: 'active',
          isDefault: false,
          settings: defaultBotSettings(name),
        });
        try {
          return await manager.save(Bot, draft);
        } catch (err) {
          if (isUniqueViolation(err) && attempt < MAX_KEY_ATTEMPTS - 1) continue;
          throw err;
        }
      }
      throw new Error('Failed to generate a unique bot public key');
    });

    sendCreated(res, { ...toListItem(bot), embedSnippet: embedSnippet(bot.publicKey) });
  })
);

/**
 * GET /bots/:id
 */
router.get(
  '/:id',
  asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const tenantId = (req as ProvisionedRequest).tenantId;
    const bot = await botRepository.findOne({
      where: { id: req.params.id, tenantId, deletedAt: IsNull() },
    });
    if (!bot) throw new NotFoundError('Bot not found');
    sendSuccess(res, { ...toListItem(bot), embedSnippet: embedSnippet(bot.publicKey) });
  })
);

/**
 * GET /bots/:id/embed — embed snippet derived from the bot's LIVE public key.
 */
router.get(
  '/:id/embed',
  asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const tenantId = (req as ProvisionedRequest).tenantId;
    const bot = await botRepository.findOne({
      where: { id: req.params.id, tenantId, deletedAt: IsNull() },
    });
    if (!bot) throw new NotFoundError('Bot not found');
    sendSuccess(res, { publicKey: bot.publicKey, snippet: embedSnippet(bot.publicKey) });
  })
);

/**
 * PATCH /bots/:id — rename and/or pause/activate. The anchor bot cannot be
 * paused (it owns the legacy embed key).
 */
router.patch(
  '/:id',
  validate(updateBotSchema),
  asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const authReq = req as ProvisionedRequest;
    requireMutateRole(authReq.userRole);
    const tenantId = authReq.tenantId;
    const { name, status } = req.body as { name?: string; status?: 'active' | 'paused' };

    const bot = await botRepository.findOne({
      where: { id: req.params.id, tenantId, deletedAt: IsNull() },
    });
    if (!bot) throw new NotFoundError('Bot not found');

    if (status === 'paused' && bot.isDefault) {
      throw new ForbiddenError('The default bot cannot be paused — it owns your existing embed.');
    }
    // TODO(billing): when activating (paused → active), gate on the per-tier
    // bot quota once the billing epic lands.

    if (name !== undefined) bot.name = name;
    if (status !== undefined) bot.status = status;
    const saved = await botRepository.save(bot);
    sendSuccess(res, toListItem(saved));
  })
);

/**
 * DELETE /bots/:id — soft delete. Non-anchor bots only; the anchor is
 * permanent in v1 (≥1 bot always).
 */
router.delete(
  '/:id',
  asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const authReq = req as ProvisionedRequest;
    requireMutateRole(authReq.userRole);
    const tenantId = authReq.tenantId;

    const bot = await botRepository.findOne({
      where: { id: req.params.id, tenantId, deletedAt: IsNull() },
    });
    if (!bot) throw new NotFoundError('Bot not found');
    if (bot.isDefault) {
      throw new ForbiddenError('The default bot cannot be deleted.');
    }

    bot.deletedAt = new Date();
    await botRepository.save(bot);
    sendNoContent(res);
  })
);

export default router;
