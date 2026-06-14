/**
 * Tenant-facing bot↔template binding (.scratch/plan-bot-templates.md, Phase 4).
 *
 * - GET  /bots/:id/templates — templates this tenant may bind + the bot's
 *   current binding + the resolved preview (body, version, fallback flags) +
 *   the published version list (for the pin dropdown) + any expectedModules
 *   the template wants that aren't active for the tenant (advisory, T13).
 * - PUT  /bots/:id/template — set Bot.template_id / Bot.template_version after
 *   validating the template is available and the pinned version is published.
 */
import { Request, Response } from 'express';
import { AppDataSource } from '../database/data-source';
import { Bot } from '../database/entities/Bot';
import { BotTemplateVersion } from '../database/entities/BotTemplateVersion';
import { getOwnedBot, BotNotFoundConfigError } from '../services/bot-config.service';
import { listAvailableTemplates, resolveBoundTemplate } from '../templates/template-resolver';
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

/** Shared response shape for GET and PUT — the full picker view. */
async function buildView(bot: Bot, tenantId: string) {
  const [available, resolved, activeModules] = await Promise.all([
    listAvailableTemplates(tenantId),
    resolveBoundTemplate(bot),
    listActiveModules(tenantId),
  ]);

  let publishedVersions: number[] = [];
  let expectedModules: string[] = [];
  if (bot.templateId) {
    const versions = await AppDataSource.getRepository(BotTemplateVersion).find({
      where: { templateId: bot.templateId, status: 'published' },
      select: ['version', 'expectedModules'],
      order: { version: 'DESC' },
    });
    publishedVersions = versions.map((v) => v.version);
    expectedModules = versions.find((v) => v.version === resolved.resolvedVersion)?.expectedModules ?? [];
  }
  const activeIds = new Set(activeModules.map((m) => m.module.id));
  const missingModules = expectedModules.filter((id) => !activeIds.has(id));

  return {
    available,
    binding: { templateId: bot.templateId ?? null, templateVersion: bot.templateVersion },
    resolved: {
      resolvedVersion: resolved.resolvedVersion,
      body: resolved.body,
      pinnedButUnavailable: resolved.pinnedButUnavailable,
      templateUnavailable: resolved.templateUnavailable,
    },
    publishedVersions,
    missingModules,
  };
}

export async function getBotTemplateOptions(req: Request, res: Response) {
  const tenantId = (req as Request & { tenantId: string }).tenantId;
  const bot = await loadOwnedBotOr404(req.params.id, tenantId);
  sendSuccess(res, await buildView(bot, tenantId));
}

export async function updateBotTemplateBinding(req: Request, res: Response) {
  const tenantId = (req as Request & { tenantId: string }).tenantId;
  const { templateId, templateVersion } = putBotTemplateBindingSchema.parse(req.body);
  const bot = await loadOwnedBotOr404(req.params.id, tenantId);

  // Must be a template this tenant may bind (availableToAll ∪ grant, billable).
  const available = await listAvailableTemplates(tenantId);
  if (!available.some((t) => t.id === templateId)) {
    throw new ForbiddenError('Template is not available to this tenant');
  }
  // A fixed pin must reference a published version.
  if (templateVersion !== 'latest') {
    const exists = await AppDataSource.getRepository(BotTemplateVersion).findOne({
      where: { templateId, version: Number.parseInt(templateVersion, 10), status: 'published' },
      select: ['id'],
    });
    if (!exists) throw new ValidationError(`Version ${templateVersion} is not a published version of this template`);
  }

  bot.templateId = templateId;
  bot.templateVersion = templateVersion;
  await AppDataSource.getRepository(Bot).save(bot);

  sendSuccess(res, await buildView(bot, tenantId));
}
