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
import { asyncHandler, ValidationError, NotFoundError, ConflictError } from '../../middleware/error-handler';
import { sendSuccess } from '../../utils/response';
import { logAudit } from '../../utils/audit';
import { invalidateTemplateBundle, invalidateAllTenantTemplates } from '../../templates/template-resolver';
import {
  createDraftVersion,
  editDraftVersion,
  publishVersion,
  unpublishVersion,
  rollbackToVersion,
  archiveTemplate,
  replaceGrants,
  validateBody,
  type Replacement,
} from '../../templates/template-admin.service';

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
    sendSuccess(res, { template: tmpl, versions, grantedTenantIds: grants.map((g) => g.tenantId) });
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

export default router;
