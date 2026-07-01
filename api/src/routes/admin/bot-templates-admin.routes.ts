/**
 * Super-admin bot-template authoring (.scratch/plan-bot-templates.md, Phase 3).
 *
 * The ONLY write path for bot_templates / bot_template_versions /
 * tenant_bot_templates. Mounted behind requireSuperAdmin. Lifecycle + safety
 * (version immutability, force-reassignment, cache fan-out, validation) live in
 * template-admin.service; these handlers stay thin and audit every write.
 *
 * Note on availableToAllTenants=false: it is NOT a runtime-stranding change —
 * resolveBoundTemplate binds by template_id and ignores availability, so bound
 * bots keep resolving. Availability gates NEW bindings only, so toggling it is a
 * plain metadata write (with cache fan-out), unlike archive/unpublish/un-grant
 * which DO strand and therefore block-or-force.
 */
import { Router, Request, Response } from 'express';
import { AppDataSource } from '../../database/data-source';
import { BotTemplate } from '../../database/entities/BotTemplate';
import { BotTemplateVersion } from '../../database/entities/BotTemplateVersion';
import { TenantBotTemplate } from '../../database/entities/TenantBotTemplate';
import { asyncHandler, ValidationError, NotFoundError, ConflictError, ApiError } from '../../middleware/error-handler';
import { sendSuccess } from '../../utils/response';
import { logAudit } from '../../utils/audit';
import { invalidateTemplateBundle, invalidateAllTenantTemplates } from '../../templates/template-resolver';
import {
  createDraftVersion,
  editDraftVersion,
  publishVersion,
  unpublishVersion,
  deleteVersion,
  rollbackToVersion,
  archiveTemplate,
  replaceGrants,
  validateBody,
  validateConfig,
  type Replacement,
} from '../../templates/template-admin.service';
import {
  createModule,
  editModule,
  createModuleDraftVersion,
  editModuleDraftVersion,
  publishModuleVersion,
  listModules,
} from '../../templates/module-admin.service';
import { buildSystemPrompt } from '../../llm/prompt-builder';
import { previewLedger } from '../../templates/template-preview';
import { DEFAULT_PROVIDER, DEFAULT_MODEL } from '../../llm/defaults';
import { ERROR_CODES } from '../../middleware/error-codes';
import { logger } from '../../utils/logger';
import { allModules, getModule } from '../../modules';
import type { ToolDefinition } from '../../llm/llm.types';
import { ToolRegistry } from '../../agent/tool-registry';

const router = Router();

function adminIdentity(req: Request): string {
  return (req as { user?: { email?: string } }).user?.email ?? req.userId ?? 'super-admin';
}

function reqStr(v: unknown, field: string, { max = 255, required = true } = {}): string | undefined {
  if (v === undefined || v === null || v === '') {
    if (required) throw new ValidationError(`${field} is required`);
    return undefined;
  }
  if (typeof v !== 'string') throw new ValidationError(`${field} must be a string`);
  if (v.length > max) throw new ValidationError(`${field} exceeds ${max} characters`);
  return v;
}

function parseVersion(raw: string): number {
  const n = Number.parseInt(raw, 10);
  if (!Number.isInteger(n) || n < 1) throw new ValidationError('version must be a positive integer');
  return n;
}

/** Parse { force?, replacement? } from a request body into the service options. */
function forceOpts(body: unknown): { force?: boolean; replacement?: Replacement } {
  const b = (body ?? {}) as { force?: unknown; replacement?: unknown };
  const opts: { force?: boolean; replacement?: Replacement } = {};
  if (b.force !== undefined) {
    if (typeof b.force !== 'boolean') throw new ValidationError('force must be a boolean');
    opts.force = b.force;
  }
  if (b.replacement !== undefined && b.replacement !== null) {
    const r = b.replacement as { templateId?: unknown; templateVersion?: unknown };
    const templateId = reqStr(r.templateId, 'replacement.templateId')!;
    const templateVersion = reqStr(r.templateVersion, 'replacement.templateVersion', { max: 20 })!;
    opts.replacement = { templateId, templateVersion };
  }
  return opts;
}

async function loadTemplate(id: string): Promise<BotTemplate> {
  const t = await AppDataSource.getRepository(BotTemplate).findOne({ where: { id } });
  if (!t) throw new NotFoundError('Template not found');
  return t;
}

// ── Templates ────────────────────────────────────────────────────────────────

// GET /admin/bot-templates — all templates with a version summary.
router.get(
  '/bot-templates',
  asyncHandler(async (_req: Request, res: Response) => {
    const templates = await AppDataSource.getRepository(BotTemplate).find({ order: { displayName: 'ASC' } });
    const versions = await AppDataSource.getRepository(BotTemplateVersion).find({
      select: ['templateId', 'version', 'status'],
    });
    const byTemplate = new Map<string, BotTemplateVersion[]>();
    for (const v of versions) {
      (byTemplate.get(v.templateId) ?? byTemplate.set(v.templateId, []).get(v.templateId)!).push(v);
    }
    sendSuccess(res, {
      templates: templates.map((t) => {
        const vs = byTemplate.get(t.id) ?? [];
        const published = vs.filter((v) => v.status === 'published').map((v) => v.version);
        return {
          id: t.id,
          key: t.key,
          displayName: t.displayName,
          category: t.category,
          description: t.description,
          availableToAllTenants: t.availableToAllTenants,
          status: t.status,
          versionCount: vs.length,
          draftCount: vs.filter((v) => v.status === 'draft').length,
          latestPublishedVersion: published.length ? Math.max(...published) : null,
        };
      }),
    });
  }),
);

// POST /admin/bot-templates — create template metadata (versions added separately).
router.post(
  '/bot-templates',
  asyncHandler(async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const key = reqStr(body.key, 'key', { max: 100 })!;
    const displayName = reqStr(body.displayName, 'displayName', { max: 200 })!;
    const category = reqStr(body.category, 'category', { max: 100, required: false }) ?? null;
    const description = reqStr(body.description, 'description', { max: 10_000, required: false }) ?? null;
    const availableToAllTenants = body.availableToAllTenants === true;

    const repo = AppDataSource.getRepository(BotTemplate);
    if (await repo.findOne({ where: { key } })) {
      throw new ConflictError(`A template with key "${key}" already exists`);
    }
    const tmpl = await repo.save(repo.create({ key, displayName, category, description, availableToAllTenants, status: 'active' }));
    await logAudit(req.userId!, 'bot_template.created', 'bot_template', tmpl.id, undefined, { key });
    if (availableToAllTenants) {
      // A new global template appears in every tenant's picker.
      await invalidateTemplateBundle(tmpl.id);
      await invalidateAllTenantTemplates();
    }
    res.status(201);
    sendSuccess(res, { template: tmpl });
  }),
);

// GET /admin/bot-templates/:id — template + all versions (for the editor).
router.get(
  '/bot-templates/:id',
  asyncHandler(async (req: Request, res: Response) => {
    const tmpl = await loadTemplate(req.params.id);
    const versions = await AppDataSource.getRepository(BotTemplateVersion).find({
      where: { templateId: tmpl.id },
      order: { version: 'DESC' },
    });
    const grants = await AppDataSource.getRepository(TenantBotTemplate).find({ where: { templateId: tmpl.id } });
    // Live usage — bots (across tenants) that bind this template in ANY binding
    // (primary column OR a secondary entry in template_bindings).
    const [usageRow] = await AppDataSource.query(
      `SELECT COUNT(*)::int AS bots, COUNT(DISTINCT tenant_id)::int AS tenants
         FROM chatbot_bots
        WHERE deleted_at IS NULL
          AND (template_id = $1 OR template_bindings @> $2::jsonb)`,
      [tmpl.id, JSON.stringify([{ templateId: tmpl.id }])],
    );
    sendSuccess(res, {
      template: tmpl,
      versions,
      grantedTenantIds: grants.map((g) => g.tenantId),
      usage: { bots: usageRow?.bots ?? 0, tenants: usageRow?.tenants ?? 0 },
      moduleCatalog: allModules().map((m) => ({ id: m.id, displayName: m.displayName })),
    });
  }),
);

// PUT /admin/bot-templates/:id — update metadata + availableToAllTenants.
router.put(
  '/bot-templates/:id',
  asyncHandler(async (req: Request, res: Response) => {
    const tmpl = await loadTemplate(req.params.id);
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (body.displayName !== undefined) tmpl.displayName = reqStr(body.displayName, 'displayName', { max: 200 })!;
    if (body.category !== undefined) tmpl.category = reqStr(body.category, 'category', { max: 100, required: false }) ?? null;
    if (body.description !== undefined) tmpl.description = reqStr(body.description, 'description', { max: 10_000, required: false }) ?? null;

    let availabilityChanged = false;
    if (body.availableToAllTenants !== undefined) {
      if (typeof body.availableToAllTenants !== 'boolean') throw new ValidationError('availableToAllTenants must be a boolean');
      availabilityChanged = tmpl.availableToAllTenants !== body.availableToAllTenants;
      tmpl.availableToAllTenants = body.availableToAllTenants;
    }

    const saved = await AppDataSource.getRepository(BotTemplate).save(tmpl);
    await logAudit(req.userId!, 'bot_template.updated', 'bot_template', tmpl.id, undefined, {
      availableToAllTenants: saved.availableToAllTenants,
    });
    if (availabilityChanged) {
      // Toggling availableToAllTenants changes the listing for ALL tenants
      // (it appears or disappears globally) → one O(1) global bump. Availability
      // gates new bindings only; existing bound bots keep resolving (bundle).
      await invalidateTemplateBundle(tmpl.id);
      await invalidateAllTenantTemplates();
    }
    sendSuccess(res, { template: saved });
  }),
);

// POST /admin/bot-templates/:id/archive — block-or-force while bots are bound.
router.post(
  '/bot-templates/:id/archive',
  asyncHandler(async (req: Request, res: Response) => {
    await loadTemplate(req.params.id);
    const { template, reassignedTenants } = await archiveTemplate(req.params.id, forceOpts(req.body));
    await logAudit(req.userId!, 'bot_template.archived', 'bot_template', template.id, undefined, {
      reassignedTenants: reassignedTenants.length,
    });
    sendSuccess(res, { template, reassignedTenants });
  }),
);

// POST /admin/bot-templates/test-chat — preview a prompt+config WITHOUT saving a
// version, so authors can try a draft before publishing. Prompt-only (no KB), run
// on the platform LLM with sample {botName}/{businessName} substitutions.
router.post(
  '/bot-templates/test-chat',
  asyncHandler(async (req: Request, res: Response) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const message = reqStr(b.message, 'message', { max: 4000 })!;
    const body = typeof b.body === 'string' ? b.body : '';
    validateBody(body);
    const config = validateConfig(b.config);
    const history = Array.isArray(b.history)
      ? (b.history as unknown[])
          .filter((m): m is { role: string; content: string } =>
            !!m && typeof (m as { content?: unknown }).content === 'string')
          .slice(-10)
          .map((m) => ({ role: m.role === 'assistant' ? ('assistant' as const) : ('user' as const), content: m.content }))
      : [];

    // Build a tenant-style ai slice from the template config; sample identity so
    // {botName}/{businessName} resolve to readable preview values.
    const ai = {
      enabled: true,
      brandVoice: { name: 'Assistant', tone: config.tone || 'friendly', customInstructions: '' },
      guardrails: {
        topicsToAvoid: config.guardrails?.topicsToAvoid ?? [],
        greetingMessage: config.guardrails?.greetingMessage ?? '',
        fallbackMessage: config.guardrails?.fallbackMessage ?? '',
        offHoursMessage: config.guardrails?.offHoursMessage ?? '',
        confidenceThreshold: config.guardrails?.confidenceThreshold ?? 0.7,
        maxResponseLength: config.guardrails?.maxResponseLength ?? 500,
        escalationKeywords: [],
      },
    } as Parameters<typeof buildSystemPrompt>[0];

    const systemPrompt = buildSystemPrompt(ai, { businessName: 'Your Business', templateBody: body });
    const { getProvider } = await import('../../llm/provider-factory');
    const llm = getProvider(DEFAULT_PROVIDER);
    const messages = [
      { role: 'system' as const, content: systemPrompt },
      ...history,
      { role: 'user' as const, content: message },
    ];
    let response;
    try {
      response = await llm.chat(messages, { model: DEFAULT_MODEL, maxTokens: 1000, temperature: 0.3, jsonMode: false });
    } catch (err) {
      logger.error('Template test chat failed', err);
      throw new ApiError('LLM call failed. Check the platform API key.', 500, ERROR_CODES.UPSTREAM_FAILED);
    }
    sendSuccess(res, { response: response.content, provider: DEFAULT_PROVIDER, model: DEFAULT_MODEL });
  }),
);

/**
 * L10/Phase 4 — preview the COMPILED agent-mode prompt + block ledger for a template
 * under a mock runtime context (tier / activeModules / channel). Pure composition, no
 * LLM call. The base-mode test-chat above is untouched. Lets a superadmin see exactly
 * which blocks a given context would include/exclude (and why) before publishing.
 *
 *   POST /admin/bot-templates/preview-ledger  { body, config, tier?, channel?, activeModules? }
 *
 * CAVEAT: mock tier/modules bypass entitlement checks — this is a what-if, not a
 * guarantee the live ledger matches on that tier.
 */
router.post(
  '/bot-templates/preview-ledger',
  asyncHandler(async (req: Request, res: Response) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const body = typeof b.body === 'string' ? b.body : '';
    validateBody(body);
    const config = validateConfig(b.config);
    const tier = (['free', 'essential', 'pro', 'enterprise'] as const).find((t) => t === b.tier);
    const channel = typeof b.channel === 'string' ? b.channel : 'widget';
    const activeModules = Array.isArray(b.activeModules)
      ? (b.activeModules as unknown[]).filter((x): x is string => typeof x === 'string')
      : [];

    const result = previewLedger({
      body,
      tone: config.tone,
      topicsToAvoid: config.guardrails?.topicsToAvoid ?? [],
      maxResponseLength: config.guardrails?.maxResponseLength ?? 500,
      tier,
      channel,
      activeModules,
    });

    sendSuccess(res, {
      ...result,
      caveat: 'Preview only — mock tier/modules bypass entitlement checks; the live ledger may differ.',
    });
  }),
);

// ── Versions ─────────────────────────────────────────────────────────────────

// POST /admin/bot-templates/:id/versions — create a draft.
router.post(
  '/bot-templates/:id/versions',
  asyncHandler(async (req: Request, res: Response) => {
    await loadTemplate(req.params.id);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const text = typeof body.body === 'string' ? body.body : '';
    const { warnings } = validateBody(text);
    const version = await createDraftVersion(req.params.id, {
      body: text,
      changelog: reqStr(body.changelog, 'changelog', { max: 500, required: false }) ?? null,
      expectedModules: body.expectedModules,
      selectedModuleRefs: body.selectedModuleRefs,
      config: body.config,
    });
    await logAudit(req.userId!, 'bot_template.version_created', 'bot_template', req.params.id, undefined, { version: version.version });
    res.status(201);
    sendSuccess(res, { version, warnings });
  }),
);

// PUT /admin/bot-templates/:id/versions/:version — edit a DRAFT (optimistic concurrency).
router.put(
  '/bot-templates/:id/versions/:version',
  asyncHandler(async (req: Request, res: Response) => {
    const version = parseVersion(req.params.version);
    const body = (req.body ?? {}) as Record<string, unknown>;
    let warnings: string[] = [];
    if (typeof body.body === 'string') warnings = validateBody(body.body).warnings;
    const lockVersion = body.lockVersion === undefined ? undefined : Number(body.lockVersion);
    const updated = await editDraftVersion(req.params.id, version, {
      body: typeof body.body === 'string' ? body.body : undefined,
      changelog: body.changelog === undefined ? undefined : (reqStr(body.changelog, 'changelog', { max: 500, required: false }) ?? null),
      expectedModules: body.expectedModules,
      selectedModuleRefs: body.selectedModuleRefs,
      config: body.config,
      lockVersion,
    });
    await logAudit(req.userId!, 'bot_template.version_edited', 'bot_template', req.params.id, undefined, { version });
    sendSuccess(res, { version: updated, warnings });
  }),
);

// POST /admin/bot-templates/:id/versions/:version/publish
router.post(
  '/bot-templates/:id/versions/:version/publish',
  asyncHandler(async (req: Request, res: Response) => {
    const version = parseVersion(req.params.version);
    const published = await publishVersion(req.params.id, version, adminIdentity(req));
    await logAudit(req.userId!, 'bot_template.version_published', 'bot_template', req.params.id, undefined, { version });
    sendSuccess(res, { version: published });
  }),
);

// POST /admin/bot-templates/:id/versions/:version/unpublish — block-or-force on pins.
router.post(
  '/bot-templates/:id/versions/:version/unpublish',
  asyncHandler(async (req: Request, res: Response) => {
    const version = parseVersion(req.params.version);
    const { version: updated, reassignedTenants } = await unpublishVersion(req.params.id, version, forceOpts(req.body));
    await logAudit(req.userId!, 'bot_template.version_unpublished', 'bot_template', req.params.id, undefined, {
      version,
      reassignedTenants: reassignedTenants.length,
    });
    sendSuccess(res, { version: updated, reassignedTenants });
  }),
);

// DELETE /admin/bot-templates/:id/versions/:version — delete a draft/unpublished
// version (published is protected). Block-or-force when an unpublished version is pinned.
router.delete(
  '/bot-templates/:id/versions/:version',
  asyncHandler(async (req: Request, res: Response) => {
    const version = parseVersion(req.params.version);
    const { reassignedTenants } = await deleteVersion(req.params.id, version, forceOpts(req.body));
    await logAudit(req.userId!, 'bot_template.version_deleted', 'bot_template', req.params.id, undefined, {
      version,
      reassignedTenants: reassignedTenants.length,
    });
    sendSuccess(res, { reassignedTenants });
  }),
);

// POST /admin/bot-templates/:id/rollback — publish a NEW version copied from an old one.
router.post(
  '/bot-templates/:id/rollback',
  asyncHandler(async (req: Request, res: Response) => {
    await loadTemplate(req.params.id);
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (body.fromVersion === undefined) throw new ValidationError('fromVersion is required');
    const fromVersion = parseVersion(String(body.fromVersion));
    const published = await rollbackToVersion(req.params.id, fromVersion, adminIdentity(req));
    await logAudit(req.userId!, 'bot_template.rolled_back', 'bot_template', req.params.id, undefined, {
      fromVersion,
      newVersion: published.version,
    });
    res.status(201);
    sendSuccess(res, { version: published });
  }),
);

// ── Grants ───────────────────────────────────────────────────────────────────

// GET /admin/bot-templates/:id/grants
router.get(
  '/bot-templates/:id/grants',
  asyncHandler(async (req: Request, res: Response) => {
    await loadTemplate(req.params.id);
    const grants = await AppDataSource.getRepository(TenantBotTemplate).find({ where: { templateId: req.params.id } });
    sendSuccess(res, { grantedTenantIds: grants.map((g) => g.tenantId) });
  }),
);

// PUT /admin/bot-templates/:id/grants — replace the grant set (block-or-force on removal).
router.put(
  '/bot-templates/:id/grants',
  asyncHandler(async (req: Request, res: Response) => {
    await loadTemplate(req.params.id);
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (!Array.isArray(body.tenantIds)) throw new ValidationError('tenantIds must be an array');
    const tenantIds = body.tenantIds.map((t, i) => reqStr(t, `tenantIds[${i}]`)!);
    const { force, replacement } = forceOpts(req.body);
    const result = await replaceGrants(req.params.id, tenantIds, { force, replacement, setBy: adminIdentity(req) });
    await logAudit(req.userId!, 'bot_template.grants_updated', 'bot_template', req.params.id, undefined, {
      granted: result.granted.length,
      reassignedTenants: result.reassignedTenants.length,
    });
    sendSuccess(res, result);
  }),
);

// ── Authored Modules (composable-templates Phase 4) ──────────────────────────
// Super-admin CRUD for authored Modules + their immutable versions. Same auth +
// audit posture as the template routes above (mounted behind requireSuperAdmin).

// GET /admin/skills — the engineered skill catalog (read-only; skills are code,
// not authorable). Rich metadata feeds the Studio Skills tab + the module picker.
router.get(
  '/skills',
  asyncHandler(async (_req: Request, res: Response) => {
    sendSuccess(res, {
      skills: allModules().map((m) => ({
        id: m.id,
        displayName: m.displayName,
        description: m.description ?? null,
        readinessHint: m.readinessHint ?? null,
        feature: m.gate.kind === 'feature' ? m.gate.feature : null,
        provides: m.provides ?? m.tools.map((t) => t.name),
      })),
    });
  }),
);

// GET /admin/modules — list modules with their versions.
router.get(
  '/modules',
  asyncHandler(async (_req: Request, res: Response) => {
    sendSuccess(res, { modules: await listModules() });
  }),
);

// POST /admin/modules — create a module + its first draft version.
router.post(
  '/modules',
  asyncHandler(async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const result = await createModule({
      name: body.name,
      description: body.description,
      skillIds: body.skillIds,
      prose: body.prose,
    });
    await logAudit(req.userId!, 'module.created', 'module', result.module.id, undefined, { name: result.module.name });
    res.status(201);
    sendSuccess(res, result);
  }),
);

// PUT /admin/modules/:id — edit a module's catalog fields.
router.put(
  '/modules/:id',
  asyncHandler(async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const module = await editModule(req.params.id, {
      name: body.name,
      description: body.description,
      skillIds: body.skillIds,
    });
    await logAudit(req.userId!, 'module.edited', 'module', req.params.id, undefined, undefined);
    sendSuccess(res, { module });
  }),
);

// POST /admin/modules/:id/versions — create a draft version.
router.post(
  '/modules/:id/versions',
  asyncHandler(async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const version = await createModuleDraftVersion(req.params.id, { prose: body.prose });
    await logAudit(req.userId!, 'module.version_created', 'module', req.params.id, undefined, { version: version.version });
    res.status(201);
    sendSuccess(res, { version });
  }),
);

// PUT /admin/modules/:id/versions/:version — edit a DRAFT (optimistic concurrency).
router.put(
  '/modules/:id/versions/:version',
  asyncHandler(async (req: Request, res: Response) => {
    const version = parseVersion(req.params.version);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const lockVersion = body.lockVersion === undefined ? undefined : Number(body.lockVersion);
    const updated = await editModuleDraftVersion(req.params.id, version, { prose: body.prose, lockVersion });
    await logAudit(req.userId!, 'module.version_edited', 'module', req.params.id, undefined, { version });
    sendSuccess(res, { version: updated });
  }),
);

// POST /admin/modules/:id/versions/:version/publish — draft → published (frozen).
router.post(
  '/modules/:id/versions/:version/publish',
  asyncHandler(async (req: Request, res: Response) => {
    const version = parseVersion(req.params.version);
    const published = await publishModuleVersion(req.params.id, version, req.userId!);
    await logAudit(req.userId!, 'module.version_published', 'module', req.params.id, undefined, { version });
    sendSuccess(res, { version: published });
  }),
);

// POST /admin/modules/test-agent — DRY-RUN skill test. Runs ONE agent-mode turn with
// the bound skills' tools ADVERTISED to the model, but NEVER executes a tool: we
// capture the tool call(s) the model decides to make (name + args) so an author can
// see the skill "fire" with zero side effects (no real booking/handoff). Prose-driven,
// platform LLM, no KB — the authoring-time counterpart to the base prose test-chat.
router.post(
  '/modules/test-agent',
  asyncHandler(async (req: Request, res: Response) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const message = reqStr(b.message, 'message', { max: 4000 })!;
    const prose = typeof b.prose === 'string' ? b.prose : '';
    if (prose.length > 8000) throw new ValidationError('prose is too long to test (max 8000 chars)');
    const skillIds = Array.isArray(b.skillIds) ? b.skillIds.filter((x): x is string => typeof x === 'string') : [];
    const history = Array.isArray(b.history)
      ? (b.history as unknown[])
          .filter((m): m is { role: string; content: string } => !!m && typeof (m as { content?: unknown }).content === 'string')
          .slice(-10)
          .map((m) => ({ role: m.role === 'assistant' ? ('assistant' as const) : ('user' as const), content: m.content }))
      : [];

    // Advertise the bound skills' tools (deduped by name). Inert catalog skills have no
    // `tools`, so synthesise a minimal def from their `provides` names — enough for the
    // model to decide to call them.
    const registry = new ToolRegistry();
    const seen = new Set<string>();
    const toolDefs: ToolDefinition[] = [];
    for (const sid of skillIds) {
      const def = getModule(sid);
      if (!def) continue;
      if (def.tools.length) {
        for (const t of def.tools) {
          if (seen.has(t.name)) continue;
          seen.add(t.name);
          toolDefs.push({ name: t.name, description: t.description, parameters: t.parameters });
        }
      } else {
        // Inert catalog skill (no tools of its own): advertise the REAL builtin tool
        // it provides (with its actual parameters), falling back to a minimal def.
        for (const name of def.provides ?? []) {
          if (seen.has(name)) continue;
          seen.add(name);
          toolDefs.push(
            registry.builtinToolDef(name) ?? {
              name,
              description: `Run the ${def.displayName} skill.`,
              parameters: { type: 'object', properties: {} },
            },
          );
        }
      }
    }

    const ai = {
      enabled: true,
      brandVoice: { name: 'Assistant', tone: 'friendly', customInstructions: '' },
      guardrails: {},
    } as Parameters<typeof buildSystemPrompt>[0];
    const base = buildSystemPrompt(ai, { businessName: 'Your Business', templateBody: prose });
    const systemPrompt = `${base}\n\nWhen the customer's request calls for it, use the appropriate tool.`;

    const { getProvider } = await import('../../llm/provider-factory');
    const llm = getProvider(DEFAULT_PROVIDER);
    const messages = [
      { role: 'system' as const, content: systemPrompt },
      ...history,
      { role: 'user' as const, content: message },
    ];
    let out;
    try {
      out = await llm.chat(messages, {
        model: DEFAULT_MODEL,
        maxTokens: 800,
        temperature: 0.3,
        jsonMode: false,
        tools: toolDefs.length ? toolDefs : undefined,
      });
    } catch (err) {
      logger.error('Module dry-run skill test failed', err);
      throw new ApiError('LLM call failed. Check the platform API key.', 500, ERROR_CODES.UPSTREAM_FAILED);
    }
    // DRY RUN — we never execute a tool; we only report the model's decision.
    const toolCalls = (out.toolCalls ?? []).map((tc) => ({ name: tc.name, arguments: tc.arguments }));
    sendSuccess(res, { response: out.content || null, toolCalls, availableTools: toolDefs.map((t) => t.name) });
  }),
);

export default router;
