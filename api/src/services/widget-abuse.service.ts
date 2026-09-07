import { Bot } from '../database/entities/Bot';
import { getRedisClient } from '../config/redis';
import { notificationService } from './notification.service';
import { logger } from '../utils/logger';

const DENIAL_WINDOW_SECONDS = 3600;
const DENIAL_ALERT_THRESHOLD = 20;

export async function recordOriginDenial(
  bot: Bot,
  tenantId: string,
  origin: string | undefined,
): Promise<void> {
  logger.warn('Widget key used from denied origin', {
    botId: bot.id,
    tenantId,
    origin,
  });

  const redis = getRedisClient();
  if (!redis) return;

  const key = `rl:origin-denied:${bot.id}`;
  const count = await redis.incr(key);
  if (count === 1) {
    await redis.expire(key, DENIAL_WINDOW_SECONDS);
  }
  if (count !== DENIAL_ALERT_THRESHOLD) return;

  const hourBucket = Math.floor(Date.now() / 3_600_000);
  const originLabel = origin ?? 'a non-browser client';
  await notificationService.createForTenant({
    tenantId,
    type: 'widget_key_abuse',
    title: 'Chatbot key used from a blocked website',
    message: `Your "${bot.name}" chatbot key was rejected ${count} times in the last hour from ${originLabel}. If you did not expect this, rotate the key.`,
    data: { botId: bot.id, origin },
    dedupeBase: `widget_key_abuse:${bot.id}:${hourBucket}`,
  });
}
