/**
 * Redis Configuration
 * Lazy initialization with REDIS_URL support and graceful degradation
 */
import Redis, { RedisOptions } from 'ioredis';
import { config } from './environment';
import { logger } from '../utils/logger';

let redisPubClient: Redis | null = null;
let redisSubClient: Redis | null = null;
let redisClient: Redis | null = null;
let redisAvailable = false;

/**
 * Initialize Redis connections lazily
 * Only creates clients when called, not at module load time
 */
export async function initializeRedis(): Promise<void> {
  try {
    if (config.redis.url) {
      redisClient = new Redis(config.redis.url);
      redisPubClient = new Redis(config.redis.url);
      redisSubClient = new Redis(config.redis.url);
    } else {
      const redisOpts: RedisOptions = {
        host: config.redis.host,
        port: config.redis.port,
        password: config.redis.password,
        db: config.redis.db,
        keyPrefix: config.redis.keyPrefix,
        retryStrategy: (times: number) => Math.min(times * 50, 2000),
        maxRetriesPerRequest: 3,
        enableReadyCheck: true,
      };

      redisClient = new Redis(redisOpts);
      redisPubClient = new Redis(redisOpts);
      redisSubClient = new Redis(redisOpts);
    }

    // Attach error handlers so uncaught errors don't crash the process
    redisClient.on('error', (err) => {
      logger.error('Redis general client error:', err);
    });
    redisPubClient.on('error', (err) => {
      logger.error('Redis pub client error:', err);
    });
    redisSubClient.on('error', (err) => {
      logger.error('Redis sub client error:', err);
    });

    await redisClient.ping();
    redisAvailable = true;
    logger.info('Redis connection established');
  } catch (error) {
    logger.warn('Redis connection failed — running without Redis', { error });
    redisAvailable = false;
    // Clean up any partially created clients
    redisClient = null;
    redisPubClient = null;
    redisSubClient = null;
  }
}

export function getPubClient(): Redis | null {
  return redisPubClient;
}

export function getSubClient(): Redis | null {
  return redisSubClient;
}

export function getRedisClient(): Redis | null {
  return redisClient;
}

export function isRedisAvailable(): boolean {
  return redisAvailable;
}

/**
 * Get Redis adapter options for Socket.io
 */
export function getRedisAdapterOptions() {
  return {
    pubClient: redisPubClient,
    subClient: redisSubClient,
  };
}

/**
 * Close Redis connections
 */
export async function closeRedis(): Promise<void> {
  try {
    if (redisClient) await redisClient.quit();
    if (redisPubClient) await redisPubClient.quit();
    if (redisSubClient) await redisSubClient.quit();
    logger.info('Redis connections closed');
  } catch (error) {
    logger.error('Error closing Redis connections', { error });
  }
}

// Backward-compatible exports
export { redisClient, redisPubClient, redisSubClient };
