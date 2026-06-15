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
import { BotTemplateVersion, type BotTemplateConfig } from '../database/entities/BotTemplateVersion';
import { getEntitlements } from '../billing/entitlements';
import { cached, invalidate, readCounter, bumpCounter } from '../utils/cache';
import { logger } from '../utils/logger';

const TEMPLATES_TTL_SECONDS = 60;
// Per-tenant availability cache is version-keyed: a change affecting the GLOBAL
// listing (a global template created/archived/republished or its availableToAll
// toggled) bumps this counter, orphaning every tenant's cached list at once —
// O(1) bulk invalidation without enumerating tenants (T20 fan-out).
const availVersionKey = 'bot-templates-avail-version';
const availCacheKey = (tenantId: string, version: number) => `bot-templates-avail:${tenantId}:${version}`;
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
  /** Resolved identity/policy config (tone + policy guardrails). {} when unbound/unreachable. */
  config: BotTemplateConfig;
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
  config: {},
  resolvedVersion: null,
  pinnedButUnavailable: false,
  templateUnavailable: false,
};

interface PublishedVersion {
  version: number;
  body: string;
  config: BotTemplateConfig;
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
      select: ['version', 'body', 'config'],
      order: { version: 'DESC' },
    });
    return {
      id: tmpl.id,
      status: tmpl.status,
      publishedVersions: versions.map((v) => ({ version: v.version, body: v.body, config: v.config ?? {} })),
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

  const version = await readCounter(availVersionKey);
  return cached(availCacheKey(tenantId, version), TEMPLATES_TTL_SECONDS, async () => {
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
      config: latest.config,
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
      config: exact.config,
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
      config: latest.config,
      resolvedVersion: latest.version,
      pinnedButUnavailable: true,
      templateUnavailable: false,
    };
  }
  return { ...UNBOUND, templateId: bot.templateId, pinnedButUnavailable: true, templateUnavailable: true };
}

/**
 * Convenience for prompt composition: the resolved template body for a bot's
 * binding ('' when unbound/unreachable). Drops the resolution flags — the
 * composer only needs the text; the flags are for the tenant/admin UI.
 */
export async function resolveTemplateBody(bot: {
  templateId?: string | null;
  templateVersion?: string | null;
}): Promise<string> {
  return (await resolveBoundTemplate(bot)).body;
}

// ── Effective bot config (the single runtime source for tone + policy guardrails) ──
//
// Tone + policy guardrails (topics/greeting/fallback/off-hours/confidence/maxLen)
// are owned by the bound TEMPLATE, not the bot. Every runtime consumer (composer,
// RAG, n8n, message-forwarding, agent, widget/init) reads them via this helper —
// never directly off Bot.settings.ai.guardrails. Operational settings
// (escalationKeywords, businessHours) stay tenant-owned and are read from the bot.

export interface EffectiveGuardrails {
  topicsToAvoid: string[];
  greetingMessage: string;
  fallbackMessage: string;
  offHoursMessage: string;
  confidenceThreshold: number;
  maxResponseLength: number;
}
export interface EffectiveBotConfig {
  tone: string;
  guardrails: EffectiveGuardrails;
  /** 'template' when the bound template supplied config; 'fallback' = platform defaults. */
  source: 'template' | 'fallback';
  templateId: string | null;
  resolvedVersion: number | null;
  templateUnavailable: boolean;
  pinnedButUnavailable: boolean;
}

/** Platform defaults used when no template config is present (mirrors the pre-slim-down form defaults). */
export const PLATFORM_DEFAULT_CONFIG: { tone: string; guardrails: EffectiveGuardrails } = {
  tone: 'friendly',
  guardrails: {
    topicsToAvoid: [],
    greetingMessage: '',
    fallbackMessage: '',
    offHoursMessage: '',
    confidenceThreshold: 0.7,
    maxResponseLength: 500,
  },
};

/** Derive effective tone + policy guardrails from a resolved template (pure). */
export function effectiveConfigFrom(resolved: ResolvedTemplate): EffectiveBotConfig {
  const c = resolved.config ?? {};
  const g = c.guardrails ?? {};
  const D = PLATFORM_DEFAULT_CONFIG;
  const fromTemplate = !!resolved.templateId && !resolved.templateUnavailable && (c.tone !== undefined || c.guardrails !== undefined);
  return {
    tone: c.tone ?? D.tone,
    guardrails: {
      topicsToAvoid: g.topicsToAvoid ?? D.guardrails.topicsToAvoid,
      greetingMessage: g.greetingMessage ?? D.guardrails.greetingMessage,
      fallbackMessage: g.fallbackMessage ?? D.guardrails.fallbackMessage,
      offHoursMessage: g.offHoursMessage ?? D.guardrails.offHoursMessage,
      confidenceThreshold: g.confidenceThreshold ?? D.guardrails.confidenceThreshold,
      maxResponseLength: g.maxResponseLength ?? D.guardrails.maxResponseLength,
    },
    source: fromTemplate ? 'template' : 'fallback',
    templateId: resolved.templateId,
    resolvedVersion: resolved.resolvedVersion,
    templateUnavailable: resolved.templateUnavailable,
    pinnedButUnavailable: resolved.pinnedButUnavailable,
  };
}

/** The bot's effective tone + policy guardrails (template-sourced, else platform defaults). */
export async function effectiveBotConfig(bot: {
  templateId?: string | null;
  templateVersion?: string | null;
  templateBindings?: BotTemplateBinding[] | null;
}): Promise<EffectiveBotConfig> {
  return effectiveConfigFromList(await resolveBoundTemplates(bot));
}

// ── Multi-template (up to 3 bindings, AND/OR composed) ───────────────────────

export interface BotTemplateBinding {
  templateId: string;
  version: string;
}

/** A bot's ordered bindings ([0]=primary). Falls back to the legacy single
 *  template_id binding when templateBindings is empty (back-compat). */
export function bindingsOf(bot: {
  templateId?: string | null;
  templateVersion?: string | null;
  templateBindings?: BotTemplateBinding[] | null;
}): BotTemplateBinding[] {
  if (bot.templateBindings && bot.templateBindings.length) return bot.templateBindings.slice(0, 3);
  if (bot.templateId) return [{ templateId: bot.templateId, version: bot.templateVersion ?? 'latest' }];
  return [];
}

/** Resolve ALL of a bot's bindings to concrete bodies/configs (ordered, [0]=primary). */
export async function resolveBoundTemplates(bot: {
  templateId?: string | null;
  templateVersion?: string | null;
  templateBindings?: BotTemplateBinding[] | null;
}): Promise<ResolvedTemplate[]> {
  const bindings = bindingsOf(bot);
  if (!bindings.length) return [];
  const out: ResolvedTemplate[] = [];
  for (const b of bindings) {
    out.push(await resolveBoundTemplate({ templateId: b.templateId, templateVersion: b.version }));
  }
  return out;
}

/**
 * Stitch resolved template bodies into ONE prompt body with AND/OR framing.
 * 1 body → returned as-is (back-compat). >1 → an explicit header tells the AI
 * whether the specialities are combined (and) or independent/self-selected (or).
 */
export function composeTemplateBodies(resolved: ResolvedTemplate[], mode: 'and' | 'or'): string {
  const bodies = resolved.map((r) => r.body).filter((b) => b && b.trim());
  if (bodies.length === 0) return '';
  if (bodies.length === 1) return bodies[0];
  const header =
    mode === 'and'
      ? 'You provide ALL of the following specialities together as one combined service — apply them in combination:'
      : "You cover the following INDEPENDENT specialities. Use ONLY the speciality that matches the customer's request; do not assume they want more than one unless they say so:";
  const sections = bodies.map((b, i) => `### Speciality ${i + 1}\n${b}`).join('\n\n');
  return `${header}\n\n${sections}`;
}

/**
 * Effective guardrails for a (possibly multi-) binding: taken from the PRIMARY
 * template ([0]), with topics-to-avoid UNIONED across all bound templates
 * (additive safety). Tone is bot-owned and intentionally NOT set here — see
 * withEffectiveConfig, which no longer overrides brandVoice.tone.
 */
export function effectiveConfigFromList(resolved: ResolvedTemplate[]): EffectiveBotConfig {
  const primary = resolved[0];
  if (!primary) {
    return {
      tone: PLATFORM_DEFAULT_CONFIG.tone,
      guardrails: { ...PLATFORM_DEFAULT_CONFIG.guardrails },
      source: 'fallback',
      templateId: null,
      resolvedVersion: null,
      templateUnavailable: false,
      pinnedButUnavailable: false,
    };
  }
  const eff = effectiveConfigFrom(primary);
  const topics = new Set<string>(eff.guardrails.topicsToAvoid);
  for (const r of resolved.slice(1)) {
    for (const t of r.config?.guardrails?.topicsToAvoid ?? []) topics.add(t);
  }
  eff.guardrails = { ...eff.guardrails, topicsToAvoid: [...topics] };
  return eff;
}

/**
 * Return a copy of an AI-settings slice with the policy guardrails overridden by
 * the effective (template-sourced) config. TONE IS BOT-OWNED and is intentionally
 * left on `ai.brandVoice.tone` untouched. escalationKeywords + other non-policy
 * fields on `ai.guardrails` are preserved (operational, tenant-owned).
 */
export function withEffectiveConfig<A extends { brandVoice?: Record<string, unknown>; guardrails?: Record<string, unknown> }>(
  ai: A,
  eff: EffectiveBotConfig,
): A {
  // Only a bound template OWNS the policy guardrails. With no template
  // (source === 'fallback'), leave the bot's own stored values untouched —
  // overlaying empty platform defaults would wipe legacy tenant config.
  if (eff.source !== 'template') return ai;
  return {
    ...ai,
    guardrails: { ...(ai.guardrails ?? {}), ...eff.guardrails },
  } as A;
}

/** Drop ONE tenant's available-templates cache. Call on grant add/remove for
 *  that tenant (a grant change affects only that tenant's listing) — T20. */
export async function invalidateTenantTemplates(tenantId: string): Promise<void> {
  const version = await readCounter(availVersionKey);
  await invalidate(availCacheKey(tenantId, version));
}

/** Invalidate the available-templates listing for EVERY tenant at once (O(1)).
 *  Call on changes to a globally-available template (create/archive/publish/
 *  unpublish/availableToAll toggle) — these change what all tenants can bind. */
export async function invalidateAllTenantTemplates(): Promise<void> {
  await bumpCounter(availVersionKey);
}

/** Drop a template's published bundle. Call on version publish/unpublish and
 *  archive for that template — T20. */
export async function invalidateTemplateBundle(templateId: string): Promise<void> {
  await invalidate(bundleCacheKey(templateId));
}
