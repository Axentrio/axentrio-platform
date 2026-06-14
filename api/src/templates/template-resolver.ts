/**
 * Template resolver — the single source of truth for "which templates may this
 * tenant bind?" and "what prompt body does this bot's bound template resolve
 * to right now?" (.scratch/plan-bot-templates.md, Phase 1 step 5).
 *
 * Two concerns:
 *   - listAvailableTemplates(tenantId): the templates a tenant may bind — active
 *     templates that are availableToAllTenants OR granted, behind the D2
 *     billable precheck (free/suspended/cancelled → none), mirroring the
 *     entitlement/module resolvers.
 *   - resolveBoundTemplate(bot): the published body for a bot's pin (`latest` or
 *     a fixed version) with the T12/T21 fallbacks — never throws, never leaves a
 *     bot without a resolvable identity (an unreachable binding falls back to an
 *     empty body, flagged so the UI can surface it).
 *
 * Caching mirrors the entitlement resolver: per-tenant availability and
 * per-template published bundle, each with a short TTL + explicit invalidation
 * (T20). Billable is checked OUTSIDE the availability cache so a tenant losing
 * billability is never served a stale list.
 */
import { AppDataSource } from '../database/data-source';
import { BotTemplate } from '../database/entities/BotTemplate';
import { BotTemplateVersion } from '../database/entities/BotTemplateVersion';
import { getEntitlements } from '../billing/entitlements';
import { cached, invalidate } from '../utils/cache';
import { logger } from '../utils/logger';

const TEMPLATES_TTL_SECONDS = 60;
const availCacheKey = (tenantId: string) => `bot-templates-avail:${tenantId}`;
const bundleCacheKey = (templateId: string) => `bot-template:${templateId}`;

export interface AvailableTemplate {
  id: string;
  key: string;
  displayName: string;
  category: string | null;
  description: string | null;
  availableToAllTenants: boolean;
  /** Highest published version, or null if the template has no published version yet. */
  latestPublishedVersion: number | null;
}

export interface ResolvedTemplate {
  /** The bound template id, or null when the bot is unbound. */
  templateId: string | null;
  /** Resolved prompt body. Empty string when unbound or unreachable. */
  body: string;
  /** The published version actually used, or null when none was resolvable. */
  resolvedVersion: number | null;
  /** The bot pinned a fixed version that isn't published → fell back to latest/empty. */
  pinnedButUnavailable: boolean;
  /** The bound template is missing/archived/has no published version → fell back to empty. */
  templateUnavailable: boolean;
}

const UNBOUND: ResolvedTemplate = {
  templateId: null,
  body: '',
  resolvedVersion: null,
  pinnedButUnavailable: false,
  templateUnavailable: false,
};

interface PublishedVersion {
  version: number;
  body: string;
}
interface TemplateBundle {
  id: string;
  status: string;
  /** Published versions only, sorted DESC by version. */
  publishedVersions: PublishedVersion[];
}

/** Per-template published bundle, cached. `null` = template not found (negative-cached). */
async function getTemplateBundle(templateId: string): Promise<TemplateBundle | null> {
  return cached(bundleCacheKey(templateId), TEMPLATES_TTL_SECONDS, async () => {
    const tmpl = await AppDataSource.getRepository(BotTemplate).findOne({
      where: { id: templateId },
      select: ['id', 'status'],
    });
    if (!tmpl) return null;
    const versions = await AppDataSource.getRepository(BotTemplateVersion).find({
      where: { templateId, status: 'published' },
      select: ['version', 'body'],
      order: { version: 'DESC' },
    });
    return {
      id: tmpl.id,
      status: tmpl.status,
      publishedVersions: versions.map((v) => ({ version: v.version, body: v.body })),
    };
  });
}

/** Templates the tenant may bind right now. `[]` for free/non-active tenants (D2). */
export async function listAvailableTemplates(tenantId: string): Promise<AvailableTemplate[]> {
  let billable = false;
  try {
    billable = (await getEntitlements(tenantId)).billable;
  } catch (error) {
    logger.warn('[Templates] entitlement resolution failed — no templates available (fail closed)', {
      tenantId,
      error,
    });
    return [];
  }
  if (!billable) return [];

  return cached(availCacheKey(tenantId), TEMPLATES_TTL_SECONDS, async () => {
    const rows: Array<{
      id: string;
      key: string;
      display_name: string;
      category: string | null;
      description: string | null;
      available_to_all_tenants: boolean;
      latest_published: number | null;
    }> = await AppDataSource.query(
      `SELECT t.id, t.key, t.display_name, t.category, t.description, t.available_to_all_tenants,
              (SELECT MAX(v.version) FROM bot_template_versions v
                 WHERE v.template_id = t.id AND v.status = 'published') AS latest_published
         FROM bot_templates t
        WHERE t.status = 'active'
          AND (t.available_to_all_tenants = true
               OR EXISTS (SELECT 1 FROM tenant_bot_templates g
                            WHERE g.template_id = t.id AND g.tenant_id = $1))
        ORDER BY t.display_name`,
      [tenantId],
    );
    return rows.map((r) => ({
      id: r.id,
      key: r.key,
      displayName: r.display_name,
      category: r.category,
      description: r.description,
      availableToAllTenants: r.available_to_all_tenants,
      latestPublishedVersion: r.latest_published === null ? null : Number(r.latest_published),
    }));
  });
}

/**
 * Resolve a bot's bound template to a concrete prompt body. Pure with respect
 * to entitlements — billability is enforced at binding time and upstream of the
 * agent; this only resolves template/version availability so the composer never
 * blocks. Never throws.
 */
export async function resolveBoundTemplate(bot: {
  templateId?: string | null;
  templateVersion?: string | null;
}): Promise<ResolvedTemplate> {
  if (!bot.templateId) return UNBOUND;

  let bundle: TemplateBundle | null;
  try {
    bundle = await getTemplateBundle(bot.templateId);
  } catch (error) {
    logger.warn('[Templates] bundle resolution failed — falling back to empty body', {
      templateId: bot.templateId,
      error,
    });
    return { ...UNBOUND, templateId: bot.templateId, templateUnavailable: true };
  }

  // Template deleted or archived (race; admin-side blocks archive while bound).
  if (!bundle || bundle.status !== 'active') {
    return { ...UNBOUND, templateId: bot.templateId, templateUnavailable: true };
  }

  const published = bundle.publishedVersions; // DESC
  const latest = published[0] ?? null;

  const pin = (bot.templateVersion ?? 'latest').trim();
  if (pin === 'latest' || pin === '') {
    if (!latest) {
      return { ...UNBOUND, templateId: bot.templateId, templateUnavailable: true };
    }
    return {
      templateId: bot.templateId,
      body: latest.body,
      resolvedVersion: latest.version,
      pinnedButUnavailable: false,
      templateUnavailable: false,
    };
  }

  // Fixed integer pin.
  const pinned = Number.parseInt(pin, 10);
  const exact = Number.isFinite(pinned) ? published.find((v) => v.version === pinned) : undefined;
  if (exact) {
    return {
      templateId: bot.templateId,
      body: exact.body,
      resolvedVersion: exact.version,
      pinnedButUnavailable: false,
      templateUnavailable: false,
    };
  }

  // Pinned version not published (unpublished/never existed) → fall back to latest, else empty.
  if (latest) {
    return {
      templateId: bot.templateId,
      body: latest.body,
      resolvedVersion: latest.version,
      pinnedButUnavailable: true,
      templateUnavailable: false,
    };
  }
  return { ...UNBOUND, templateId: bot.templateId, pinnedButUnavailable: true, templateUnavailable: true };
}

/** Drop a tenant's available-templates cache. Call on grant add/remove for the
 *  tenant (and, fanned out, on availableToAll/archive changes) — T20. */
export async function invalidateTenantTemplates(tenantId: string): Promise<void> {
  await invalidate(availCacheKey(tenantId));
}

/** Drop a template's published bundle. Call on version publish/unpublish and
 *  archive for that template — T20. */
export async function invalidateTemplateBundle(templateId: string): Promise<void> {
  await invalidate(bundleCacheKey(templateId));
}
