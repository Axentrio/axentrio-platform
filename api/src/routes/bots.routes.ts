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
import { BotKnowledgeBase } from '../database/entities/BotKnowledgeBase';
import { KnowledgeBase } from '../database/entities/KnowledgeBase';
import { requireClerkAuth, autoProvision, ProvisionedRequest } from '../middleware/clerk.middleware';
import { resolveTenantContext } from '../middleware/super-admin.middleware';
import { asyncHandler, NotFoundError, ForbiddenError } from '../middleware/error-handler';
import { validate } from '../middleware/validate';
import { sendSuccess, sendCreated, sendNoContent } from '../utils/response';
import { config } from '../config/environment';
import { DEFAULT_SKILLS } from '../config/default-skills';
import { createBotSchema, updateBotSchema } from '../schemas/bot.schema';
import { enforceCountLimit } from '../billing/enforce';
import { getEntitlements } from '../billing/entitlements';

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
    const tenantId = (req as ProvisionedRequest).tenantId!;
    const [bots, entitlements] = await Promise.all([
      botRepository.find({
        where: { tenantId, deletedAt: IsNull() },
        order: { isDefault: 'DESC', createdAt: 'ASC' },
      }),
      getEntitlements(tenantId),
    ]);
    sendSuccess(res, {
      bots: bots.map(toListItem),
      used: bots.length,
      limit: entitlements.limits.bots,
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
      // Serialise concurrent creates for this tenant. The anchor bot guarantees
      // ≥1 row to lock, so the FOR UPDATE has a target on every tenant.
      await manager.query('SELECT 1 FROM chatbot_bots WHERE tenant_id = $1 FOR UPDATE', [tenantId]);

      // Per-tier bot quota gate. Counts non-deleted rows (paused bots count
      // against the cap; only soft-delete frees a slot per multi-bot doc).
      await enforceCountLimit({
        manager,
        tenantId,
        capability: 'bots',
        errorCode: 'plan_limit_bots',
        countQuery: (m) =>
          m
            .createQueryBuilder(Bot, 'b')
            .where('b.tenant_id = :tenantId AND b.deleted_at IS NULL', { tenantId })
            .getCount(),
      });

      let saved: Bot | null = null;
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
          saved = await manager.save(Bot, draft);
          break;
        } catch (err) {
          if (isUniqueViolation(err) && attempt < MAX_KEY_ATTEMPTS - 1) continue;
          throw err;
        }
      }
      if (!saved) throw new Error('Failed to generate a unique bot public key');

      // Seed a dedicated (empty) KnowledgeBase and attach it, so the bot is
      // self-contained. It answers from nothing until documents are added.
      const kb = await manager.save(
        manager.create(KnowledgeBase, { tenantId, botId: saved.id, status: 'inactive' }),
      );
      await manager.save(
        manager.create(BotKnowledgeBase, { botId: saved.id, knowledgeBaseId: kb.id, tenantId }),
      );
      return saved;
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
    const tenantId = authReq.tenantId!;
    const { name, status } = req.body as { name?: string; status?: 'active' | 'paused' };

    // Activation (paused → active) must re-check the quota: a tenant could have
    // 2 paused bots on Enterprise (cap=2), downgrade to Pro (cap=1), and then
    // try to un-pause both. The quota counts non-deleted rows including paused
    // ones, so the only honest gate is on the transition itself — within a tx
    // with a row lock to keep the count consistent against concurrent activates.
    const saved = await AppDataSource.transaction(async (manager) => {
      const repo = manager.getRepository(Bot);
      const bot = await repo.findOne({
        where: { id: req.params.id, tenantId, deletedAt: IsNull() },
      });
      if (!bot) throw new NotFoundError('Bot not found');

      if (status === 'paused' && bot.isDefault) {
        throw new ForbiddenError('The default bot cannot be paused — it owns your existing embed.');
      }

      const activating = status === 'active' && bot.status === 'paused';
      if (activating) {
        await manager.query('SELECT 1 FROM chatbot_bots WHERE tenant_id = $1 FOR UPDATE', [tenantId]);
        await enforceCountLimit({
          manager,
          tenantId,
          capability: 'bots',
          errorCode: 'plan_limit_bots',
          countQuery: (m) =>
            m
              .createQueryBuilder(Bot, 'b')
              .where(
                "b.tenant_id = :tenantId AND b.deleted_at IS NULL AND b.status = 'active'",
                { tenantId },
              )
              .getCount(),
        });
      }

      if (name !== undefined) bot.name = name;
      if (status !== undefined) bot.status = status;
      return repo.save(bot);
    });

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

// ── Per-bot knowledge-base attachment ──────────────────────────────────────

/** Load a tenant-owned, non-deleted bot or 404. */
async function loadTenantBot(botId: string, tenantId: string | undefined): Promise<Bot> {
  const bot = await botRepository.findOne({ where: { id: botId, tenantId, deletedAt: IsNull() } });
  if (!bot) throw new NotFoundError('Bot not found');
  return bot;
}

/**
 * GET /bots/:id/knowledge-bases — KnowledgeBases attached to the bot.
 */
router.get(
  '/:id/knowledge-bases',
  asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const tenantId = (req as ProvisionedRequest).tenantId;
    await loadTenantBot(req.params.id, tenantId);
    const rows = await AppDataSource.getRepository(BotKnowledgeBase).find({
      where: { botId: req.params.id, tenantId },
    });
    sendSuccess(res, { knowledgeBaseIds: rows.map((r) => r.knowledgeBaseId) });
  })
);

/**
 * POST /bots/:id/knowledge-bases/:kbId — attach a KnowledgeBase (idempotent).
 * Both the bot and the KB must belong to the caller's tenant.
 */
router.post(
  '/:id/knowledge-bases/:kbId',
  asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const authReq = req as ProvisionedRequest;
    requireMutateRole(authReq.userRole);
    const tenantId = authReq.tenantId;
    const { id: botId, kbId } = req.params;

    await loadTenantBot(botId, tenantId);
    const kb = await AppDataSource.getRepository(KnowledgeBase).findOne({ where: { id: kbId, tenantId } });
    if (!kb) throw new NotFoundError('Knowledge base not found');

    await AppDataSource.getRepository(BotKnowledgeBase)
      .createQueryBuilder()
      .insert()
      .values({ botId, knowledgeBaseId: kbId, tenantId: tenantId! })
      .orIgnore() // already attached → no-op
      .execute();

    sendSuccess(res, { botId, knowledgeBaseId: kbId, attached: true });
  })
);

/**
 * DELETE /bots/:id/knowledge-bases/:kbId — detach a KnowledgeBase (does not
 * delete the KB). Detaching the last one is allowed — the bot then answers
 * from nothing.
 */
router.delete(
  '/:id/knowledge-bases/:kbId',
  asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const authReq = req as ProvisionedRequest;
    requireMutateRole(authReq.userRole);
    const tenantId = authReq.tenantId;
    const { id: botId, kbId } = req.params;

    await loadTenantBot(botId, tenantId);
    await AppDataSource.getRepository(BotKnowledgeBase).delete({
      botId,
      knowledgeBaseId: kbId,
      tenantId,
    });
    sendNoContent(res);
  })
);

export default router;
