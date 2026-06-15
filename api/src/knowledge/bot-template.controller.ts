/**
 * Tenant-facing bot↔template binding (.scratch/plan-bot-templates.md, Phase 4;
 * multi-template extension).
 *
 * - GET  /bots/:id/templates — templates this tenant may bind + the bot's current
 *   bindings (up to 3, ordered) + mode + per-binding resolved preview + published
 *   versions (for pin dropdowns) + missing modules (advisory, T13).
 * - PUT  /bots/:id/template — set the bot's bindings (1-3) + mode. Validates each
 *   template is available and any fixed pin is published. Mirrors the primary
 *   ([0]) onto template_id/template_version for back-compat.
 */
import { Request, Response } from 'express';
import { AppDataSource } from '../database/data-source';
import { Bot } from '../database/entities/Bot';
import { BotTemplateVersion } from '../database/entities/BotTemplateVersion';
import { getOwnedBot, BotNotFoundConfigError } from '../services/bot-config.service';
import { listAvailableTemplates, resolveBoundTemplates, bindingsOf } from '../templates/template-resolver';
import { listActiveModules } from '../modules';
import { sendSuccess } from '../utils/response';
import { NotFoundError, ForbiddenError, ValidationError } from '../middleware/error-handler';
import { putBotTemplateBindingSchema } from '../schemas/bot-template-binding.schema';

async function loadOwnedBotOr404(botId: string, tenantId: string): Promise<Bot> {
  try {
    return await getOwnedBot(botId, tenantId);
  } catch (err) {
    if (err instanceof BotNotFoundConfigError) throw new NotFoundError('Bot not found');
    throw err;
  }
}

/** Shared response shape for GET and PUT — the full picker view (multi-binding). */
async function buildView(bot: Bot, tenantId: string) {
  const bindings = bindingsOf(bot);
  const [available, resolvedList, activeModules] = await Promise.all([
    listAvailableTemplates(tenantId),
    resolveBoundTemplates(bot),
    listActiveModules(tenantId),
  ]);
  const activeIds = new Set(activeModules.map((m) => m.module.id));

  // Per bound template: published versions (for the pin dropdown) + missing modules.
  const boundIds = [...new Set(bindings.map((b) => b.templateId))];
  const perTemplate: Record<string, { publishedVersions: number[]; expectedModules: string[] }> = {};
  await Promise.all(
    boundIds.map(async (tid) => {
      const versions = await AppDataSource.getRepository(BotTemplateVersion).find({
        where: { templateId: tid, status: 'published' },
        select: ['version', 'expectedModules'],
        order: { version: 'DESC' },
      });
      perTemplate[tid] = {
        publishedVersions: versions.map((v) => v.version),
        expectedModules: [...new Set(versions.flatMap((v) => v.expectedModules ?? []))],
      };
    }),
  );

  const bindingsView = bindings.map((b, i) => {
    const r = resolvedList[i];
    const pt = perTemplate[b.templateId] ?? { publishedVersions: [], expectedModules: [] };
    return {
      templateId: b.templateId,
      version: b.version,
      publishedVersions: pt.publishedVersions,
      resolvedVersion: r?.resolvedVersion ?? null,
      pinnedButUnavailable: r?.pinnedButUnavailable ?? false,
      templateUnavailable: r?.templateUnavailable ?? false,
    };
  });

  const missingModules = [...new Set(boundIds.flatMap((tid) => (perTemplate[tid]?.expectedModules ?? []).filter((id) => !activeIds.has(id))))];

  return {
    available,
    mode: bot.templateMode ?? 'or',
    bindings: bindingsView,
    missingModules,
    // Back-compat: primary binding + a flattened resolved preview for the old UI.
    binding: { templateId: bot.templateId ?? null, templateVersion: bot.templateVersion },
    publishedVersions: bindingsView[0]?.publishedVersions ?? [],
    resolved: {
      resolvedVersion: resolvedList[0]?.resolvedVersion ?? null,
      body: resolvedList[0]?.body ?? '',
      pinnedButUnavailable: resolvedList[0]?.pinnedButUnavailable ?? false,
      templateUnavailable: resolvedList[0]?.templateUnavailable ?? false,
    },
  };
}

export async function getBotTemplateOptions(req: Request, res: Response) {
  const tenantId = (req as Request & { tenantId: string }).tenantId;
  const bot = await loadOwnedBotOr404(req.params.id, tenantId);
  sendSuccess(res, await buildView(bot, tenantId));
}

export async function updateBotTemplateBinding(req: Request, res: Response) {
  const tenantId = (req as Request & { tenantId: string }).tenantId;
  const input = putBotTemplateBindingSchema.parse(req.body);
  const bot = await loadOwnedBotOr404(req.params.id, tenantId);

  // Normalize legacy single-binding shape → bindings list.
  const bindings = input.bindings ?? [{ templateId: input.templateId!, version: input.templateVersion ?? 'latest' }];

  // Every template must be bindable by this tenant (availableToAll ∪ grant, billable).
  const available = await listAvailableTemplates(tenantId);
  const availableIds = new Set(available.map((t) => t.id));
  for (const b of bindings) {
    if (!availableIds.has(b.templateId)) {
      throw new ForbiddenError('Template is not available to this tenant');
    }
    // A fixed pin must reference a published version.
    if (b.version !== 'latest') {
      const exists = await AppDataSource.getRepository(BotTemplateVersion).findOne({
        where: { templateId: b.templateId, version: Number.parseInt(b.version, 10), status: 'published' },
        select: ['id'],
      });
      if (!exists) throw new ValidationError(`Version ${b.version} is not a published version of template ${b.templateId}`);
    }
  }

  bot.templateBindings = bindings;
  bot.templateMode = input.mode ?? bot.templateMode ?? 'or';
  // Mirror the primary onto the legacy columns for back-compat queries.
  bot.templateId = bindings[0].templateId;
  bot.templateVersion = bindings[0].version;
  await AppDataSource.getRepository(Bot).save(bot);

  sendSuccess(res, await buildView(bot, tenantId));
}
