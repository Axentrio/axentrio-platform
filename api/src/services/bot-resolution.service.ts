/**
 * Bot Resolution Service
 *
 * Centralised resolution of a widget-embedded key → `{ tenant, bot }`.
 *
 * A widget can present one of two key shapes:
 *  1. `Bot.publicKey` directly — the standard path for any non-anchor bot
 *     (looks like `bk_<random>`).
 *  2. `Tenant.apiKey` — the legacy path, equal to the anchor bot's
 *     `publicKey` by migration backfill. Kept working so existing embeds
 *     never break.
 *
 * Both paths return the same `ResolvedBot` shape so callers don't need to
 * branch on which key was used (except the `isAnchorViaLegacyKey` flag, for
 * the rare callers that care).
 *
 * Replaces ad-hoc `Tenant.apiKey` lookups scattered across:
 *   - middleware/tenant.middleware (getTenantByApiKey, sibling resolveBotByKey)
 *   - routes/auth.routes (widget auth)
 *   - websocket/socket.handler (widget socket auth)
 *   - routes/widget (validateApiKey for /config and /init)
 */

import { IsNull } from 'typeorm';
import { AppDataSource } from '../database/data-source';
import { Tenant } from '../database/entities/Tenant';
import { Bot } from '../database/entities/Bot';
import { logger } from '../utils/logger';

export interface ResolvedBot {
  tenant: Tenant;
  bot: Bot;
  /** True when `key === tenant.apiKey === anchor.publicKey` — legacy path. */
  isAnchorViaLegacyKey: boolean;
}

/**
 * Thrown by `resolveBotKeyStrict` when the key matched a bot but that bot
 * is currently paused. Callers should map this to an HTTP 403.
 */
export class BotPausedError extends Error {
  readonly code = 'BOT_PAUSED';
  constructor(public readonly botId: string) {
    super(`Bot ${botId} is paused`);
    this.name = 'BotPausedError';
  }
}

/**
 * Thrown by `resolveBotKeyStrict` when:
 *  - no bot matches the key, or
 *  - a legacy `Tenant.apiKey` matched but the tenant has no anchor bot
 *    (data-integrity error in legacy test environments).
 */
export class BotNotFoundError extends Error {
  readonly code = 'BOT_NOT_FOUND';
  constructor(message: string) {
    super(message);
    this.name = 'BotNotFoundError';
  }
}

/**
 * Resolve a widget key (`bk_*` Bot.publicKey OR legacy `Tenant.apiKey`) to
 * a `{ tenant, bot }` pair.
 *
 * Returns `null` when:
 *  - no bot or tenant matches the key
 *  - the matched bot is soft-deleted
 *  - the matched bot's tenant is not `active` (suspended / cancelled)
 *
 * Returns `ResolvedBot` with `bot.status === 'paused'` when the bot exists
 * but is paused — the caller decides whether to reject (use
 * `resolveBotKeyStrict` for an exception-based variant).
 *
 * Anchor-bot caveat: if a legacy `Tenant.apiKey` matches but the tenant has
 * no anchor bot (`isDefault=true`, not soft-deleted), this is a data-integrity
 * problem — we surface it as `BotNotFoundError` via the strict variant, or
 * `null` via this one. We do NOT silently pick an arbitrary bot.
 *
 * Idempotent and side-effect-free.
 */
export async function resolveBotKey(key: string): Promise<ResolvedBot | null> {
  if (!key) return null;

  const botRepo = AppDataSource.getRepository(Bot);
  const tenantRepo = AppDataSource.getRepository(Tenant);

  // Path 1: direct Bot.publicKey lookup. Eagerly load the tenant so we don't
  // need a second roundtrip.
  const bot = await botRepo.findOne({
    where: { publicKey: key, deletedAt: IsNull() },
    relations: ['tenant'],
  });

  if (bot) {
    // Skip if tenant isn't active.
    if (!bot.tenant || bot.tenant.status !== 'active') {
      return null;
    }
    // The anchor bot's publicKey equals the tenant.apiKey, so a direct lookup
    // by publicKey will *also* find the anchor. Detect that case so the flag
    // is accurate for callers that branch on it.
    const isAnchorViaLegacyKey = bot.isDefault && bot.publicKey === bot.tenant.apiKey;
    return { tenant: bot.tenant, bot, isAnchorViaLegacyKey };
  }

  // Path 2: legacy fallback — treat the key as `Tenant.apiKey` and resolve
  // to the anchor bot. This branch matters when an anchor bot's publicKey
  // has somehow drifted from tenant.apiKey, or for any future split.
  // (In the current backfill they're equal, so this fallback rarely fires.)
  const tenant = await tenantRepo.findOne({
    where: { apiKey: key, status: 'active' as const },
  });

  if (!tenant) return null;

  const anchor = await botRepo.findOne({
    where: {
      tenantId: tenant.id,
      isDefault: true,
      deletedAt: IsNull(),
    },
  });

  if (!anchor) {
    // Data-integrity issue: legacy tenant has an apiKey but no anchor bot.
    // Surface it loudly so we notice in logs but return null to keep `resolveBotKey`
    // a clean Option type. The strict variant will throw.
    logger.error(
      `Tenant ${tenant.id} has apiKey but no anchor bot — bot resolution failed for legacy key`,
    );
    return null;
  }

  return { tenant, bot: anchor, isAnchorViaLegacyKey: true };
}

/**
 * Variant of `resolveBotKey` that throws typed errors instead of returning
 * `null`. Use in call-sites where the caller wants to map the error directly
 * to an HTTP/WebSocket response.
 *
 * Throws:
 *  - `BotNotFoundError` — no matching key, soft-deleted bot, suspended tenant,
 *    or legacy apiKey with no anchor bot.
 *  - `BotPausedError`  — bot matched but `status === 'paused'`.
 */
export async function resolveBotKeyStrict(key: string): Promise<ResolvedBot> {
  // For legacy-apiKey-with-no-anchor we want a more descriptive error than
  // the resolveBotKey-returns-null path provides, so re-run the bot lookup
  // ourselves with the same query shape.
  if (!key) {
    throw new BotNotFoundError('No key provided');
  }

  const botRepo = AppDataSource.getRepository(Bot);
  const tenantRepo = AppDataSource.getRepository(Tenant);

  const bot = await botRepo.findOne({
    where: { publicKey: key, deletedAt: IsNull() },
    relations: ['tenant'],
  });

  if (bot) {
    if (!bot.tenant || bot.tenant.status !== 'active') {
      throw new BotNotFoundError(`Tenant for bot ${bot.id} is not active`);
    }
    if (bot.status === 'paused') {
      throw new BotPausedError(bot.id);
    }
    const isAnchorViaLegacyKey = bot.isDefault && bot.publicKey === bot.tenant.apiKey;
    return { tenant: bot.tenant, bot, isAnchorViaLegacyKey };
  }

  const tenant = await tenantRepo.findOne({
    where: { apiKey: key, status: 'active' as const },
  });

  if (!tenant) {
    throw new BotNotFoundError('No bot or tenant matches the supplied key');
  }

  const anchor = await botRepo.findOne({
    where: { tenantId: tenant.id, isDefault: true, deletedAt: IsNull() },
  });

  if (!anchor) {
    throw new BotNotFoundError(
      `Tenant ${tenant.id} (${tenant.slug}) has no anchor bot — legacy resolution failed`,
    );
  }

  // Anchor is non-pausable by product rule, but check defensively.
  if (anchor.status === 'paused') {
    throw new BotPausedError(anchor.id);
  }

  return { tenant, bot: anchor, isAnchorViaLegacyKey: true };
}
