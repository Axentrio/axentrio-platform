import { logger } from '../utils/logger';

interface RedisLike {
  hincrby(key: string, field: string, increment: number): Promise<number>;
  hgetall(key: string): Promise<Record<string, string>>;
  expireat(key: string, timestamp: number): Promise<number>;
}

export class MeteringService {
  private redis: RedisLike;

  constructor(redis: RedisLike) {
    this.redis = redis;
  }

  async record(tenantId: string, usage: { promptTokens: number; completionTokens: number }): Promise<void> {
    const key = this.getDailyKey(tenantId);
    const total = usage.promptTokens + usage.completionTokens;

    try {
      await Promise.all([
        this.redis.hincrby(key, 'prompt', usage.promptTokens),
        this.redis.hincrby(key, 'completion', usage.completionTokens),
        this.redis.hincrby(key, 'total', total),
        this.redis.hincrby(key, 'calls', 1),
      ]);

      // Set expiry to end of day UTC (auto-cleanup, no manual reset needed)
      const endOfDay = new Date();
      endOfDay.setUTCHours(23, 59, 59, 999);
      await this.redis.expireat(key, Math.floor(endOfDay.getTime() / 1000));
    } catch (error) {
      logger.warn('Failed to record token usage', { tenantId, error });
    }
  }

  async isOverBudget(tenantId: string, dailyBudget: number | undefined | null): Promise<boolean> {
    if (!dailyBudget) return false;

    try {
      const key = this.getDailyKey(tenantId);
      const data = await this.redis.hgetall(key);
      const totalUsed = parseInt(data?.total || '0', 10);
      return totalUsed >= dailyBudget;
    } catch (error) {
      logger.warn('Failed to check token budget', { tenantId, error });
      return false; // Fail open — don't block conversations because metering is down
    }
  }

  async getDailyUsage(tenantId: string): Promise<{ prompt: number; completion: number; total: number; calls: number }> {
    const key = this.getDailyKey(tenantId);
    const data = await this.redis.hgetall(key);
    return {
      prompt: parseInt(data?.prompt || '0', 10),
      completion: parseInt(data?.completion || '0', 10),
      total: parseInt(data?.total || '0', 10),
      calls: parseInt(data?.calls || '0', 10),
    };
  }

  private getDailyKey(tenantId: string): string {
    const today = new Date().toISOString().split('T')[0];
    return `tokens:${tenantId}:${today}`;
  }
}
