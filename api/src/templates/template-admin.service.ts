/**
 * Super-admin template authoring service — the lifecycle + safety logic behind
 * the /admin/bot-templates endpoints (.scratch/plan-bot-templates.md, Phase 3).
 *
 * Centralizes the intricate bits so the routes stay thin:
 *   - T19: transactional version-number allocation (row-locked), published
 *     versions are immutable, rollback = publish a NEW copy, draft edits use
 *     the lock_version optimistic-concurrency token.
 *   - T21: ONE force-reassignment contract for archive / unpublish / un-grant
 *     while bots are bound — block (409 + impacted count) unless force, then
 *     reassign to an explicit replacement or the default (same template's
 *     latest still-published version, else blank-base @ latest).
 *   - T20: cache fan-out (bundle + affected tenants' availability) on every
 *     content/access change.
 *   - T22: body length cap, expectedModules lint, placeholder lint.
 */
import { EntityManager } from 'typeorm';
import { AppDataSource } from '../database/data-source';
import { BotTemplate } from '../database/entities/BotTemplate';
import { BotTemplateVersion, BotTemplateConfig } from '../database/entities/BotTemplateVersion';
import { TenantBotTemplate } from '../database/entities/TenantBotTemplate';
import { Bot } from '../database/entities/Bot';
import { getModule } from '../modules';
import { ConflictError, NotFoundError, ValidationError } from '../middleware/error-handler';
import { invalidateTemplateBundle, invalidateTenantTemplates, invalidateAllTenantTemplates } from './template-resolver';

/** Template body cap (T22) — characters, matching the codebase's char-based caps. */
export const TEMPLATE_BODY_MAX = 20_000;

/** Canonical {placeholder} set (mirrors compose-system-prompt's buildVariableMap). */
const KNOWN_PLACEHOLDERS = new Set([
  'botName', 'tone', 'supportEmail', 'businessName',
  'fallbackMessage', 'offHoursMessage', 'greetingMessage',
  'maxResponseLength', 'topicsToAvoid',
]);
const PLACEHOLDER_RE = /\{(\w+)\}/g;

const BLANK_BASE_KEY = 'blank-base';

// ── Validation (T22) ─────────────────────────────────────────────────────────

/** Throws on an over-cap body. Returns placeholder-lint warnings (non-blocking). */
export function validateBody(body: string): { warnings: string[] } {
  if (typeof body !== 'string') throw new ValidationError('body must be a string');
  if (body.length > TEMPLATE_BODY_MAX) {
    throw new ValidationError(`body exceeds ${TEMPLATE_BODY_MAX} characters (${body.length})`);
  }
  const unknown = new Set<string>();
  for (const m of body.matchAll(PLACEHOLDER_RE)) {
    if (!KNOWN_PLACEHOLDERS.has(m[1])) unknown.add(m[1]);
  }
  const warnings = unknown.size
    ? [`Unknown placeholders (left as literal text): ${[...unknown].map((k) => `{${k}}`).join(', ')}`]
    : [];
  return { warnings };
}

/** Normalizes + validates expectedModules: must be known catalog module ids (T13/T22). */
export function validateExpectedModules(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new ValidationError('expectedModules must be an array of module ids');
  const out: string[] = [];
  for (const id of value) {
    if (typeof id !== 'string' || !id.trim()) throw new ValidationError('expectedModules entries must be non-empty strings');
    if (!getModule(id)) throw new ValidationError(`expectedModules: unknown module id "${id}"`);
    out.push(id);
  }
  return out;
}

/** Caps for the template-owned policy guardrails (mirror the per-bot form caps). */
const GUARDRAIL_TEXT_MAX = 1000;
const TOPICS_MAX = 50;

/**
 * Normalizes + validates the template's tone + policy guardrails config.
 * Returns a clean BotTemplateConfig (only the keys the admin actually set), so an
 * empty input persists `{}` and the resolver falls back to platform defaults.
 */
export function validateConfig(value: unknown): BotTemplateConfig {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new ValidationError('config must be an object');
  }
  const v = value as Record<string, unknown>;
  const out: BotTemplateConfig = {};

  if (v.tone !== undefined) {
    if (typeof v.tone !== 'string' || !v.tone.trim()) throw new ValidationError('config.tone must be a non-empty string');
    if (v.tone.length > 100) throw new ValidationError('config.tone is too long');
    out.tone = v.tone.trim();
  }

  if (v.guardrails !== undefined) {
    if (typeof v.guardrails !== 'object' || v.guardrails === null || Array.isArray(v.guardrails)) {
      throw new ValidationError('config.guardrails must be an object');
    }
    const g = v.guardrails as Record<string, unknown>;
    const out_g: NonNullable<BotTemplateConfig['guardrails']> = {};

    if (g.topicsToAvoid !== undefined) {
      if (!Array.isArray(g.topicsToAvoid)) throw new ValidationError('config.guardrails.topicsToAvoid must be an array');
      if (g.topicsToAvoid.length > TOPICS_MAX) throw new ValidationError(`config.guardrails.topicsToAvoid exceeds ${TOPICS_MAX} entries`);
      out_g.topicsToAvoid = g.topicsToAvoid.map((t) => {
        if (typeof t !== 'string' || !t.trim()) throw new ValidationError('config.guardrails.topicsToAvoid entries must be non-empty strings');
        return t.trim();
      });
    }

    for (const key of ['greetingMessage', 'fallbackMessage', 'offHoursMessage'] as const) {
      if (g[key] !== undefined) {
        if (typeof g[key] !== 'string') throw new ValidationError(`config.guardrails.${key} must be a string`);
        if ((g[key] as string).length > GUARDRAIL_TEXT_MAX) throw new ValidationError(`config.guardrails.${key} exceeds ${GUARDRAIL_TEXT_MAX} characters`);
        out_g[key] = g[key] as string;
      }
    }

    if (g.confidenceThreshold !== undefined) {
      const n = g.confidenceThreshold;
      if (typeof n !== 'number' || Number.isNaN(n) || n < 0 || n > 1) throw new ValidationError('config.guardrails.confidenceThreshold must be a number between 0 and 1');
      out_g.confidenceThreshold = n;
    }
    if (g.maxResponseLength !== undefined) {
      const n = g.maxResponseLength;
      if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > 10000) throw new ValidationError('config.guardrails.maxResponseLength must be an integer between 1 and 10000');
      out_g.maxResponseLength = n;
    }

    if (Object.keys(out_g).length > 0) out.guardrails = out_g;
  }

  return out;
}

// ── Replacement / impacted-bot helpers (T21) ─────────────────────────────────

async function getBlankBase(manager: EntityManager): Promise<BotTemplate> {
  const t = await manager.getRepository(BotTemplate).findOne({ where: { key: BLANK_BASE_KEY } });
  if (!t) throw new Error('blank-base template missing — run the CreateBotTemplates migration');
  return t;
}

export interface Replacement {
  templateId: string;
  templateVersion: string;
}

/** blank-base @ latest — the replacement when a template/grant becomes wholly
 *  unusable for the affected bots (archive, un-grant). */
async function blankBaseReplacement(manager: EntityManager): Promise<Replacement> {
  const blank = await getBlankBase(manager);
  return { templateId: blank.id, templateVersion: 'latest' };
}

/**
 * Default replacement per T21: the same template's latest still-published
 * version (optionally excluding one being withdrawn) if the template is still
 * active and has one; otherwise blank-base @ latest.
 */
async function resolveDefaultReplacement(
  manager: EntityManager,
  templateId: string,
  excludeVersion?: number,
): Promise<Replacement> {
  const tmpl = await manager.getRepository(BotTemplate).findOne({ where: { id: templateId } });
  if (tmpl && tmpl.status === 'active') {
    const qb = manager
      .getRepository(BotTemplateVersion)
      .createQueryBuilder('v')
      .select('MAX(v.version)', 'max')
      .where('v.templateId = :templateId AND v.status = :status', { templateId, status: 'published' });
    if (excludeVersion !== undefined) qb.andWhere('v.version != :ex', { ex: excludeVersion });
    const row = await qb.getRawOne<{ max: number | null }>();
    if (row?.max != null) return { templateId, templateVersion: String(row.max) };
  }
  const blank = await getBlankBase(manager);
  return { templateId: blank.id, templateVersion: 'latest' };
}

/** Count bots bound to a template, optionally scoped to a tenant and/or a fixed pinned version. */
async function countBoundBots(
  manager: EntityManager,
  templateId: string,
  opts: { tenantId?: string; pinnedVersion?: number } = {},
): Promise<number> {
  const qb = manager
    .getRepository(Bot)
    .createQueryBuilder('b')
    .where('b.templateId = :templateId', { templateId })
    .andWhere('b.deletedAt IS NULL');
  if (opts.tenantId) qb.andWhere('b.tenantId = :tenantId', { tenantId: opts.tenantId });
  if (opts.pinnedVersion !== undefined) qb.andWhere('b.templateVersion = :pv', { pv: String(opts.pinnedVersion) });
  return qb.getCount();
}

/** Reassign matching bots to a replacement binding. Returns the affected tenant ids. */
async function reassignBots(
  manager: EntityManager,
  where: { templateId: string; tenantId?: string; pinnedVersion?: number },
  replacement: Replacement,
): Promise<string[]> {
  const qb = manager
    .getRepository(Bot)
    .createQueryBuilder('b')
    .select('DISTINCT b.tenantId', 'tenantId')
    .where('b.templateId = :templateId', { templateId: where.templateId })
    .andWhere('b.deletedAt IS NULL');
  if (where.tenantId) qb.andWhere('b.tenantId = :tenantId', { tenantId: where.tenantId });
  if (where.pinnedVersion !== undefined) qb.andWhere('b.templateVersion = :pv', { pv: String(where.pinnedVersion) });
  const tenantRows = await qb.getRawMany<{ tenantId: string }>();

  const upd = manager
    .getRepository(Bot)
    .createQueryBuilder()
    .update(Bot)
    .set({ templateId: replacement.templateId, templateVersion: replacement.templateVersion })
    .where('template_id = :templateId', { templateId: where.templateId })
    .andWhere('deleted_at IS NULL');
  if (where.tenantId) upd.andWhere('tenant_id = :tenantId', { tenantId: where.tenantId });
  if (where.pinnedVersion !== undefined) upd.andWhere('template_version = :pv', { pv: String(where.pinnedVersion) });
  await upd.execute();

  return tenantRows.map((r) => r.tenantId);
}

// ── Cache fan-out (T20) ──────────────────────────────────────────────────────

/**
 * Invalidate a template's content bundle + the availability cache for every
 * tenant that can currently reach it (explicit grants). Globally-available
 * templates rely on the short availability TTL for the listing refresh; the
 * bundle (which drives live prompt resolution) is always invalidated here.
 */
async function fanOutTemplateInvalidation(templateId: string, extraTenantIds: string[] = []): Promise<void> {
  await invalidateTemplateBundle(templateId);

  // A globally-available template's change affects EVERY tenant's listing → one
  // O(1) global bump. (availableToAllTenants still reflects "was global" during
  // archive, since archive flips status, not the flag.)
  const tmpl = await AppDataSource.getRepository(BotTemplate).findOne({
    where: { id: templateId },
    select: ['availableToAllTenants'],
  });
  if (tmpl?.availableToAllTenants) {
    await invalidateAllTenantTemplates();
  }

  // Granted (non-global) templates + reassign-affected tenants: per-tenant.
  const grants = await AppDataSource.getRepository(TenantBotTemplate).find({
    where: { templateId },
    select: ['tenantId'],
  });
  const tenantIds = new Set<string>([...grants.map((g) => g.tenantId), ...extraTenantIds]);
  await Promise.all([...tenantIds].map((t) => invalidateTenantTemplates(t)));
}

// ── Version lifecycle (T19) ──────────────────────────────────────────────────

/** Create a draft version with a row-locked, transactionally-allocated number. */
export async function createDraftVersion(
  templateId: string,
  input: { body: string; changelog?: string | null; expectedModules?: unknown; config?: unknown },
): Promise<BotTemplateVersion> {
  const { warnings: _w } = validateBody(input.body);
  const expectedModules = validateExpectedModules(input.expectedModules);
  const config = validateConfig(input.config);

  return AppDataSource.transaction(async (manager) => {
    // Lock the template row so concurrent draft creation can't collide on version#.
    const locked = await manager
      .getRepository(BotTemplate)
      .createQueryBuilder('t')
      .setLock('pessimistic_write')
      .where('t.id = :id', { id: templateId })
      .getOne();
    if (!locked) throw new NotFoundError('Template not found');

    const max = await manager
      .getRepository(BotTemplateVersion)
      .createQueryBuilder('v')
      .select('COALESCE(MAX(v.version), 0)', 'max')
      .where('v.templateId = :templateId', { templateId })
      .getRawOne<{ max: number }>();
    const version = Number(max?.max ?? 0) + 1;

    const repo = manager.getRepository(BotTemplateVersion);
    const row = repo.create({
      templateId,
      version,
      body: input.body,
      changelog: input.changelog?.trim() || null,
      expectedModules,
      config,
      status: 'draft',
      lockVersion: 0,
    });
    return repo.save(row);
  });
}

/** Edit a DRAFT version. Published/unpublished versions are immutable (409). */
export async function editDraftVersion(
  templateId: string,
  version: number,
  input: { body?: string; changelog?: string | null; expectedModules?: unknown; config?: unknown; lockVersion?: number },
): Promise<BotTemplateVersion> {
  return AppDataSource.transaction(async (manager) => {
    const repo = manager.getRepository(BotTemplateVersion);
    const row = await repo.findOne({ where: { templateId, version } });
    if (!row) throw new NotFoundError('Template version not found');
    if (row.status !== 'draft') {
      throw new ConflictError('Only draft versions are editable; published versions are immutable', {
        status: row.status,
      });
    }
    if (input.lockVersion !== undefined && input.lockVersion !== row.lockVersion) {
      throw new ConflictError('Draft was modified by someone else — reload and retry', {
        expected: row.lockVersion,
        got: input.lockVersion,
      });
    }
    if (input.body !== undefined) {
      validateBody(input.body);
      row.body = input.body;
    }
    if (input.changelog !== undefined) row.changelog = input.changelog?.trim() || null;
    if (input.expectedModules !== undefined) row.expectedModules = validateExpectedModules(input.expectedModules);
    if (input.config !== undefined) row.config = validateConfig(input.config);
    row.lockVersion += 1;
    const saved = await repo.save(row);
    return saved;
  });
}

/** Publish a draft (draft → published, frozen). */
export async function publishVersion(
  templateId: string,
  version: number,
  publishedBy: string,
): Promise<BotTemplateVersion> {
  const repo = AppDataSource.getRepository(BotTemplateVersion);
  const row = await repo.findOne({ where: { templateId, version } });
  if (!row) throw new NotFoundError('Template version not found');
  if (row.status !== 'draft') {
    throw new ConflictError(`Only a draft can be published (this version is ${row.status})`, { status: row.status });
  }
  row.status = 'published';
  row.publishedAt = new Date();
  row.publishedBy = publishedBy;
  const saved = await repo.save(row);
  await fanOutTemplateInvalidation(templateId);
  return saved;
}

/**
 * Withdraw a published version from `latest`. Blocked (409 + impacted count) if
 * bots pin this fixed version, unless force — then those bots reassign per T21.
 */
export async function unpublishVersion(
  templateId: string,
  version: number,
  opts: { force?: boolean; replacement?: Replacement },
): Promise<{ version: BotTemplateVersion; reassignedTenants: string[] }> {
  return AppDataSource.transaction(async (manager) => {
    const repo = manager.getRepository(BotTemplateVersion);
    const row = await repo.findOne({ where: { templateId, version } });
    if (!row) throw new NotFoundError('Template version not found');
    if (row.status !== 'published') {
      throw new ConflictError(`Only a published version can be unpublished (this version is ${row.status})`, {
        status: row.status,
      });
    }

    const pinned = await countBoundBots(manager, templateId, { pinnedVersion: version });
    if (pinned > 0 && !opts.force) {
      throw new ConflictError('Bots pin this version — pass force with an optional replacement to proceed', {
        impactedBots: pinned,
      });
    }

    let reassignedTenants: string[] = [];
    if (pinned > 0 && opts.force) {
      const replacement = opts.replacement ?? (await resolveDefaultReplacement(manager, templateId, version));
      reassignedTenants = await reassignBots(manager, { templateId, pinnedVersion: version }, replacement);
    }

    row.status = 'unpublished';
    const saved = await repo.save(row);
    await fanOutTemplateInvalidation(templateId, reassignedTenants);
    return { version: saved, reassignedTenants };
  });
}

/**
 * Permanently delete a version. Published versions are protected (unpublish
 * first). Drafts are never bound, so they delete freely. An unpublished version
 * may still be referenced by a fixed pin — blocked (409 + impacted count) unless
 * force, which unpins those bots to `latest` on the same template before deleting.
 */
export async function deleteVersion(
  templateId: string,
  version: number,
  opts: { force?: boolean },
): Promise<{ reassignedTenants: string[] }> {
  return AppDataSource.transaction(async (manager) => {
    const repo = manager.getRepository(BotTemplateVersion);
    const row = await repo.findOne({ where: { templateId, version } });
    if (!row) throw new NotFoundError('Template version not found');
    if (row.status === 'published') {
      throw new ConflictError('Unpublish this version before deleting it', { status: row.status });
    }

    let reassignedTenants: string[] = [];
    if (row.status === 'unpublished') {
      const pinned = await countBoundBots(manager, templateId, { pinnedVersion: version });
      if (pinned > 0 && !opts.force) {
        throw new ConflictError('Bots pin this version — pass force to unpin them to latest and delete', {
          impactedBots: pinned,
        });
      }
      if (pinned > 0 && opts.force) {
        reassignedTenants = await reassignBots(manager, { templateId, pinnedVersion: version }, { templateId, templateVersion: 'latest' });
      }
    }

    await repo.remove(row);
    await fanOutTemplateInvalidation(templateId, reassignedTenants);
    return { reassignedTenants };
  });
}

/** Rollback = publish a NEW version whose body is copied from an existing one (T19). */
export async function rollbackToVersion(
  templateId: string,
  fromVersion: number,
  publishedBy: string,
): Promise<BotTemplateVersion> {
  const source = await AppDataSource.getRepository(BotTemplateVersion).findOne({
    where: { templateId, version: fromVersion },
  });
  if (!source) throw new NotFoundError('Source version not found');

  const draft = await createDraftVersion(templateId, {
    body: source.body,
    changelog: `Rollback to v${fromVersion}`,
    expectedModules: source.expectedModules,
    config: source.config,
  });
  return publishVersion(templateId, draft.version, publishedBy);
}

// ── Template-level operations ────────────────────────────────────────────────

/** Archive a template. Blocked (409 + impacted count) while bots are bound, unless force. */
export async function archiveTemplate(
  templateId: string,
  opts: { force?: boolean; replacement?: Replacement },
): Promise<{ template: BotTemplate; reassignedTenants: string[] }> {
  return AppDataSource.transaction(async (manager) => {
    const repo = manager.getRepository(BotTemplate);
    const tmpl = await repo.findOne({ where: { id: templateId } });
    if (!tmpl) throw new NotFoundError('Template not found');
    if (tmpl.status === 'archived') return { template: tmpl, reassignedTenants: [] };

    const bound = await countBoundBots(manager, templateId);
    if (bound > 0 && !opts.force) {
      throw new ConflictError('Bots are bound to this template — pass force with an optional replacement to proceed', {
        impactedBots: bound,
      });
    }

    let reassignedTenants: string[] = [];
    if (bound > 0 && opts.force) {
      // Archiving makes the template unreachable for everyone — move bots to
      // blank-base (or an explicit replacement), never back onto this template.
      const replacement = opts.replacement ?? (await blankBaseReplacement(manager));
      reassignedTenants = await reassignBots(manager, { templateId }, replacement);
    }

    tmpl.status = 'archived';
    const saved = await repo.save(tmpl);
    await fanOutTemplateInvalidation(templateId, reassignedTenants);
    return { template: saved, reassignedTenants };
  });
}

/**
 * Replace the per-tenant grant set. Removing a grant from a tenant with bots
 * bound to the template is blocked (409 + impacted) unless force — then those
 * bots reassign per T21.
 */
export async function replaceGrants(
  templateId: string,
  tenantIds: string[],
  opts: { force?: boolean; replacement?: Replacement; setBy?: string },
): Promise<{ granted: string[]; reassignedTenants: string[] }> {
  return AppDataSource.transaction(async (manager) => {
    const tmpl = await manager.getRepository(BotTemplate).findOne({ where: { id: templateId } });
    if (!tmpl) throw new NotFoundError('Template not found');

    const grantRepo = manager.getRepository(TenantBotTemplate);
    const existing = await grantRepo.find({ where: { templateId } });
    const existingIds = new Set(existing.map((g) => g.tenantId));
    const nextIds = new Set(tenantIds);
    const removed = [...existingIds].filter((t) => !nextIds.has(t));
    const added = [...nextIds].filter((t) => !existingIds.has(t));

    // Block removal while that tenant has bots bound to this template.
    const blocked: Array<{ tenantId: string; bots: number }> = [];
    for (const tenantId of removed) {
      const n = await countBoundBots(manager, templateId, { tenantId });
      if (n > 0) blocked.push({ tenantId, bots: n });
    }
    if (blocked.length && !opts.force) {
      throw new ConflictError('Some tenants have bots bound to this template — pass force to reassign them', {
        impactedTenants: blocked,
      });
    }

    const reassignedTenants: string[] = [];
    if (blocked.length && opts.force) {
      // The tenant loses access to the template entirely — move its bots to
      // blank-base (or an explicit replacement), never back onto this template.
      const replacement = opts.replacement ?? (await blankBaseReplacement(manager));
      for (const { tenantId } of blocked) {
        await reassignBots(manager, { templateId, tenantId }, replacement);
        reassignedTenants.push(tenantId);
      }
    }

    if (removed.length) {
      await grantRepo.delete(removed.map((tenantId) => ({ templateId, tenantId })));
    }
    for (const tenantId of added) {
      await grantRepo.save(grantRepo.create({ templateId, tenantId, setBy: opts.setBy ?? null }));
    }

    // Availability changed for both added and removed tenants.
    await invalidateTemplateBundle(templateId);
    await Promise.all([...new Set([...added, ...removed])].map((t) => invalidateTenantTemplates(t)));

    return { granted: [...nextIds], reassignedTenants };
  });
}
