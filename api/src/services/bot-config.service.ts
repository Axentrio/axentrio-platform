/**
 * Bot-config resolution — central read/write surface for Bot.settings.
 *
 * Multi-bot Phase 4 (#16d): all widget/agent/integration config moved from
 * `Tenant.settings` to `Bot.settings`. This service is the single seam through
 * which the rest of the codebase reads or mutates per-bot config.
 *
 * Architectural rules (locked with codex):
 *   1. Three explicit resolvers, not one polymorphic helper. The distinction
 *      between "runtime traffic resolves the session's bot" and "admin
 *      endpoints implicitly resolve the anchor" must be obvious at every
 *      call site.
 *   2. `Tenant.settings.ai.apiKey` (LLM provider secret) is NEVER merged into
 *      `Bot.settings`. Callers needing the secret use the explicitly named
 *      `getLlmRuntimeConfigForSession` which returns
 *      `{ botAiSettings, apiKey }` — the secret-bearing surface is visible.
 *   3. `Tenant.settings` legacy keys are untouched by this code path. Reads
 *      come from Bot.settings only. Rollback safety + later cleanup.
 *   4. Paused/deleted bot resolution: traffic paths reject (the resolver throws
 *      a typed error); admin anchor reads still load paused/deleted anchors
 *      because the anchor is non-deletable and non-pausable in v1.
 *   5. Session fallback to anchor (`session.botId IS NULL`) is logged so we
 *      know when #16c (`chat_sessions.bot_id NOT NULL` migration) is safe.
 */

import { DataSource, IsNull } from 'typeorm';
import { Bot, BotSettings } from '../database/entities/Bot';
import { ChatSession } from '../database/entities/ChatSession';
import { Tenant } from '../database/entities/Tenant';
import { AppDataSource } from '../database/data-source';
import { logger } from '../utils/logger';

export class BotConfigResolutionError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'BotConfigResolutionError';
  }
}

/** No anchor bot found for a tenant — should never happen post-migration 1782600. */
export class AnchorBotMissingError extends BotConfigResolutionError {
  constructor(tenantId: string) {
    super(`No anchor bot found for tenant ${tenantId}`);
    this.name = 'AnchorBotMissingError';
  }
}

/** Bot is paused; traffic paths must reject. Admin endpoints may still proceed. */
export class BotPausedConfigError extends BotConfigResolutionError {
  constructor(botId: string) {
    super(`Bot ${botId} is paused`);
    this.name = 'BotPausedConfigError';
  }
}

/** Bot doesn't exist or has been soft-deleted. */
export class BotNotFoundConfigError extends BotConfigResolutionError {
  constructor(botId: string) {
    super(`Bot ${botId} not found`);
    this.name = 'BotNotFoundConfigError';
  }
}

function ds(): DataSource {
  return AppDataSource;
}

/**
 * Internal shared resolver — loads a Bot by ID. Used by both per-session and
 * anchor flows. Does NOT check paused/deleted (caller decides per context).
 */
export async function getBotConfigForBotId(botId: string): Promise<Bot> {
  const bot = await ds().getRepository(Bot).findOne({
    where: { id: botId },
  });
  if (!bot) throw new BotNotFoundConfigError(botId);
  return bot;
}

/**
 * Load a bot the caller's tenant owns. Used by admin/management endpoints that
 * target a SPECIFIC bot by id (e.g. the per-bot AI settings editor). Scoped to
 * the tenant and excludes soft-deleted rows so a botId from one tenant can
 * never read/write another tenant's bot, and a deleted bot is treated as gone.
 *
 * Throws `BotNotFoundConfigError` (maps to HTTP 404 at the route layer) when no
 * matching, non-deleted bot exists for this tenant.
 */
export async function getOwnedBot(botId: string, tenantId: string): Promise<Bot> {
  const bot = await ds().getRepository(Bot).findOne({
    where: { id: botId, tenantId, deletedAt: IsNull() },
  });
  if (!bot) throw new BotNotFoundConfigError(botId);
  return bot;
}

/**
 * Load the tenant's anchor bot. Used by admin/management endpoints that
 * target the tenant rather than a specific session. v1: only the anchor
 * is exposed via the existing `/tenants/me/*` endpoints; #16f will add
 * non-anchor bot management endpoints.
 *
 * The anchor is non-deletable + non-pausable by design, so we don't
 * filter by status — if the anchor somehow ended up paused/deleted, that's
 * a data-integrity bug we surface (callers get the bot anyway and can audit).
 */
export async function getAnchorBotConfig(
  tenantId: string,
): Promise<{ bot: Bot; settings: BotSettings }> {
  const bot = await ds().getRepository(Bot).findOne({
    where: { tenantId, isDefault: true },
  });
  if (!bot) throw new AnchorBotMissingError(tenantId);
  return { bot, settings: bot.settings ?? ({} as BotSettings) };
}

/**
 * Resolve the bot config for a chat session. Primary path for the agent
 * runtime, prompt builder, tool registry, booking service, etc.
 *
 * - If `session.botId` is set → load that bot. If paused/deleted, throw.
 * - If `session.botId IS NULL` → fall back to the tenant's anchor. Log it
 *   so we can measure when #16c (NOT NULL migration) is safe.
 */
export async function getBotConfigForSession(
  session: Pick<ChatSession, 'id' | 'tenantId' | 'botId'>,
): Promise<{ bot: Bot; settings: BotSettings }> {
  if (session.botId) {
    const bot = await getBotConfigForBotId(session.botId);
    // Defence in depth: the FK only ties bot_id → chatbot_bots(id), not to the
    // session's tenant. Reject a session pointing at another tenant's bot so
    // runtime config can never cross the tenant boundary.
    if (bot.tenantId !== session.tenantId) throw new BotNotFoundConfigError(session.botId);
    if (bot.deletedAt) throw new BotNotFoundConfigError(session.botId);
    if (bot.status === 'paused') throw new BotPausedConfigError(session.botId);
    return { bot, settings: bot.settings ?? ({} as BotSettings) };
  }

  logger.info('Session has no botId; falling back to anchor bot', {
    sessionId: session.id,
    tenantId: session.tenantId,
  });
  return getAnchorBotConfig(session.tenantId);
}

/**
 * Secret-bearing variant — returns the bot's behavioural AI config alongside
 * the tenant's LLM provider apiKey. Used by RAG, knowledge ingestion, and
 * any code path that actually executes an LLM call.
 *
 * Naming is deliberate: callers should pause when they see `LlmRuntime` in
 * the function name and verify they really need the secret. Anything that
 * just needs the bot's behavioural config should use `getBotConfigForSession`.
 */
export interface LlmRuntimeConfig {
  /** The resolved bot row — returned so callers don't re-fetch it. */
  bot: Bot;
  /** The bot's full settings blob (behavioural slice the tool registry +
   *  prompt builder consume). Returned alongside to avoid a second lookup. */
  botSettings: BotSettings;
  botAiSettings: NonNullable<BotSettings['ai']> | undefined;
  /** Tenant-wide LLM provider key. Never copy into Bot.settings. */
  apiKey: string | null | undefined;
}

export async function getLlmRuntimeConfigForSession(
  session: Pick<ChatSession, 'id' | 'tenantId' | 'botId'>,
): Promise<LlmRuntimeConfig> {
  const [{ bot, settings }, tenant] = await Promise.all([
    getBotConfigForSession(session),
    ds().getRepository(Tenant).findOne({ where: { id: session.tenantId } }),
  ]);
  if (!tenant) {
    throw new BotConfigResolutionError(`Tenant ${session.tenantId} not found`);
  }
  return {
    bot,
    botSettings: settings,
    botAiSettings: settings.ai,
    apiKey: tenant.settings?.ai?.apiKey ?? null,
  };
}

/**
 * Write a partial update to the anchor bot's settings. Deep-merges section by
 * section so unrelated keys aren't wiped. Caller is responsible for excluding
 * `ai.apiKey` from the input — this function does NOT route apiKey writes to
 * Tenant (callers do that explicitly because the secret slice needs its own
 * audit/encryption story).
 *
 * Returns the resulting Bot row so callers can hydrate response payloads.
 */
export async function updateAnchorBotSettings(
  tenantId: string,
  patch: Partial<BotSettings>,
): Promise<Bot> {
  const repo = ds().getRepository(Bot);
  const bot = await repo.findOne({ where: { tenantId, isDefault: true } });
  if (!bot) throw new AnchorBotMissingError(tenantId);

  bot.settings = deepMergeSettings(bot.settings ?? {}, patch);
  return repo.save(bot);
}

/**
 * Wholesale section replacement on the anchor bot's settings. Use when the
 * caller's semantic is "set section X to this value, dropping any sub-keys
 * that aren't in the new value." Examples:
 *   - Disconnecting Cal.com (`integrations = {}` or `integrations.calcom = null`)
 *     — `updateAnchorBotSettings` can't propagate sub-key deletion because its
 *     deep-merge preserves base keys not in the patch.
 *   - Knowledge controller writing the AI behavioural slice from a fresh PUT
 *     — replaces the whole `ai` shape (minus apiKey, which is tenant-scoped).
 *
 * Defensive: when `section === 'ai'`, strips any inadvertent `apiKey` from
 * the input. The LLM provider secret lives on Tenant, never on Bot.
 */
export async function replaceAnchorBotSettingsSection<K extends keyof BotSettings>(
  tenantId: string,
  section: K,
  value: BotSettings[K],
): Promise<Bot> {
  const bot = await ds().getRepository(Bot).findOne({ where: { tenantId, isDefault: true } });
  if (!bot) throw new AnchorBotMissingError(tenantId);
  return saveReplacedSection(bot, section, value);
}

/**
 * Bot-scoped variant of {@link replaceAnchorBotSettingsSection} for endpoints
 * that target a specific bot by id (per-bot AI settings editor). Resolves a
 * tenant-owned, non-deleted bot via {@link getOwnedBot} — never an arbitrary
 * bot id — then wholesale-replaces the section with the same apiKey-stripping
 * guarantee.
 */
export async function replaceBotSettingsSection<K extends keyof BotSettings>(
  botId: string,
  tenantId: string,
  section: K,
  value: BotSettings[K],
): Promise<Bot> {
  const bot = await getOwnedBot(botId, tenantId);
  return saveReplacedSection(bot, section, value);
}

/** Shared section-replace body for the anchor + bot-scoped variants. */
async function saveReplacedSection<K extends keyof BotSettings>(
  bot: Bot,
  section: K,
  value: BotSettings[K],
): Promise<Bot> {
  let sanitized = value;
  if (section === 'ai' && value && typeof value === 'object' && 'apiKey' in (value as object)) {
    const { apiKey: _omit, ...rest } = value as { apiKey?: unknown } & Record<string, unknown>;
    void _omit;
    sanitized = rest as BotSettings[K];
  }

  bot.settings = { ...(bot.settings ?? {}), [section]: sanitized } as BotSettings;
  return ds().getRepository(Bot).save(bot);
}

/**
 * Section-level deep merge: top-level keys (`theme`, `widget`, `ai`, etc.)
 * are merged independently so a PATCH that updates only `theme.primaryColor`
 * doesn't wipe `theme.logoUrl`. Nested objects within a section are also
 * shallow-merged. Arrays are replaced (not merged) — that's the convention
 * for `skills`, `guardrails.topicsToAvoid`, etc.
 */
function deepMergeSettings(
  base: BotSettings,
  patch: Partial<BotSettings>,
): BotSettings {
  // The BotSettings keys carry incompatible value types, so per-key assignment
  // can't be narrowed by TypeScript. Cast to a record for the iteration; the
  // public signature still enforces the typed BotSettings contract.
  const out: Record<string, unknown> = { ...base };
  const baseRec = base as Record<string, unknown>;
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    const baseSection = baseRec[k];
    if (
      baseSection !== undefined &&
      baseSection !== null &&
      typeof baseSection === 'object' &&
      !Array.isArray(baseSection) &&
      typeof v === 'object' &&
      !Array.isArray(v)
    ) {
      out[k] = { ...(baseSection as object), ...(v as object) };
    } else {
      out[k] = v;
    }
  }
  return out as BotSettings;
}
