import crypto from 'crypto';
import { IsNull } from 'typeorm';
import { AppDataSource } from '../database/data-source';
import { Bot } from '../database/entities/Bot';
import { Tenant } from '../database/entities/Tenant';
import { NotFoundError } from '../middleware/error-handler';
import { logger } from '../utils/logger';

export const KEY_ROTATION_GRACE_DAYS = 30;

/** ~96 bits — enough for a public widget id (unique index on public_key). */
export const PUBLIC_KEY_ENTROPY_BYTES = 12;

/** New bot / post-rotation widget ids: `bk_` + 16-char base64url (~19 chars total). */
export function generatePublicKey(): string {
  return `bk_${crypto.randomBytes(PUBLIC_KEY_ENTROPY_BYTES).toString('base64url')}`;
}

export async function rotateBotKey(
  tenantId: string,
  botId: string,
): Promise<{ publicKey: string; previousPublicKey: string; previousPublicKeyExpiresAt: Date }> {
  return AppDataSource.transaction(async (manager) => {
    const bot = await manager.findOne(Bot, {
      where: { id: botId, tenantId, deletedAt: IsNull() },
      lock: { mode: 'pessimistic_write' },
    });
    if (!bot) throw new NotFoundError('Bot not found');

    const previous = bot.publicKey;
    const expiresAt = new Date(Date.now() + KEY_ROTATION_GRACE_DAYS * 24 * 60 * 60 * 1000);
    const next = generatePublicKey();
    bot.publicKey = next;
    bot.previousPublicKey = previous;
    bot.previousPublicKeyExpiresAt = expiresAt;
    bot.previousPublicKeyLastUsedAt = null;
    await manager.save(Bot, bot);

    if (bot.isDefault) {
      await manager.update(Tenant, { id: tenantId }, { apiKey: next });
    }

    logger.info('Bot public key rotated', {
      tenantId,
      botId,
      previousPublicKeyExpiresAt: expiresAt,
    });

    return { publicKey: next, previousPublicKey: previous, previousPublicKeyExpiresAt: expiresAt };
  });
}

export async function endKeyGrace(tenantId: string, botId: string): Promise<void> {
  const repo = AppDataSource.getRepository(Bot);
  const bot = await repo.findOne({
    where: { id: botId, tenantId, deletedAt: IsNull() },
  });
  if (!bot) throw new NotFoundError('Bot not found');
  await repo.update(
    { id: bot.id },
    {
      previousPublicKey: null,
      previousPublicKeyExpiresAt: null,
      previousPublicKeyLastUsedAt: null,
    },
  );
  logger.info('Bot previous public key grace ended', { tenantId, botId });
}
