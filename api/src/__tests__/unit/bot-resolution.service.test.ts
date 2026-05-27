import { describe, it, expect } from 'vitest';
import crypto from 'crypto';
import { AppDataSource } from '../../database/data-source';
import { Bot } from '../../database/entities/Bot';
import {
  resolveBotKey,
  resolveBotKeyStrict,
  BotPausedError,
  BotNotFoundError,
} from '../../services/bot-resolution.service';
import { createTestTenant, createTestAnchorBot } from '../helpers/factories';

/**
 * Helper: insert a non-anchor Bot row with sensible defaults.
 */
async function createTestBot(
  tenantId: string,
  overrides: Partial<Bot> = {},
): Promise<Bot> {
  const repo = AppDataSource.getRepository(Bot);
  return repo.save(
    repo.create({
      tenantId,
      name: 'Test Bot',
      publicKey: overrides.publicKey ?? `bk_${crypto.randomBytes(16).toString('hex')}`,
      status: 'active',
      isDefault: false,
      settings: {} as Bot['settings'],
      ...overrides,
    }),
  );
}

describe('resolveBotKey', () => {
  it('resolves a legacy Tenant.apiKey to the anchor bot with isAnchorViaLegacyKey=true', async () => {
    const tenant = await createTestTenant();
    const anchor = await createTestAnchorBot(tenant);

    const result = await resolveBotKey(tenant.apiKey);

    expect(result).not.toBeNull();
    expect(result!.tenant.id).toBe(tenant.id);
    expect(result!.bot.id).toBe(anchor.id);
    expect(result!.isAnchorViaLegacyKey).toBe(true);
  });

  it('resolves a direct bk_* Bot.publicKey to a non-anchor bot with isAnchorViaLegacyKey=false', async () => {
    const tenant = await createTestTenant();
    await createTestAnchorBot(tenant);
    const secondary = await createTestBot(tenant.id, { name: 'Secondary' });

    const result = await resolveBotKey(secondary.publicKey);

    expect(result).not.toBeNull();
    expect(result!.tenant.id).toBe(tenant.id);
    expect(result!.bot.id).toBe(secondary.id);
    expect(result!.isAnchorViaLegacyKey).toBe(false);
  });

  it('returns a paused bot (does not filter it out) — caller decides', async () => {
    const tenant = await createTestTenant();
    await createTestAnchorBot(tenant);
    const paused = await createTestBot(tenant.id, {
      status: 'paused',
      name: 'Paused Bot',
    });

    const result = await resolveBotKey(paused.publicKey);

    expect(result).not.toBeNull();
    expect(result!.bot.id).toBe(paused.id);
    expect(result!.bot.status).toBe('paused');
  });

  it('returns null for a soft-deleted bot', async () => {
    const tenant = await createTestTenant();
    await createTestAnchorBot(tenant);
    const deleted = await createTestBot(tenant.id, {
      deletedAt: new Date(),
      name: 'Deleted Bot',
    });

    const result = await resolveBotKey(deleted.publicKey);

    expect(result).toBeNull();
  });

  it('returns null when the tenant is suspended', async () => {
    const tenant = await createTestTenant({ status: 'suspended' });
    const anchor = await createTestAnchorBot(tenant);

    // Direct bk_* lookup must reject suspended-tenant bots.
    const byBotKey = await resolveBotKey(anchor.publicKey);
    expect(byBotKey).toBeNull();

    // Legacy Tenant.apiKey path is gated on tenant.status='active' too.
    const byTenantKey = await resolveBotKey(tenant.apiKey);
    expect(byTenantKey).toBeNull();
  });

  it('returns null for an unknown key', async () => {
    const result = await resolveBotKey('bk_does_not_exist_12345');
    expect(result).toBeNull();
  });

  it('returns null for an empty key', async () => {
    expect(await resolveBotKey('')).toBeNull();
  });

  it('returns null when a tenant has an apiKey but no anchor bot (data integrity)', async () => {
    // Tenant with apiKey but no anchor — should not silently pick a random
    // bot. resolveBotKey returns null; resolveBotKeyStrict throws.
    const tenant = await createTestTenant();
    await createTestBot(tenant.id, {
      isDefault: false,
      name: 'Non-anchor only',
    });

    const result = await resolveBotKey(tenant.apiKey);
    expect(result).toBeNull();
  });

  it('skips a soft-deleted anchor and returns null on legacy apiKey path', async () => {
    const tenant = await createTestTenant();
    await createTestAnchorBot(tenant, { deletedAt: new Date() });

    const result = await resolveBotKey(tenant.apiKey);
    expect(result).toBeNull();
  });

  it('is idempotent: two calls return equivalent results', async () => {
    const tenant = await createTestTenant();
    const anchor = await createTestAnchorBot(tenant);

    const a = await resolveBotKey(tenant.apiKey);
    const b = await resolveBotKey(tenant.apiKey);

    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a!.bot.id).toBe(anchor.id);
    expect(b!.bot.id).toBe(anchor.id);
    expect(a!.tenant.id).toBe(b!.tenant.id);
    expect(a!.isAnchorViaLegacyKey).toBe(b!.isAnchorViaLegacyKey);
  });
});

describe('resolveBotKeyStrict', () => {
  it('throws BotPausedError when the bot is paused', async () => {
    const tenant = await createTestTenant();
    await createTestAnchorBot(tenant);
    const paused = await createTestBot(tenant.id, {
      status: 'paused',
      name: 'Paused',
    });

    await expect(resolveBotKeyStrict(paused.publicKey)).rejects.toBeInstanceOf(
      BotPausedError,
    );
  });

  it('throws BotNotFoundError when the key is unknown', async () => {
    await expect(
      resolveBotKeyStrict('bk_does_not_exist'),
    ).rejects.toBeInstanceOf(BotNotFoundError);
  });

  it('throws BotNotFoundError when the bot is soft-deleted', async () => {
    const tenant = await createTestTenant();
    await createTestAnchorBot(tenant);
    const deleted = await createTestBot(tenant.id, {
      deletedAt: new Date(),
    });

    await expect(
      resolveBotKeyStrict(deleted.publicKey),
    ).rejects.toBeInstanceOf(BotNotFoundError);
  });

  it('throws BotNotFoundError when the tenant is suspended', async () => {
    const tenant = await createTestTenant({ status: 'suspended' });
    const anchor = await createTestAnchorBot(tenant);

    await expect(resolveBotKeyStrict(anchor.publicKey)).rejects.toBeInstanceOf(
      BotNotFoundError,
    );
  });

  it('throws BotNotFoundError when legacy apiKey matches but no anchor bot exists', async () => {
    const tenant = await createTestTenant();

    await expect(resolveBotKeyStrict(tenant.apiKey)).rejects.toBeInstanceOf(
      BotNotFoundError,
    );
  });

  it('returns ResolvedBot on the happy path (direct bk_* lookup)', async () => {
    const tenant = await createTestTenant();
    await createTestAnchorBot(tenant);
    const secondary = await createTestBot(tenant.id);

    const result = await resolveBotKeyStrict(secondary.publicKey);
    expect(result.bot.id).toBe(secondary.id);
    expect(result.tenant.id).toBe(tenant.id);
    expect(result.isAnchorViaLegacyKey).toBe(false);
  });

  it('returns ResolvedBot on the happy path (legacy apiKey)', async () => {
    const tenant = await createTestTenant();
    const anchor = await createTestAnchorBot(tenant);

    const result = await resolveBotKeyStrict(tenant.apiKey);
    expect(result.bot.id).toBe(anchor.id);
    expect(result.isAnchorViaLegacyKey).toBe(true);
  });
});
