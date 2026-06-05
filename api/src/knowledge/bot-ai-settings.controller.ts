/**
 * Per-bot AI settings + test-chat controller (multi-bot config editing).
 *
 * Bot-scoped counterparts of the anchor-scoped handlers in
 * `knowledge.controller.ts`. Each targets a SPECIFIC bot by id, resolved with
 * `getOwnedBot` (tenant-scoped, non-deleted → 404 otherwise). The LLM provider
 * `apiKey` stays tenant-scoped: it is never accepted here and never written to
 * the bot; it is only merged at runtime for the test chat.
 */
import { Request, Response } from 'express';
import { AppDataSource } from '../database/data-source';
import { Tenant } from '../database/entities/Tenant';
import { config } from '../config/environment';
import { logger } from '../utils/logger';
import { generateResponse } from '../llm/rag.service';
import { buildSystemPrompt } from '../llm/prompt-builder';
import { DEFAULT_PROVIDER, DEFAULT_MODEL } from '../llm/defaults';
import { ApiError, BadRequestError, NotFoundError } from '../middleware/error-handler';
import { ERROR_CODES } from '../middleware/error-codes';
import { sendSuccess } from '../utils/response';
import {
  getOwnedBot,
  replaceBotSettingsSection,
  BotNotFoundConfigError,
} from '../services/bot-config.service';
import { getBotKnowledgeBaseIds } from './bot-knowledge-bases';
import { defaultBotAi } from '../config/default-bot-settings';
import { putBotAiSettingsSchema } from '../schemas/bot-ai-settings.schema';
import { testChatSchema } from '../schemas/ai-settings.schema';
import { BotSettings } from '../database/entities/Bot';

type BotAi = NonNullable<BotSettings['ai']>;

/**
 * Resolve a tenant-owned bot, mapping the service-layer "not found" to an HTTP
 * 404 (a cross-tenant or soft-deleted bot id must not 500). Keeps the HTTP
 * concern at the controller boundary, out of `bot-config.service`.
 */
async function loadOwnedBotOr404(botId: string, tenantId: string) {
  try {
    return await getOwnedBot(botId, tenantId);
  } catch (err) {
    if (err instanceof BotNotFoundConfigError) throw new NotFoundError('Bot not found');
    throw err;
  }
}

/**
 * Merge a bot's stored `ai` over the defaults so the editor always receives a
 * complete, valid shape (a partial/absent row would otherwise break the form's
 * initial snapshot + autosave).
 */
function withAiDefaults(bot: { name: string; settings?: BotSettings }): BotAi {
  const d = defaultBotAi(bot.name);
  const e = (bot.settings?.ai ?? {}) as Partial<BotAi>;
  return {
    ...d,
    ...e,
    brandVoice: { ...d.brandVoice, ...(e.brandVoice ?? {}) },
    guardrails: { ...d.guardrails, ...(e.guardrails ?? {}) },
  };
}

/** Strip `apiKey` (never on the bot) and surface `hasApiKey` from the tenant. */
function toAiSettingsResponse(botAi: BotAi, tenantApiKey: string | null | undefined) {
  const { apiKey: _stale, ...rest } = botAi as BotAi & { apiKey?: string };
  return { ...rest, hasApiKey: !!tenantApiKey };
}

/** GET /bots/:id/ai-settings — admin/supervisor. Always returns a full shape. */
export async function getBotAiSettings(req: Request, res: Response) {
  const tenantId = (req as Request & { tenantId: string }).tenantId;
  const bot = await loadOwnedBotOr404(req.params.id, tenantId);
  const tenant = await AppDataSource.getRepository(Tenant).findOneOrFail({ where: { id: tenantId } });
  sendSuccess(res, toAiSettingsResponse(withAiDefaults(bot), tenant.settings?.ai?.apiKey));
}

/**
 * PUT /bots/:id/ai-settings — admin only. Full-replace of the `ai` section.
 * Carries forward the out-of-scope keys (`provider`/`model`/`usePlatformAgent`),
 * preserves the AI-enable webhook auto-provision side effect on the tenant.
 */
export async function updateBotAiSettings(req: Request, res: Response) {
  const tenantId = (req as Request & { tenantId: string }).tenantId;
  const data = putBotAiSettingsSchema.parse(req.body);
  const bot = await loadOwnedBotOr404(req.params.id, tenantId);
  const existing = (bot.settings?.ai ?? {}) as Partial<BotAi>;

  const updatedBotAi: BotAi = {
    // Out of scope for this slice — preserve existing, defaulting if absent.
    provider: existing.provider ?? 'openai',
    model: existing.model ?? 'gpt-4o-mini',
    usePlatformAgent: existing.usePlatformAgent ?? true,
    // Editable fields (full-replace).
    enabled: data.enabled,
    supportEmail: data.supportEmail || null,
    brandVoice: data.brandVoice,
    guardrails: data.guardrails,
  };

  // Wholesale replace of the `ai` section on this bot (apiKey stripped defensively).
  await replaceBotSettingsSection(req.params.id, tenantId, 'ai', updatedBotAi);

  // Auto-provision the default n8n webhook when the final ai.enabled is true and
  // the tenant has no custom URL — mirrors the legacy anchor flow. Tenant-scoped.
  const tenantRepo = AppDataSource.getRepository(Tenant);
  const tenant = await tenantRepo.findOneOrFail({ where: { id: tenantId } });
  if (updatedBotAi.enabled && !tenant.webhookUrl && config.n8n.defaultWebhookUrl) {
    tenant.webhookUrl = config.n8n.defaultWebhookUrl;
    if (!tenant.webhookSecret && config.n8n.inboundSecret) {
      tenant.webhookSecret = config.n8n.inboundSecret;
    }
    await tenantRepo.save(tenant);
    logger.info(`Auto-provisioned webhook URL for tenant ${tenantId} (bot ${req.params.id})`);
  }

  sendSuccess(res, toAiSettingsResponse(updatedBotAi, tenant.settings?.ai?.apiKey));
}

/**
 * POST /bots/:id/test-chat — admin only. Runs a preview against THIS bot's
 * config + its attached KBs. Mirrors the legacy anchor test chat, but scopes
 * retrieval to the bot: an empty attachment set is treated as the no-KB path
 * (skip RAG) so we don't run a pointless embed/rewrite and surface a misleading
 * embeddings error.
 */
export async function botTestChat(req: Request, res: Response) {
  const tenantId = (req as Request & { tenantId: string }).tenantId;
  const { message, history, useKnowledgeBase } = testChatSchema.parse(req.body);
  const bot = await loadOwnedBotOr404(req.params.id, tenantId);
  const tenant = await AppDataSource.getRepository(Tenant).findOneOrFail({ where: { id: tenantId } });

  // Use the same default-filled shape the editor GET returns, so test chat and
  // the form agree on enabled/brandVoice for a bot with partial/absent settings.
  const botAi = withAiDefaults(bot);
  if (!botAi.enabled) {
    throw new BadRequestError('AI is not enabled. Save your AI settings first.');
  }
  if (!botAi.brandVoice?.name) {
    throw new BadRequestError('Incomplete AI settings. Set a chatbot name first.');
  }

  // Merge the tenant LLM apiKey (the secret, stored encrypted) at runtime only —
  // never persisted onto the bot. getProvider/generateResponse decrypt it.
  const tenantApiKey = tenant.settings?.ai?.apiKey;
  type TenantAi = NonNullable<NonNullable<Tenant['settings']>['ai']>;
  const ai: TenantAi = { ...botAi, apiKey: tenantApiKey ?? null } as TenantAi;

  const provider = ai.provider || DEFAULT_PROVIDER;
  const model = ai.model || DEFAULT_MODEL;

  // Scope retrieval to this bot's attached KBs. Empty set → no-KB path.
  const botKbIds = await getBotKnowledgeBaseIds(AppDataSource, req.params.id);
  const useKb = useKnowledgeBase && botKbIds.length > 0;

  if (useKb) {
    let result;
    try {
      result = await generateResponse(AppDataSource, tenantId, ai, message, history, botKbIds);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '';
      if (msg.includes('OPENAI_API_KEY')) {
        throw new BadRequestError(
          'Knowledge base requires OPENAI_API_KEY environment variable for embeddings.',
        );
      }
      logger.error('Bot test chat RAG failed', err);
      throw new ApiError('RAG pipeline failed. Check server logs.', 500, ERROR_CODES.UPSTREAM_FAILED);
    }
    sendSuccess(res, {
      response:
        result.response ||
        ai.guardrails?.fallbackMessage ||
        'I could not find an answer in the knowledge base.',
      provider,
      model,
      confidence: result.confidence,
      chunksUsed: result.chunks.length,
    });
  } else {
    const { getProvider } = await import('../llm/provider-factory');
    const llm = getProvider(provider, tenantApiKey ?? undefined);
    const systemPrompt = buildSystemPrompt(ai, { businessName: tenant.name });
    const messages = [
      { role: 'system' as const, content: systemPrompt },
      ...history.map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content })),
      { role: 'user' as const, content: message },
    ];

    let response;
    try {
      response = await llm.chat(messages, { model, maxTokens: 1000, temperature: 0.3, jsonMode: false });
    } catch (err) {
      logger.error('Bot test chat LLM call failed', err);
      throw new ApiError('LLM call failed. Check your API key and model.', 500, ERROR_CODES.UPSTREAM_FAILED);
    }
    sendSuccess(res, { response: response.content, provider, model });
  }
}
