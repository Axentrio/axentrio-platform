/**
 * Bot Resolution Service
 *
 * Centralised resolution of a widget-embedded key → `{ tenant, bot }`.
 *
 * A widget can present one of three key shapes:
 *  1. `Bot.publicKey` directly — the standard path (short `bk_<base64url>`).
 *  2. `Bot.previousPublicKey` — the grace-window key after a rotation.
 *  3. `Tenant.apiKey` — the legacy path, equal to the anchor bot's
 *     `publicKey` by migration backfill.
 *
 * Both paths return the same `ResolvedBot` shape so callers don't need to
 * branch on which key was used (except the `isAnchorViaLegacyKey` /
 * `viaPreviousKey` flags, for the rare callers that care).
 *
 * Replaces ad-hoc `Tenant.apiKey` lookups scattered across:
 *   - middleware/tenant.middleware (getTenantByApiKey, sibling resolveBotByKey)
 *   - websocket/socket.handler (widget socket auth)
 *   - routes/widget (validateApiKey for /config and /init)
 */

import { IsNull } from 'typeorm';
import { AppDataSource } from '../database/data-source';
import { Tenant } from '../database/entities/Tenant';
import { Bot } from '../database/entities/Bot';
import { logger } from '../utils/logger';
import { originMatches } from '../security/widget-origin';

export interface ResolvedBot {
  tenant: Tenant;
  bot: Bot;
  /** True when `key === tenant.apiKey === anchor.publicKey` — legacy path. */
  isAnchorViaLegacyKey: boolean;
  /** True when the key matched `bot.previousPublicKey` inside the grace window. */
  viaPreviousKey: boolean;
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
 * Thrown when the request Origin is not in the bot's allowedOrigins list.
 * Callers should map this to an HTTP 403.
 */
export class BotOriginNotAllowedError extends Error {
  readonly code = 'BOT_ORIGIN_NOT_ALLOWED';
  constructor(public readonly botId: string) {
    super(`Bot ${botId} is not allowed on this origin`);
    this.name = 'BotOriginNotAllowedError';
  }
}

const PREVIOUS_KEY_TOUCH_MS = 60 * 60 * 1000;

function touchPreviousKeyUsage(bot: Bot): void {
  const last = bot.previousPublicKeyLastUsedAt;
  if (last && Date.now() - last.getTime() < PREVIOUS_KEY_TOUCH_MS) return;
  const now = new Date();
  bot.previousPublicKeyLastUsedAt = now;
  AppDataSource.getRepository(Bot)
    .update({ id: bot.id }, { previousPublicKeyLastUsedAt: now })
    .catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn('Failed to record previous public key use', { botId: bot.id, error: message });
    });
}

async function lookupBotByWidgetKey(
  key: string,
): Promise<{ bot: Bot; viaPreviousKey: boolean } | null> {
  const botRepo = AppDataSource.getRepository(Bot);

  const byPublic = await botRepo.findOne({
    where: { publicKey: key, deletedAt: IsNull() },
    relations: ['tenant'],
  });
  if (byPublic) return { bot: byPublic, viaPreviousKey: false };

  const byPrevious = await botRepo.findOne({
    where: { previousPublicKey: key, deletedAt: IsNull() },
    relations: ['tenant'],
  });
  if (!byPrevious) return null;
  if (
    !byPrevious.previousPublicKeyExpiresAt ||
    byPrevious.previousPublicKeyExpiresAt.getTime() <= Date.now()
  ) {
    return null;
  }
  return { bot: byPrevious, viaPreviousKey: true };
}

/**
 * Resolve a widget key (`bk_*` Bot.publicKey, grace-window previous key, OR
 * legacy `Tenant.apiKey`) to a `{ tenant, bot }` pair.
 *
 * Returns `null` when:
 *  - no bot or tenant matches the key
 *  - the matched bot is soft-deleted
 *  - the matched bot's tenant is not `active` (suspended / cancelled)
 *  - a previous key matched but the grace window has expired
 *
 * Returns `ResolvedBot` with `bot.status === 'paused'` when the bot exists
 * but is paused — the caller decides whether to reject (use
 * `resolveBotKeyStrict` for an exception-based variant).
 *
 * Anchor-bot caveat: if a legacy `Tenant.apiKey` matches but the tenant has
 * no anchor bot (`isDefault=true`, not soft-deleted), this is a data-integrity
 * problem — we surface it as `BotNotFoundError` via the strict variant, or
 * `null` via this one. We do NOT silently pick an arbitrary bot.
 */
export async function resolveBotKey(key: string): Promise<ResolvedBot | null> {
  if (!key) return null;

  const botRepo = AppDataSource.getRepository(Bot);
  const tenantRepo = AppDataSource.getRepository(Tenant);

  const matched = await lookupBotByWidgetKey(key);
  if (matched) {
    const { bot, viaPreviousKey } = matched;
    if (!bot.tenant || bot.tenant.status !== 'active') {
      return null;
    }
    if (viaPreviousKey) touchPreviousKeyUsage(bot);
    const isAnchorViaLegacyKey = bot.isDefault && bot.publicKey === bot.tenant.apiKey;
    return { tenant: bot.tenant, bot, isAnchorViaLegacyKey, viaPreviousKey };
  }

  // Path 2: legacy fallback — treat the key as `Tenant.apiKey` and resolve
  // to the anchor bot. This branch matters when an anchor bot's publicKey
  // has somehow drifted from tenant.apiKey, or for any future split.
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
    logger.error(
      `Tenant ${tenant.id} has apiKey but no anchor bot — bot resolution failed for legacy key`,
    );
    return null;
  }

  return { tenant, bot: anchor, isAnchorViaLegacyKey: true, viaPreviousKey: false };
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
  if (!key) {
    throw new BotNotFoundError('No key provided');
  }

  const botRepo = AppDataSource.getRepository(Bot);
  const tenantRepo = AppDataSource.getRepository(Tenant);

  const matched = await lookupBotByWidgetKey(key);
  if (matched) {
    const { bot, viaPreviousKey } = matched;
    if (!bot.tenant || bot.tenant.status !== 'active') {
      throw new BotNotFoundError(`Tenant for bot ${bot.id} is not active`);
    }
    if (bot.status === 'paused') {
      throw new BotPausedError(bot.id);
    }
    if (viaPreviousKey) touchPreviousKeyUsage(bot);
    const isAnchorViaLegacyKey = bot.isDefault && bot.publicKey === bot.tenant.apiKey;
    return { tenant: bot.tenant, bot, isAnchorViaLegacyKey, viaPreviousKey };
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

  if (anchor.status === 'paused') {
    throw new BotPausedError(anchor.id);
  }

  return { tenant, bot: anchor, isAnchorViaLegacyKey: true, viaPreviousKey: false };
}

export function assertOriginAllowed(bot: Bot, origin: string | undefined): void {
  const patterns = bot.settings?.widget?.allowedOrigins ?? [];
  if (!originMatches(patterns, origin)) {
    throw new BotOriginNotAllowedError(bot.id);
  }
}
