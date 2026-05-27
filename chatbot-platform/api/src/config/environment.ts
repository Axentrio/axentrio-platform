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
  NODE_ENV: z.enum(['development', 'staging', 'production', 'test']).default('development'),
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
  DEFAULT_TIER: z.enum(['free', 'essential', 'pro', 'enterprise']).default('free'),
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
  N8N_DEFAULT_WEBHOOK_URL: z.string().optional(),
  RAG_INTERNAL_SECRET: z.string().optional(),
  N8N_INBOUND_SECRET: z.string().optional(),

  // AWS S3
  AWS_ACCESS_KEY_ID: z.string().optional(),
  AWS_SECRET_ACCESS_KEY: z.string().optional(),
  AWS_REGION: z.string().default('eu-west-1'),
  AWS_S3_BUCKET: z.string().optional(),
  S3_ENDPOINT: z.string().optional(),
  S3_FORCE_PATH_STYLE: z.string().default('false').transform((v) => v === 'true'),
  S3_SIGNED_URL_EXPIRY: z.string().default('900').transform(Number),
  CDN_URL: z.string().optional(),

  // LLM / RAG
  OPENAI_API_KEY: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  // Per-tenant daily LLM call cap. Default 5000. Override per-tenant via Tenant.dailyLlmCallLimit.
  LLM_DAILY_LIMIT_PER_TENANT: z.string().default('5000').transform(Number),
  RAG_DEFAULT_CHUNK_SIZE: z.string().default('500').transform(Number),
  RAG_DEFAULT_CHUNK_OVERLAP: z.string().default('100').transform(Number),
  RAG_MAX_CONTEXT_CHUNKS: z.string().default('5').transform(Number),
  RAG_MIN_SIMILARITY: z.string().default('0.3').transform(Number),
  RAG_CONVERSATION_HISTORY_LIMIT: z.string().default('10').transform(Number),
  RAG_EMBEDDING_BATCH_SIZE: z.string().default('100').transform(Number),
  RAG_MAX_EXTRACTED_CHARS: z.string().default('500000').transform(Number),
  RAG_MAX_CHUNKS_PER_DOC: z.string().default('1000').transform(Number),

  // Super Admin
  SUPER_ADMIN_EMAILS: z.string().default('').transform(v =>
    v.split(',').map(e => e.trim().toLowerCase()).filter(Boolean)
  ),

  // Clerk
  CLERK_SECRET_KEY: z.string().min(1).default('clerk-dev-key-set-in-production'),
  CLERK_WEBHOOK_SECRET: z.string().optional(),

  // ClamAV (optional)
  // Sentry
  SENTRY_DSN: z.string().optional(),
  SENTRY_ENVIRONMENT: z.string().optional(),

  // Audit
  AUDIT_RETENTION_DAYS: z.string().default('90').transform(Number),

  CLAMAV_HOST: z.string().optional(),
  CLAMAV_PORT: z.string().default('3310').transform(Number),
  CLAMAV_TIMEOUT: z.string().default('60000').transform(Number),

  // Email (Resend)
  RESEND_API_KEY: z.string().optional(),
  EMAIL_FROM_ADDRESS: z.string().default('noreply@notifications.example.com'),

  // Meta (Messenger + Instagram)
  META_APP_ID: z.string().optional(),
  META_APP_SECRET: z.string().optional(),
  META_VERIFY_TOKEN: z.string().optional(),
  META_OAUTH_REDIRECT_URI: z.string().optional(),
  META_OAUTH_JWT_SECRET: z.string().optional(),

  // WhatsApp Cloud API. App secret falls back to META_APP_SECRET (same Meta app);
  // verify token falls back to META_VERIFY_TOKEN. Override only if WhatsApp lives
  // in a separate app or you want a distinct webhook verify token.
  WHATSAPP_APP_SECRET: z.string().optional(),
  WHATSAPP_VERIFY_TOKEN: z.string().optional(),

  // Billing — Stripe (required in non-test environments; validated below).
  // M0 subscription epic: EUR-only catalog (Essential + Pro + Enterprise).
  // Premium tier removed entirely.
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  STRIPE_PRICE_ESSENTIAL: z.string().optional(),
  STRIPE_PRICE_PRO: z.string().optional(),
  STRIPE_PRICE_ENTERPRISE: z.string().optional(),
  BILLING_TRIAL_DAYS: z.string().default('14').transform(Number),
  // Escape hatch: when 'true', boot proceeds without Stripe creds.
  // Billing endpoints will fail at call time. Use only for environments
  // that legitimately can't configure Stripe yet (early staging deploys).
  SKIP_BILLING_BOOT_CHECK: z.string().optional(),
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
  if (env.WIDGET_API_KEY === 'widget-dev-key') {
    throw new Error('WIDGET_API_KEY must be set in production');
  }
}

// Billing fail-fast — Stripe is REQUIRED in production. Development and
// staging boot with a warning when credentials are missing so local devs can
// run the API without provisioning Stripe first; billing endpoints just fail
// at call time. (User ask: until real Stripe keys are issued, don't block
// local servers from starting.)
//
// `SKIP_BILLING_BOOT_CHECK=true` is still honoured in production for the rare
// case where prod legitimately can't configure Stripe yet (early deploys);
// downgrade to a warning instead of exit.
if (env.NODE_ENV !== 'test') {
  const missing: string[] = [];
  if (!env.STRIPE_SECRET_KEY) missing.push('STRIPE_SECRET_KEY');
  if (!env.STRIPE_WEBHOOK_SECRET) missing.push('STRIPE_WEBHOOK_SECRET');
  if (!env.STRIPE_PRICE_ESSENTIAL) missing.push('STRIPE_PRICE_ESSENTIAL');
  if (!env.STRIPE_PRICE_PRO) missing.push('STRIPE_PRICE_PRO');
  if (!env.STRIPE_PRICE_ENTERPRISE) missing.push('STRIPE_PRICE_ENTERPRISE');
  if (missing.length > 0) {
    const message =
      `Billing configuration: required Stripe env vars are missing: ${missing.join(', ')}. ` +
      `Billing endpoints will return errors until configured.`;
    const isProd = env.NODE_ENV === 'production';
    const skipped = env.SKIP_BILLING_BOOT_CHECK === 'true';
    if (isProd && !skipped) {
      console.error(`Billing configuration error: ${message} ` +
        `Set them or pass SKIP_BILLING_BOOT_CHECK=true to boot with billing degraded.`);
      process.exit(1);
    } else {
      const prefix = isProd ? '[SKIP_BILLING_BOOT_CHECK=true]' : '[non-production boot]';
      console.warn(`${prefix} ${message}`);
    }
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
    isStaging: env.NODE_ENV === 'staging',
    isProduction: env.NODE_ENV === 'production',
    isTest: env.NODE_ENV === 'test',
  },

  database: {
    host: parsedDbUrl ? parsedDbUrl.host ?? 'localhost' : env.DB_HOST,
    port: parsedDbUrl ? Number(parsedDbUrl.port ?? 5432) : env.DB_PORT,
    name: parsedDbUrl ? parsedDbUrl.database ?? 'chatbot_platform' : env.DB_NAME,
    user: parsedDbUrl ? parsedDbUrl.user ?? 'postgres' : env.DB_USER,
    password: parsedDbUrl ? parsedDbUrl.password ?? '' : env.DB_PASSWORD,
    ssl: env.NODE_ENV === 'test' ? false : (parsedDbUrl ? true : env.DB_SSL),
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

  llmRateLimit: {
    // Daily LLM call cap per tenant. Used when Tenant.dailyLlmCallLimit is null.
    dailyLimitPerTenant: env.LLM_DAILY_LIMIT_PER_TENANT,
  },

  rag: {
    openaiApiKey: env.OPENAI_API_KEY,
    anthropicApiKey: env.ANTHROPIC_API_KEY,
    defaultChunkSize: env.RAG_DEFAULT_CHUNK_SIZE,
    defaultChunkOverlap: env.RAG_DEFAULT_CHUNK_OVERLAP,
    maxContextChunks: env.RAG_MAX_CONTEXT_CHUNKS,
    minSimilarity: env.RAG_MIN_SIMILARITY,
    conversationHistoryLimit: env.RAG_CONVERSATION_HISTORY_LIMIT,
    embeddingBatchSize: env.RAG_EMBEDDING_BATCH_SIZE,
    maxExtractedChars: env.RAG_MAX_EXTRACTED_CHARS,
    maxChunksPerDoc: env.RAG_MAX_CHUNKS_PER_DOC,
  },

  audit: {
    retentionDays: env.AUDIT_RETENTION_DAYS,
  },

  clamav: {
    host: env.CLAMAV_HOST,
    port: env.CLAMAV_PORT,
    timeout: env.CLAMAV_TIMEOUT,
    enabled: !!env.CLAMAV_HOST,
  },

  n8n: {
    webhookUrl: env.WEBHOOK_URL || env.N8N_WEBHOOK_URL,
    defaultWebhookUrl: env.N8N_DEFAULT_WEBHOOK_URL || env.WEBHOOK_URL || env.N8N_WEBHOOK_URL,
    enabled: !!(env.WEBHOOK_URL || env.N8N_WEBHOOK_URL || env.N8N_DEFAULT_WEBHOOK_URL),
    ragInternalSecret: env.RAG_INTERNAL_SECRET,
    inboundSecret: env.N8N_INBOUND_SECRET,
  },

  superAdmin: {
    emails: env.SUPER_ADMIN_EMAILS,
  },

  clerk: {
    secretKey: env.CLERK_SECRET_KEY,
    webhookSecret: env.CLERK_WEBHOOK_SECRET,
  },

  widget: {
    apiKey: env.WIDGET_API_KEY,
  },

  meta: {
    appId: env.META_APP_ID || '',
    appSecret: env.META_APP_SECRET || '',
    verifyToken: env.META_VERIFY_TOKEN || '',
    oauthRedirectUri: env.META_OAUTH_REDIRECT_URI || '',
    oauthJwtSecret: env.META_OAUTH_JWT_SECRET || '',
  },

  whatsapp: {
    // Shared Meta app secret unless WhatsApp uses a separate app.
    appSecret: env.WHATSAPP_APP_SECRET || env.META_APP_SECRET || '',
    verifyToken: env.WHATSAPP_VERIFY_TOKEN || env.META_VERIFY_TOKEN || '',
  },

  email: {
    resendApiKey: env.RESEND_API_KEY,
    fromAddress: env.EMAIL_FROM_ADDRESS,
  },

  api: {
    url: env.API_URL,
  },

  billing: {
    trialDays: env.BILLING_TRIAL_DAYS,
    stripe: {
      secretKey: env.STRIPE_SECRET_KEY ?? '',
      webhookSecret: env.STRIPE_WEBHOOK_SECRET ?? '',
      priceEssential: env.STRIPE_PRICE_ESSENTIAL ?? '',
      pricePro: env.STRIPE_PRICE_PRO ?? '',
      priceEnterprise: env.STRIPE_PRICE_ENTERPRISE ?? '',
    },
  },
} as const;

export type Config = typeof config;
