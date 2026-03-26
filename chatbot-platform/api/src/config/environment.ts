/**
 * Environment Configuration
 * Centralized configuration management with validation
 */

import dotenv from 'dotenv';
import { z } from 'zod';
import path from 'path';
import { parse as parsePgConnectionString } from 'pg-connection-string';

// Load environment variables
dotenv.config({ path: path.resolve(process.cwd(), '.env') });

// Define environment schema with validation
const envSchema = z.object({
  // Server
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.string().default('3000').transform(Number),
  WS_PORT: z.string().default('3001').transform(Number),
  API_VERSION: z.string().default('v1'),

  // Railway connection strings (take priority over individual vars when present)
  DATABASE_URL: z.string().optional(),
  REDIS_URL: z.string().optional(),

  // Database
  DB_HOST: z.string().default('localhost'),
  DB_PORT: z.string().default('5432').transform(Number),
  DB_NAME: z.string().default('chatbot_platform'),
  DB_USER: z.string().default('postgres'),
  DB_PASSWORD: z.string().default(''),
  DB_SSL: z.string().default('false').transform((v) => v === 'true'),
  DB_POOL_SIZE: z.string().default('20').transform(Number),
  DB_CONNECTION_TIMEOUT: z.string().default('30000').transform(Number),

  // Redis
  REDIS_HOST: z.string().default('localhost'),
  REDIS_PORT: z.string().default('6379').transform(Number),
  REDIS_PASSWORD: z.string().optional(),
  REDIS_DB: z.string().default('0').transform(Number),
  REDIS_KEY_PREFIX: z.string().default('chatbot:'),
  REDIS_CLUSTER_ENABLED: z.string().default('false').transform((v) => v === 'true'),

  // JWT
  JWT_SECRET: z.string().min(1).default('development-jwt-secret-change-in-prod-32chars'),
  JWT_EXPIRES_IN: z.string().default('24h'),
  JWT_REFRESH_SECRET: z.string().min(1).default('development-refresh-secret-change-prod-32chars'),
  JWT_REFRESH_EXPIRES_IN: z.string().default('7d'),

  // Encryption
  ENCRYPTION_KEY: z.string().min(1).default('development-encryption-key-32ch'),
  ENCRYPTION_IV_LENGTH: z.string().default('16').transform(Number),

  // Rate Limiting
  RATE_LIMIT_WINDOW_MS: z.string().default('60000').transform(Number),
  RATE_LIMIT_MAX_REQUESTS: z.string().default('100').transform(Number),
  WS_RATE_LIMIT_MAX_CONNECTIONS: z.string().default('50').transform(Number),

  // Queue
  QUEUE_PREFIX: z.string().default('chatbot-queue'),
  QUEUE_CONCURRENCY: z.string().default('10').transform(Number),
  QUEUE_MAX_ATTEMPTS: z.string().default('3').transform(Number),
  QUEUE_BACKOFF_DELAY: z.string().default('1000').transform(Number),

  // Logging
  LOG_LEVEL: z.enum(['error', 'warn', 'info', 'debug']).default('info'),
  LOG_DIR: z.string().default('./logs'),
  LOG_MAX_FILES: z.string().default('30').transform(Number),
  LOG_FORMAT: z.enum(['combined', 'dev', 'json']).default('combined'),

  // CORS
  CORS_ORIGIN: z.string().default('*'),
  CORS_CREDENTIALS: z.string().default('true').transform((v) => v === 'true'),

  // WebSocket
  WS_HEARTBEAT_INTERVAL: z.string().default('30000').transform(Number),
  WS_CONNECTION_TIMEOUT: z.string().default('60000').transform(Number),
  WS_MAX_PAYLOAD_SIZE: z.string().default('10485760').transform(Number),

  // File Upload
  MAX_FILE_SIZE: z.string().default('10485760').transform(Number),
  ALLOWED_FILE_TYPES: z.string().default('image/jpeg,image/png,image/gif,application/pdf,text/plain'),
  UPLOAD_DIR: z.string().default('./uploads'),

  // Tenant
  DEFAULT_TIER: z.enum(['free', 'pro', 'enterprise']).default('free'),
  MAX_SESSIONS_PER_TIER_FREE: z.string().default('100').transform(Number),
  MAX_SESSIONS_PER_TIER_PRO: z.string().default('1000').transform(Number),
  MAX_SESSIONS_PER_TIER_ENTERPRISE: z.string().default('10000').transform(Number),

  // Widget
  WIDGET_API_KEY: z.string().default('widget-dev-key'),

  // API base URL (for webhook callbacks)
  API_URL: z.string().default('http://localhost:3000'),

  // Webhook / N8N
  WEBHOOK_URL: z.string().optional(),
  N8N_WEBHOOK_URL: z.string().optional(),

  // AWS S3
  AWS_ACCESS_KEY_ID: z.string().optional(),
  AWS_SECRET_ACCESS_KEY: z.string().optional(),
  AWS_REGION: z.string().default('eu-west-1'),
  AWS_S3_BUCKET: z.string().optional(),
  S3_ENDPOINT: z.string().optional(),
  S3_FORCE_PATH_STYLE: z.string().default('false').transform((v) => v === 'true'),
  S3_SIGNED_URL_EXPIRY: z.string().default('900').transform(Number),
  CDN_URL: z.string().optional(),

  // Clerk
  CLERK_SECRET_KEY: z.string().min(1).default('clerk-dev-key-set-in-production'),
  CLERK_WEBHOOK_SECRET: z.string().optional(),

  // ClamAV (optional)
  CLAMAV_HOST: z.string().optional(),
  CLAMAV_PORT: z.string().default('3310').transform(Number),
  CLAMAV_TIMEOUT: z.string().default('60000').transform(Number),
});

// Parse and validate environment variables
const parseEnv = (): z.infer<typeof envSchema> => {
  try {
    return envSchema.parse(process.env);
  } catch (error) {
    if (error instanceof z.ZodError) {
      const issues = error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n');
      console.error('Environment validation failed:\n', issues);
      process.exit(1);
    }
    throw error;
  }
};

const env = parseEnv();

// Validate secrets in production
if (env.NODE_ENV === 'production') {
  if (env.JWT_SECRET.length < 32) throw new Error('JWT_SECRET must be 32+ chars in production');
  if (env.JWT_REFRESH_SECRET.length < 32) throw new Error('JWT_REFRESH_SECRET must be 32+ chars in production');
  if (env.ENCRYPTION_KEY.length < 32) throw new Error('ENCRYPTION_KEY must be 32+ chars in production');
  if (env.CLERK_SECRET_KEY === 'clerk-dev-key-set-in-production') {
    throw new Error('CLERK_SECRET_KEY must be set in production');
  }
}

// Parse DATABASE_URL if present
const parsedDbUrl = env.DATABASE_URL ? parsePgConnectionString(env.DATABASE_URL) : null;

// Export configuration object
export const config = {
  server: {
    env: env.NODE_ENV,
    port: env.PORT,
    wsPort: env.WS_PORT,
    apiVersion: env.API_VERSION,
    isDevelopment: env.NODE_ENV === 'development',
    isProduction: env.NODE_ENV === 'production',
    isTest: env.NODE_ENV === 'test',
  },

  database: {
    host: parsedDbUrl ? parsedDbUrl.host ?? 'localhost' : env.DB_HOST,
    port: parsedDbUrl ? Number(parsedDbUrl.port ?? 5432) : env.DB_PORT,
    name: parsedDbUrl ? parsedDbUrl.database ?? 'chatbot_platform' : env.DB_NAME,
    user: parsedDbUrl ? parsedDbUrl.user ?? 'postgres' : env.DB_USER,
    password: parsedDbUrl ? parsedDbUrl.password ?? '' : env.DB_PASSWORD,
    ssl: parsedDbUrl ? true : env.DB_SSL,
    poolSize: env.DB_POOL_SIZE,
    connectionTimeout: env.DB_CONNECTION_TIMEOUT,
    url: env.DATABASE_URL ?? `postgresql://${env.DB_USER}:${env.DB_PASSWORD}@${env.DB_HOST}:${env.DB_PORT}/${env.DB_NAME}`,
  },

  redis: {
    url: env.REDIS_URL,
    host: env.REDIS_HOST,
    port: env.REDIS_PORT,
    password: env.REDIS_PASSWORD,
    db: env.REDIS_DB,
    keyPrefix: env.REDIS_KEY_PREFIX,
    clusterEnabled: env.REDIS_CLUSTER_ENABLED,
    getConnectionOptions: () => {
      if (env.REDIS_URL) {
        return env.REDIS_URL; // ioredis accepts URL strings directly
      }
      return {
        host: env.REDIS_HOST,
        port: env.REDIS_PORT,
        password: env.REDIS_PASSWORD,
        db: env.REDIS_DB,
        keyPrefix: env.REDIS_KEY_PREFIX,
        retryStrategy: (times: number) => Math.min(times * 50, 2000),
        maxRetriesPerRequest: 3,
        enableReadyCheck: true,
      };
    },
  },

  jwt: {
    secret: env.JWT_SECRET,
    expiresIn: env.JWT_EXPIRES_IN,
    refreshSecret: env.JWT_REFRESH_SECRET,
    refreshExpiresIn: env.JWT_REFRESH_EXPIRES_IN,
  },

  encryption: {
    key: env.ENCRYPTION_KEY,
    ivLength: env.ENCRYPTION_IV_LENGTH,
  },

  rateLimit: {
    windowMs: env.RATE_LIMIT_WINDOW_MS,
    maxRequests: env.RATE_LIMIT_MAX_REQUESTS,
    wsMaxConnections: env.WS_RATE_LIMIT_MAX_CONNECTIONS,
  },

  queue: {
    prefix: env.QUEUE_PREFIX,
    concurrency: env.QUEUE_CONCURRENCY,
    maxAttempts: env.QUEUE_MAX_ATTEMPTS,
    backoffDelay: env.QUEUE_BACKOFF_DELAY,
  },

  logging: {
    level: env.LOG_LEVEL,
    dir: env.LOG_DIR,
    maxFiles: env.LOG_MAX_FILES,
    format: env.LOG_FORMAT,
  },

  cors: {
    origin: env.CORS_ORIGIN === '*' ? '*' : env.CORS_ORIGIN.split(','),
    credentials: env.CORS_CREDENTIALS,
  },

  websocket: {
    heartbeatInterval: env.WS_HEARTBEAT_INTERVAL,
    connectionTimeout: env.WS_CONNECTION_TIMEOUT,
    maxPayloadSize: env.WS_MAX_PAYLOAD_SIZE,
  },

  fileUpload: {
    maxFileSize: env.MAX_FILE_SIZE,
    allowedFileTypes: env.ALLOWED_FILE_TYPES.split(','),
    uploadDir: env.UPLOAD_DIR,
  },

  tenant: {
    defaultTier: env.DEFAULT_TIER,
    maxSessionsPerTier: {
      free: env.MAX_SESSIONS_PER_TIER_FREE,
      pro: env.MAX_SESSIONS_PER_TIER_PRO,
      enterprise: env.MAX_SESSIONS_PER_TIER_ENTERPRISE,
    },
  },

  s3: {
    accessKeyId: env.AWS_ACCESS_KEY_ID,
    secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
    region: env.AWS_REGION,
    bucket: env.AWS_S3_BUCKET,
    endpoint: env.S3_ENDPOINT,
    forcePathStyle: env.S3_FORCE_PATH_STYLE,
    signedUrlExpiry: env.S3_SIGNED_URL_EXPIRY,
    cdnUrl: env.CDN_URL,
  },

  clamav: {
    host: env.CLAMAV_HOST,
    port: env.CLAMAV_PORT,
    timeout: env.CLAMAV_TIMEOUT,
    enabled: !!env.CLAMAV_HOST,
  },

  n8n: {
    webhookUrl: env.WEBHOOK_URL || env.N8N_WEBHOOK_URL,
    enabled: !!(env.WEBHOOK_URL || env.N8N_WEBHOOK_URL),
  },

  clerk: {
    secretKey: env.CLERK_SECRET_KEY,
    webhookSecret: env.CLERK_WEBHOOK_SECRET,
  },

  widget: {
    apiKey: env.WIDGET_API_KEY,
  },

  api: {
    url: env.API_URL,
  },
} as const;

export type Config = typeof config;
