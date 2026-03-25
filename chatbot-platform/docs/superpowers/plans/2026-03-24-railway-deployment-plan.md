# Railway Deployment — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire up all orphaned features into a working server, fix the Dockerfile, and deploy the chatbot platform to Railway.

**Architecture:** Fresh `server.ts` cherry-picking the best of Layer 1 (active prototype) and Layer 2 (orphaned full-featured code). Layer 2's config, entities, and feature modules become the foundation. Layer 1's working socket handler and route logic are carried over and adapted.

**Tech Stack:** Node.js 20, Express, Socket.io, TypeORM, PostgreSQL, Redis, Bull, AWS S3, Vite/React (portal)

**Spec:** `docs/superpowers/specs/2026-03-24-railway-deployment-fix-design.md`

**Plan structure:** 3 phases, each producing a testable checkpoint.
- Phase 1 (Tasks 1–6): Foundation — deps, config, database, imports, logger. Checkpoint: `tsc` compiles.
- Phase 2 (Tasks 7–14): Feature wiring — auth, routes, WebSocket, n8n, files, queue, server.ts. Checkpoint: server boots and responds to `/health`.
- Phase 3 (Tasks 15–17): Deployment — Dockerfile, portal, Railway config. Checkpoint: deployable to Railway.

---

## Phase 1: Foundation (compile checkpoint)

### Task 1: Install Missing npm Dependencies

**Files:**
- Modify: `api/package.json`

- [ ] **Step 1: Install production dependencies**

```bash
cd chatbot-platform/api
npm install bull sharp @aws-sdk/client-s3 @aws-sdk/s3-request-presigner bcryptjs axios pg-connection-string winston-daily-rotate-file
```

- [ ] **Step 2: Install dev dependencies**

```bash
npm install -D @types/bull @types/bcryptjs
```

- [ ] **Step 3: Update migration scripts in package.json**

Change `"migration:run"` and `"migration:generate"` to point to `src/database/data-source.ts` instead of `src/config/database.ts`.

- [ ] **Step 4: Verify install**

```bash
npm ls bull sharp @aws-sdk/client-s3 bcryptjs axios pg-connection-string
```
Expected: all packages listed, no errors.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json
git commit -m "deps: add missing packages for orphaned modules (bull, sharp, aws-sdk, bcryptjs, axios)"
```

---

### Task 2: Consolidate Config — `environment.ts`

**Files:**
- Modify: `api/src/config/environment.ts`
- Reference: `api/src/config/env.ts` (will be deleted in Task 5)

**Context:** `environment.ts` is Layer 2's comprehensive config. It needs additions for Railway compatibility (DATABASE_URL, REDIS_URL), widget auth (WIDGET_API_KEY), S3, and n8n.

- [ ] **Step 1: Add Railway connection string vars to the Zod schema**

Add these fields to the `envSchema` object in `environment.ts`:

```typescript
// Railway connection strings (take priority over individual vars when present)
DATABASE_URL: z.string().optional(),
REDIS_URL: z.string().optional(),
```

- [ ] **Step 2: Add widget, API, and n8n vars**

```typescript
// Widget
WIDGET_API_KEY: z.string().default('widget-dev-key'),

// API base URL (for webhook callbacks)
API_URL: z.string().default('http://localhost:3000'),

// N8N
N8N_WEBHOOK_URL: z.string().optional(),

// Log format
LOG_FORMAT: z.enum(['combined', 'dev', 'json']).default('combined'),
```

- [ ] **Step 3: Add S3/AWS vars**

```typescript
// AWS S3
AWS_ACCESS_KEY_ID: z.string().optional(),
AWS_SECRET_ACCESS_KEY: z.string().optional(),
AWS_REGION: z.string().default('eu-west-1'),
AWS_S3_BUCKET: z.string().optional(),
S3_ENDPOINT: z.string().optional(),
S3_FORCE_PATH_STYLE: z.string().default('false').transform((v) => v === 'true'),
S3_SIGNED_URL_EXPIRY: z.string().default('900').transform(Number),
CDN_URL: z.string().optional(),

// ClamAV (optional)
CLAMAV_HOST: z.string().optional(),
CLAMAV_PORT: z.string().default('3310').transform(Number),
CLAMAV_TIMEOUT: z.string().default('60000').transform(Number),
```

- [ ] **Step 4: Add DATABASE_URL parsing logic**

After `const env = parseEnv();`, add:

```typescript
import { parse as parsePgConnectionString } from 'pg-connection-string';

// Override individual DB vars from DATABASE_URL if present
if (env.DATABASE_URL) {
  const parsed = parsePgConnectionString(env.DATABASE_URL);
  // Override in config object below
}
```

Then update the `config.database` section to use parsed values when DATABASE_URL is present:

```typescript
database: {
  host: env.DATABASE_URL ? parsed.host ?? 'localhost' : env.DB_HOST,
  port: env.DATABASE_URL ? Number(parsed.port ?? 5432) : env.DB_PORT,
  name: env.DATABASE_URL ? parsed.database ?? 'chatbot_platform' : env.DB_NAME,
  user: env.DATABASE_URL ? parsed.user ?? 'postgres' : env.DB_USER,
  password: env.DATABASE_URL ? parsed.password ?? '' : env.DB_PASSWORD,
  ssl: env.DATABASE_URL ? true : env.DB_SSL,  // Railway requires SSL
  // ... keep existing poolSize, connectionTimeout
  url: env.DATABASE_URL ?? `postgresql://${env.DB_USER}:${env.DB_PASSWORD}@${env.DB_HOST}:${env.DB_PORT}/${env.DB_NAME}`,
},
```

- [ ] **Step 5: Add REDIS_URL parsing to config object**

Add a `redis.url` field and override logic:

```typescript
redis: {
  url: env.REDIS_URL,
  host: env.REDIS_HOST,
  port: env.REDIS_PORT,
  password: env.REDIS_PASSWORD,
  // ... keep existing fields
  getConnectionOptions: () => {
    if (env.REDIS_URL) {
      return env.REDIS_URL; // ioredis accepts URL strings directly
    }
    return { host: env.REDIS_HOST, port: env.REDIS_PORT, /* ... existing */ };
  },
},
```

- [ ] **Step 6: Add new config sections for S3, ClamAV, n8n, widget**

```typescript
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
  webhookUrl: env.N8N_WEBHOOK_URL,
  enabled: !!env.N8N_WEBHOOK_URL,
},

widget: {
  apiKey: env.WIDGET_API_KEY,
},

api: {
  url: env.API_URL,
},
```

- [ ] **Step 7: Make JWT_SECRET and JWT_REFRESH_SECRET optional with defaults for dev**

Currently the schema requires 32-char min on these. For development, add `.default()` so the server doesn't crash without a `.env` file. Keep the min(32) for production via a runtime check.

```typescript
JWT_SECRET: z.string().min(1).default('development-jwt-secret-change-in-prod-32chars'),
JWT_REFRESH_SECRET: z.string().min(1).default('development-refresh-secret-change-prod-32chars'),
ENCRYPTION_KEY: z.string().min(1).default('development-encryption-key-32ch'),
```

Add a runtime warning after parse:
```typescript
if (env.NODE_ENV === 'production') {
  if (env.JWT_SECRET.length < 32) throw new Error('JWT_SECRET must be 32+ chars in production');
  // same for JWT_REFRESH_SECRET and ENCRYPTION_KEY
}
```

- [ ] **Step 8: Verify the file parses correctly**

```bash
cd chatbot-platform/api
npx ts-node -e "import './src/config/environment'; console.log('Config OK')"
```
Expected: "Config OK" (or env validation errors listing missing vars — that's fine, means parsing works).

- [ ] **Step 9: Commit**

```bash
git add src/config/environment.ts
git commit -m "config: add Railway, S3, n8n, widget vars to environment.ts"
```

---

### Task 3: Update Database Data Source

**Files:**
- Modify: `api/src/database/data-source.ts`

**Context:** `data-source.ts` currently imports from `../config/environment` and `../config/logger`. After Task 2, `environment.ts` has all needed config. Logger import needs to switch to `../utils/logger`.

- [ ] **Step 1: Read `data-source.ts` and identify current imports**

Check exact imports. It currently imports `config` from `../config/environment` and `logger` from `../config/logger`.

- [ ] **Step 2: Update logger import**

Change:
```typescript
import logger from '../config/logger';
```
To:
```typescript
import { logger } from '../utils/logger';
```

- [ ] **Step 3: Add synchronize guard**

Change synchronize line to:
```typescript
synchronize: config.server.isDevelopment && !config.database.url,
```

This prevents accidental schema modifications on Railway even if NODE_ENV is wrong. Uses falsy check (not `.startsWith()`) to avoid null reference errors when `config.database.url` is undefined.

- [ ] **Step 4: Commit**

```bash
git add src/database/data-source.ts
git commit -m "db: update data-source.ts imports, add synchronize guard"
```

---

### Task 4: Update Logger

**Files:**
- Modify: `api/src/utils/logger.ts`

**Context:** `utils/logger.ts` imports from `../config/env`. Switch to `../config/environment`. Also export a default export since Layer 2 files import `logger` as default.

- [ ] **Step 1: Update import**

Change line 6:
```typescript
import { env } from '../config/env';
```
To:
```typescript
import { config } from '../config/environment';
```

- [ ] **Step 2: Update all references from `env.*` to `config.*`**

Replace `env.NODE_ENV` → `config.server.env`, `env.LOG_LEVEL` → `config.logging.level`, etc.

- [ ] **Step 3: Add daily file rotation for production**

Add a daily rotate file transport (from Layer 2's `config/logger.ts` pattern):

```typescript
import DailyRotateFile from 'winston-daily-rotate-file';

if (config.server.isProduction) {
  logger.add(new DailyRotateFile({
    filename: `${config.logging.dir}/app-%DATE%.log`,
    datePattern: 'YYYY-MM-DD',
    maxFiles: `${config.logging.maxFiles}d`,
    format: winston.format.json(),
  }));
}
```

Note: This requires `npm install winston-daily-rotate-file` (add to Task 1 deps).

- [ ] **Step 4: Add morganStream export and default export**

At the end of the file, add:
```typescript
// Stream for morgan HTTP request logging
export const morganStream = {
  write: (message: string) => logger.info(message.trim()),
};

export default logger;
```

This ensures both `import { logger }` and `import logger from` work, since different files use different import styles.

- [ ] **Step 5: Set log format based on environment**

Ensure the logger uses JSON format in production and colorized in development:
```typescript
const logFormat = config.server.isProduction
  ? winston.format.json()
  : winston.format.combine(winston.format.colorize(), winston.format.simple());
```

- [ ] **Step 6: Commit**

```bash
git add src/utils/logger.ts
git commit -m "logger: switch to environment.ts config, add rotation, morganStream, default export"
```

---

### Task 5: Delete Old Files and Rewrite Imports

**Files to delete:**
- `api/src/config/env.ts`
- `api/src/config/database.ts`
- `api/src/config/logger.ts`
- `api/src/models/` (entire directory: Tenant.ts, ChatSession.ts, Message.ts, Agent.ts, index.ts)
- `api/src/auth/jwt.ts`
- `api/src/auth/api-key.ts`
- `api/src/auth/index.ts`
- `api/src/middleware/auth.ts` (the orphaned Layer 2 duplicate)
- `api/src/routes/health.ts`
- `api/src/routes/sessions.ts`
- `api/src/routes/messages.ts`
- `api/src/websocket/socket-server.ts`

**Files to rewrite imports in:**
All files listed in Spec Section 15 "Import rewrites" table.

- [ ] **Step 1: Delete old files**

```bash
cd chatbot-platform/api/src
rm config/env.ts config/database.ts config/logger.ts
rm -rf models/
rm auth/jwt.ts auth/api-key.ts auth/index.ts
rm middleware/auth.ts
rm routes/health.ts routes/sessions.ts routes/messages.ts
rm websocket/socket-server.ts
```

- [ ] **Step 2: Rewrite imports in `middleware/auth.middleware.ts`**

Line 8: `import { env } from '../config/env'` → `import { config } from '../config/environment'`
Line 10: `import { AppDataSource } from '../config/database'` → `import { AppDataSource } from '../database/data-source'`
Line 11: `import { Agent } from '../models/Agent'` → `import { Agent } from '../database/entities/Agent'`

Then update all `env.*` references in the file body to use `config.*`:
- `env.JWT_SECRET` → `config.jwt.secret`
- `env.JWT_EXPIRES_IN` → `config.jwt.expiresIn`
- `env.JWT_REFRESH_SECRET` → `config.jwt.refreshSecret`
- `env.WIDGET_API_KEY` → `config.widget.apiKey`

- [ ] **Step 3: Rewrite imports in `middleware/tenant.middleware.ts`**

Line 8: `import { AppDataSource } from '../config/database'` → `import { AppDataSource } from '../database/data-source'`
Line 9: `import { Tenant } from '../models/Tenant'` → `import { Tenant } from '../database/entities/Tenant'`

- [ ] **Step 4: Rewrite imports in `middleware/rate-limit.middleware.ts`**

Line 8: `import { env } from '../config/env'` → `import { config } from '../config/environment'`

Update body: `env.RATE_LIMIT_*` → `config.rateLimit.*`

- [ ] **Step 5: Rewrite imports in `routes/auth.routes.ts`**

Line 10: `import { AppDataSource } from '../config/database'` → `import { AppDataSource } from '../database/data-source'`
Line 11: `import { Agent } from '../models/Agent'` → `import { Agent } from '../database/entities/Agent'`
Line 12: `import { ChatSession } from '../models/ChatSession'` → `import { ChatSession } from '../database/entities/ChatSession'`
Line 13: `import { env } from '../config/env'` → `import { config } from '../config/environment'`

Update body: `env.*` → `config.*`

- [ ] **Step 6: Rewrite imports in `routes/chat.routes.ts`**

Line 9: `import { AppDataSource } from '../config/database'` → `import { AppDataSource } from '../database/data-source'`
Line 10: `import { ChatSession } from '../models/ChatSession'` → `import { ChatSession } from '../database/entities/ChatSession'`
Line 11: `import { Message } from '../models/Message'` → `import { Message } from '../database/entities/Message'`

- [ ] **Step 7: Rewrite imports in `routes/handsoff.routes.ts`**

Line 10: `import { AppDataSource } from '../config/database'` → `import { AppDataSource } from '../database/data-source'`
Line 11: `import { ChatSession } from '../models/ChatSession'` → `import { ChatSession } from '../database/entities/ChatSession'`
Line 12: `import { Message } from '../models/Message'` → `import { Message } from '../database/entities/Message'`
Line 13: `import { Agent } from '../models/Agent'` → `import { Agent } from '../database/entities/Agent'`

- [ ] **Step 8: Rewrite imports in `websocket/socket.handler.ts`**

Line 10: `import { env } from '../config/env'` → `import { config } from '../config/environment'`
Line 15: `import { AppDataSource } from '../config/database'` → `import { AppDataSource } from '../database/data-source'`
Line 16: `import { ChatSession } from '../models/ChatSession'` → `import { ChatSession } from '../database/entities/ChatSession'`
Line 17: `import { Message } from '../models/Message'` → `import { Message } from '../database/entities/Message'`

Update body: `env.*` → `config.*`

- [ ] **Step 9: Rewrite `config/logger.ts` → `utils/logger` imports in Layer 2 files**

These files import `logger` as default from `../config/logger`. Change to:

```typescript
// In each file, change:
import logger from '../config/logger';
// To:
import { logger } from '../utils/logger';
```

Files to update:
- `middleware/error-handler.ts` (line 7)
- `middleware/rate-limit.ts` (line 11)
- `routes/tenants.ts` (line 12)
- `routes/widget.ts` (line 15)
- `utils/encryption.ts` (line 8)
- `queue/message-queue.ts` (line 8)

- [ ] **Step 10: Rewrite `config/s3.config.ts`**

Line 2: `import { env } from './env'` → `import { config } from './environment'`

Update body: replace all `env.AWS_REGION` → `config.s3.region`, `env.AWS_ACCESS_KEY_ID` → `config.s3.accessKeyId`, `env.AWS_SECRET_ACCESS_KEY` → `config.s3.secretAccessKey`, `env.AWS_S3_BUCKET` → `config.s3.bucket`, `env.S3_ENDPOINT` → `config.s3.endpoint`, `env.S3_FORCE_PATH_STYLE` → `config.s3.forcePathStyle`, `env.MAX_FILE_SIZE` → `config.fileUpload.maxFileSize`, `env.S3_SIGNED_URL_EXPIRY` → `config.s3.signedUrlExpiry`, `env.CDN_URL` → `config.s3.cdnUrl`.

- [ ] **Step 11: Rewrite `n8n/webhook.controller.ts` imports**

This file imports `{ Logger }` from `../utils/logger` (already correct path, but verify the export name matches). It also imports `{ validateJsonSchema }` from `../utils/validation` and `{ MetricsService }` from `../services/metrics.service` — these will be created in Task 6 as stubs. No changes needed here if stubs match expected signatures.

Also check if it imports from `models/` — if so, update to `database/entities/`.

- [ ] **Step 12: Fix `routes/tenants.ts` — remove `auth/api-key` import**

Line 10: `import { generateApiKey } from '../auth/api-key'` — this file was deleted.

Replace with an inline utility:
```typescript
import crypto from 'crypto';
function generateApiKey(): string {
  return crypto.randomBytes(32).toString('hex');
}
```

- [ ] **Step 13: Fix `routes/widget.ts` — remove deleted imports**

Line 11: `import { validateApiKey, generateWidgetToken } from '../auth/api-key'` — deleted.
Line 14: `import { emitToSession } from '../websocket/socket-server'` — deleted.

Replace with:
```typescript
import { emitToSession } from '../websocket/socket.handler';
import { config } from '../config/environment';

// Inline validateApiKey — compare against config
function validateApiKey(key: string): boolean {
  return key === config.widget.apiKey;
}
```

For `generateWidgetToken`, move it to `auth.middleware.ts` and import from there (it's a JWT sign call for widget sessions).

- [ ] **Step 14: Commit deletions**

```bash
git add -A
git commit -m "refactor: delete Layer 1 duplicate files"
```

- [ ] **Step 15: Commit import rewrites**

```bash
git add -A
git commit -m "refactor: rewrite all imports from deleted modules to Layer 2 equivalents"
```

---

### Task 6: Create Stub Files for Missing Dependencies

**Files:**
- Create: `api/src/services/metrics.service.ts`
- Create: `api/src/utils/validation.ts`

**Context:** The n8n module imports these but they don't exist. Create minimal stubs so the code compiles.

- [ ] **Step 1: Create `services/metrics.service.ts`**

```typescript
/**
 * Metrics Service — stub implementation
 * Tracks request counts and latency for n8n webhook processing.
 * Replace with a real metrics library (prom-client) when needed.
 */

export class MetricsService {
  private static instance: MetricsService;

  static getInstance(): MetricsService {
    if (!MetricsService.instance) {
      MetricsService.instance = new MetricsService();
    }
    return MetricsService.instance;
  }

  incrementCounter(name: string, labels?: Record<string, string>): void {
    // Stub: log in debug mode, no-op in production
  }

  recordLatency(name: string, durationMs: number, labels?: Record<string, string>): void {
    // Stub: log in debug mode, no-op in production
  }

  getMetrics(): Record<string, unknown> {
    return {};
  }
}
```

- [ ] **Step 2: Create `utils/validation.ts`**

Read `n8n/webhook.controller.ts` to see how `validateJsonSchema` is called, then create a matching stub:

```typescript
/**
 * Validation utilities — stub implementation
 * Used by n8n webhook controller for JSON schema validation.
 */

import { z, ZodSchema } from 'zod';

export function validateJsonSchema<T>(data: unknown, schema: ZodSchema<T>): { valid: boolean; data?: T; errors?: string[] } {
  const result = schema.safeParse(data);
  if (result.success) {
    return { valid: true, data: result.data };
  }
  return {
    valid: false,
    errors: result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
  };
}
```

- [ ] **Step 3: Verify TypeScript compiles**

```bash
cd chatbot-platform/api
npx tsc --noEmit 2>&1 | head -50
```

Review errors. At this point, most import errors should be resolved. Remaining errors are likely:
- Entity method mismatches (Layer 1 routes calling methods that don't exist on Layer 2 entities)
- Type mismatches between Layer 1 route logic and Layer 2 entity shapes

Document any remaining errors for Task 7.

- [ ] **Step 4: Commit**

```bash
git add src/services/metrics.service.ts src/utils/validation.ts
git commit -m "feat: add stub metrics service and validation utils for n8n module"
```

---

### Phase 1 Checkpoint

```bash
cd chatbot-platform/api && npx tsc --noEmit
```

**Expected:** Zero errors, or a known list of entity method mismatches to fix in Phase 2.

If there are compile errors, fix them before proceeding. Common issues:
- Entity field name differences (Layer 1 `planType` vs Layer 2 `tier`)
- Missing entity methods (`.touch()`, `.toJSON()`, `.recordLogin()`)
- Type mismatches in route handler params

---

## Phase 2: Feature Wiring (server boot checkpoint)

### Task 7: Fix Entity Method Compatibility

**Files:**
- Modify: Various entity files in `api/src/database/entities/`
- Modify: Route files that call entity methods

**Context:** Layer 1 routes call entity methods that may not exist on Layer 2 entities. This task resolves all compile errors from the Phase 1 checkpoint.

- [ ] **Step 1: Run `tsc --noEmit` and capture all errors**

```bash
cd chatbot-platform/api
npx tsc --noEmit 2>&1 | tee /tmp/tsc-errors.txt
```

- [ ] **Step 2: For each error, choose fix strategy**

For each error, decide:
- **A)** Add the missing method/property to the Layer 2 entity (if it's a useful method like `.toJSON()`)
- **B)** Rewrite the route logic to use Layer 2's entity shape (if the field was renamed, e.g., `planType` → `tier`)

- [ ] **Step 3: Apply fixes one file at a time**

Work through each file's errors. Common patterns:
- Replace `session.status === 'bot'` → `session.status === 'active'` (Layer 2 uses different status values)
- Replace `agent.password` → access via `agent.user.password` (Layer 2 separates User from Agent)
- Replace direct field access with Layer 2's getter methods if they exist

- [ ] **Step 4: Verify zero compile errors**

```bash
npx tsc --noEmit
```
Expected: 0 errors.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "fix: resolve entity method compatibility between Layer 1 routes and Layer 2 entities"
```

---

### Task 8: Consolidate Auth Middleware

**Files:**
- Modify: `api/src/middleware/auth.middleware.ts`

**Context:** Merge token refresh rotation and issuer/audience claims from the deleted `auth/jwt.ts` into `auth.middleware.ts`.

- [ ] **Step 1: Read the deleted `auth/jwt.ts` from git history**

```bash
git show HEAD~3:api/src/auth/jwt.ts
```

(Or read from the backup before deletion.) Extract:
- `generateAccessToken()` with issuer/audience
- `generateRefreshToken()`
- `refreshTokenRotation()`

- [ ] **Step 2: Add issuer/audience to existing `generateAgentToken`**

Update the JWT sign call to include:
```typescript
jwt.sign(payload, config.jwt.secret, {
  expiresIn: config.jwt.expiresIn,
  issuer: 'chatbot-platform',
  audience: 'chatbot-api',
});
```

- [ ] **Step 3: Add `generateRefreshToken()` function**

```typescript
export function generateRefreshToken(agentId: string): string {
  return jwt.sign(
    { agentId, type: 'refresh' },
    config.jwt.refreshSecret,
    { expiresIn: config.jwt.refreshExpiresIn, issuer: 'chatbot-platform' }
  );
}
```

- [ ] **Step 4: Add `refreshTokenRotation()` function**

```typescript
export function refreshTokenRotation(refreshToken: string): { accessToken: string; refreshToken: string } | null {
  try {
    const decoded = jwt.verify(refreshToken, config.jwt.refreshSecret, {
      issuer: 'chatbot-platform',
    }) as { agentId: string; type: string };

    if (decoded.type !== 'refresh') return null;

    return {
      accessToken: generateAgentToken(decoded.agentId),
      refreshToken: generateRefreshToken(decoded.agentId),
    };
  } catch {
    return null;
  }
}
```

- [ ] **Step 5: Update `verifyToken()` to check issuer/audience**

```typescript
const decoded = jwt.verify(token, config.jwt.secret, {
  issuer: 'chatbot-platform',
  audience: 'chatbot-api',
});
```

- [ ] **Step 6: Commit**

```bash
git add src/middleware/auth.middleware.ts
git commit -m "auth: merge refresh token rotation and issuer/audience from jwt.ts"
```

---

### Task 9: Enhance Existing Routes

**Files:**
- Modify: `api/src/routes/auth.routes.ts`
- Modify: `api/src/routes/chat.routes.ts`
- Modify: `api/src/routes/handsoff.routes.ts`

- [ ] **Step 1: Enhance auth routes**

In `auth.routes.ts`:
- Rename `router.post('/agent', ...)` to `router.post('/login', ...)`
- Add `POST /refresh` — does NOT use `authenticateAgent` middleware. Reads `{ refreshToken }` from body, calls `refreshTokenRotation()`.
- Add `GET /me` — uses `authenticateAgent`, returns current user from token.
- Add `POST /2fa/setup`, `POST /2fa/verify`, `POST /2fa/disable` — stub implementations returning 501 for now (2FA requires TOTP library, out of scope for first deploy).

- [ ] **Step 2: Enhance chat routes**

In `chat.routes.ts`:
- Add `POST /:id/transfer` — updates session's assigned agent.
- Add `POST /:id/close` — sets session status to 'closed'.
- Add `GET /:id/history` — alias for messages with full pagination.
- Add `POST /:id/read` — marks messages as read.

- [ ] **Step 3: Enhance handoff routes**

In `handsoff.routes.ts`:
- Add `POST /:id/accept` — assigns agent to handoff request.
- Add `POST /:id/decline` — marks handoff as declined.
- Add `GET /queue` — returns pending handoff requests for tenant.

- [ ] **Step 4: Verify compilation**

```bash
npx tsc --noEmit
```

- [ ] **Step 5: Commit**

```bash
git add src/routes/auth.routes.ts src/routes/chat.routes.ts src/routes/handsoff.routes.ts
git commit -m "routes: enhance auth, chat, handoff with portal-expected endpoints"
```

---

### Task 10: Create New Route Files

**Files:**
- Create: `api/src/routes/agents.routes.ts`
- Create: `api/src/routes/users.routes.ts`
- Create: `api/src/routes/files.routes.ts`
- Create: `api/src/routes/analytics.routes.ts`
- Create: `api/src/routes/notifications.routes.ts`

**Context:** The portal expects these endpoints. For first deploy, implement core CRUD. Analytics export and file upload can be stubs initially.

- [ ] **Step 1: Create `agents.routes.ts`**

Endpoints:
- `GET /` — list agents for tenant (paginated)
- `GET /:id` — get agent by ID
- `POST /` — create agent
- `PATCH /:id` — update agent
- `PATCH /:id/status` — update agent online status
- `GET /:id/performance` — stub, return empty metrics
- `GET /:id/shifts` — stub, return empty array

- [ ] **Step 2: Create `users.routes.ts`**

Endpoints:
- `GET /profile` — current user profile
- `PATCH /profile` — update profile
- `PATCH /preferences` — update preferences
- `PATCH /password` — change password

- [ ] **Step 3: Create `files.routes.ts`**

Endpoints:
- `POST /upload` — accepts multipart, delegates to `file-handling/upload.service.ts`. If S3 not configured, return 503.
- `GET /:id/preview` — return signed URL for preview
- `GET /:id/download` — return signed URL for download

- [ ] **Step 4: Create `analytics.routes.ts`**

Endpoints:
- `GET /dashboard` — aggregate metrics (total chats, active agents, avg response time). Query from DB.
- `GET /chats` — chat metrics with date range
- `GET /agents` — agent performance metrics
- `POST /export` — stub, return 501

- [ ] **Step 5: Create `notifications.routes.ts`**

Endpoints:
- `GET /` — list notifications for current user
- `PATCH /:id/read` — mark as read
- `PATCH /read-all` — mark all as read

**Decision:** Use an in-memory array for first deploy (notifications are ephemeral). Create a proper Notification entity in a follow-up task. The route handlers should store notifications in a `Map<agentId, Notification[]>` that resets on server restart. This avoids a DB migration for the first deploy.

- [ ] **Step 6: Verify compilation**

```bash
npx tsc --noEmit
```

- [ ] **Step 7: Commit**

```bash
git add src/routes/agents.routes.ts src/routes/users.routes.ts src/routes/files.routes.ts src/routes/analytics.routes.ts src/routes/notifications.routes.ts
git commit -m "routes: add agents, users, files, analytics, notifications endpoints"
```

---

### Task 11: Update Redis for Lazy Init + REDIS_URL

**Files:**
- Modify: `api/src/config/redis.ts`

- [ ] **Step 1: Refactor to lazy initialization**

Change from creating clients at module level to exporting a factory function. The clients should only be created when `initializeRedis()` is called.

```typescript
let redisPubClient: Redis | null = null;
let redisSubClient: Redis | null = null;
let redisClient: Redis | null = null;

export async function initializeRedis(): Promise<void> {
  const connectionArg = config.redis.url || {
    host: config.redis.host,
    port: config.redis.port,
    password: config.redis.password,
    db: config.redis.db,
    // ... retryStrategy etc
  };

  redisPubClient = new Redis(connectionArg);
  redisSubClient = new Redis(connectionArg);
  redisClient = new Redis(connectionArg);
  // ... ping checks
}

export function getPubClient(): Redis { return redisPubClient!; }
export function getSubClient(): Redis { return redisSubClient!; }
export function getRedisClient(): Redis { return redisClient!; }
```

- [ ] **Step 2: Update callers**

Files that import `redisPubClient`, `redisSubClient`, `redisClient` directly need to use getter functions instead. Main callers:
- `websocket/socket.handler.ts` — uses `redisPubClient`, `redisSubClient` for adapter
- `middleware/rate-limit.middleware.ts` — uses `redisClient`

- [ ] **Step 3: Add graceful degradation**

If Redis connection fails, log error but don't crash. Set a `redisAvailable` flag that other modules can check.

- [ ] **Step 4: Commit**

```bash
git add src/config/redis.ts src/websocket/socket.handler.ts src/middleware/rate-limit.middleware.ts
git commit -m "redis: lazy init, REDIS_URL support, graceful degradation"
```

---

### Task 12: Update WebSocket Handler

**Files:**
- Modify: `api/src/websocket/socket.handler.ts`
- Modify: `api/src/websocket/index.ts`

- [ ] **Step 1: Add dual auth to connection middleware**

In the Socket.io middleware, check both auth modes:
```typescript
io.use(async (socket, next) => {
  // Mode 1: Portal (JWT)
  if (socket.handshake.auth?.token) {
    // verify JWT, attach user to socket
  }
  // Mode 2: Widget (API key)
  else if (socket.handshake.query?.apiKey) {
    // verify API key + tenant, attach session info
  }
  else {
    return next(new Error('Authentication required'));
  }
});
```

- [ ] **Step 2: Add portal agent events**

Add handlers for: `agent:join`, `agent:leave`, `agent:status`, `handoff:accept`, `handoff:decline`.

- [ ] **Step 3: Add server-to-client emission functions**

Ensure these helpers exist and are exported:
- `emitToSession(tenantId, sessionId, event, data)`
- `emitToTenantAgents(tenantId, event, data)`
- `emitToAgent(agentId, event, data)`

- [ ] **Step 4: Fix `websocket/index.ts` barrel**

Update exports to match actual function names from `socket.handler.ts`.

- [ ] **Step 5: Commit**

```bash
git add src/websocket/
git commit -m "websocket: dual auth (JWT + widget), portal agent events"
```

---

### Task 13: Wire N8N, File Handling, Queue

**Files:**
- Modify: `api/src/n8n/outbound.service.ts`
- Modify: `api/src/file-handling/virus-scan.service.ts`
- Modify: `api/src/queue/message-queue.ts`

- [ ] **Step 1: Wire n8n outbound to socket handler**

In `outbound.service.ts`, after receiving a response from n8n, call:
```typescript
import { emitToSession } from '../websocket/socket.handler';
// After storing response in DB:
emitToSession(tenantId, sessionId, 'chat:message:received', savedMessage);
```

- [ ] **Step 2: Make ClamAV optional in virus-scan.service.ts**

Wrap the ClamAV connection in a config check:
```typescript
if (!config.clamav.enabled) {
  logger.warn('ClamAV not configured — virus scanning disabled');
  return { clean: true, skipped: true };
}
```

- [ ] **Step 3: Add queue fallback to sync**

In `message-queue.ts`, wrap Bull initialization in try/catch:
```typescript
try {
  // Initialize Bull queues
} catch (error) {
  logger.warn('Queue initialization failed, falling back to synchronous processing', { error });
  // Set flag for sync fallback
}
```

- [ ] **Step 4: Commit**

```bash
git add src/n8n/ src/file-handling/ src/queue/
git commit -m "feat: wire n8n socket emission, optional ClamAV, queue fallback"
```

---

### Task 14: Write New `server.ts`

**Files:**
- Rewrite: `api/src/server.ts`

**Context:** This is the centerpiece. Fresh server.ts that boots everything in the right order and mounts all routes under `/api/v1`.

- [ ] **Step 1: Write the new server.ts**

Structure:
```typescript
import 'reflect-metadata';
import express from 'express';
import { createServer } from 'http';
import cors from 'cors';
import helmet from 'helmet';

import { config } from './config/environment';
import { logger } from './utils/logger';
import { initializeDatabase, closeDatabase } from './database/data-source';
import { initializeRedis, closeRedis } from './config/redis';
import { initializeSocketIO } from './websocket/socket.handler';

// Security middleware
import { cspMiddleware } from './security/csp.middleware';
import { xssProtection } from './security/xss-protection';
import { auditLogger } from './security/audit.logger';

// Routes
import authRoutes from './routes/auth.routes';
import chatRoutes from './routes/chat.routes';
import handoffRoutes from './routes/handsoff.routes';
import agentRoutes from './routes/agents.routes';
import tenantRoutes from './routes/tenants';
import widgetRoutes from './routes/widget';
import fileRoutes from './routes/files.routes';
import analyticsRoutes from './routes/analytics.routes';
import notificationRoutes from './routes/notifications.routes';
import n8nRoutes from './n8n/webhook.routes';
import userRoutes from './routes/users.routes';

// Middleware
import { rateLimitByIp } from './middleware/rate-limit.middleware';
import { errorHandler } from './middleware/error-handler';

const app = express();
const httpServer = createServer(app);

// Health check (no prefix, for Railway)
app.get('/health', (req, res) => {
  res.json({ status: 'healthy', timestamp: new Date().toISOString(), env: config.server.env });
});

// Security middleware stack (order matters — per Spec Section 3)
app.use(helmet({ contentSecurityPolicy: config.server.isProduction }));  // 1. HTTP security headers
if (config.server.isProduction) {
  app.use(cspMiddleware);   // 2. Content Security Policy
  app.use(xssProtection);   // 3. XSS sanitization
}
app.use(cors({ origin: config.cors.origin, credentials: config.cors.credentials }));  // 4. CORS
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(rateLimitByIp);  // 5. Rate limiting

// API routes under /api/v1
const apiRouter = express.Router();
apiRouter.use('/auth', authRoutes);
apiRouter.use('/chats', chatRoutes);
apiRouter.use('/handoffs', handoffRoutes);
apiRouter.use('/agents', agentRoutes);
apiRouter.use('/users', userRoutes);
apiRouter.use('/tenants', tenantRoutes);
apiRouter.use('/widget', widgetRoutes);
apiRouter.use('/files', fileRoutes);
apiRouter.use('/analytics', analyticsRoutes);
apiRouter.use('/notifications', notificationRoutes);
apiRouter.use('/n8n/webhook', n8nRoutes);

app.use('/api/v1', apiRouter);

// Error handler (must be last)
app.use(errorHandler);

// Boot sequence
async function startServer(): Promise<void> {
  try {
    logger.info('Starting Chatbot Platform API...');
    await initializeDatabase();
    await initializeRedis();

    // Initialize Bull queue (depends on Redis — graceful fallback if unavailable)
    try {
      const { initializeQueue } = await import('./queue/message-queue');
      await initializeQueue();
      logger.info('Message queue initialized');
    } catch (err) {
      logger.warn('Queue initialization failed, falling back to synchronous processing', { error: err });
    }

    initializeSocketIO(httpServer);

    const PORT = config.server.port;
    httpServer.listen(PORT, () => {
      logger.info(`Server running on port ${PORT}`);
      logger.info(`Health check: http://localhost:${PORT}/health`);
    });
  } catch (error) {
    logger.error('Failed to start server:', error);
    process.exit(1);
  }
}

// Graceful shutdown
async function shutdown(signal: string): Promise<void> {
  logger.info(`Received ${signal}. Shutting down...`);
  httpServer.close();
  await closeDatabase();
  await closeRedis();
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('uncaughtException', (err) => { logger.error('Uncaught exception:', err); shutdown('uncaughtException'); });
process.on('unhandledRejection', (reason) => { logger.error('Unhandled rejection:', reason); });

startServer();
export default httpServer;
```

- [ ] **Step 2: Verify compilation**

```bash
npx tsc --noEmit
```

Fix any remaining type errors from route/middleware imports.

- [ ] **Step 3: Test server boots locally (if DB/Redis available)**

```bash
# With local Postgres and Redis running:
npm run dev
# Or just build:
npm run build
```

Check that `dist/server.js` is produced.

- [ ] **Step 4: Commit**

```bash
git add src/server.ts
git commit -m "server: complete rewrite with all routes mounted under /api/v1"
```

---

### Phase 2 Checkpoint

```bash
cd chatbot-platform/api
npm run build  # tsc produces dist/
node dist/server.js  # boots (may fail on DB/Redis connection if not available locally — that's OK)
```

Verify: `curl http://localhost:3000/health` returns `{"status":"healthy"}` (if DB/Redis are available).

---

## Phase 3: Deployment

### Task 15: Fix API Dockerfile

**Files:**
- Modify: `chatbot-platform/infra/Dockerfile`

- [ ] **Step 1: Remove all Prisma references**

Delete these lines:
- Stage 1: `COPY prisma ./prisma/` and `RUN npx prisma generate`
- Stage 2: `COPY --from=deps /app/prisma ./prisma`
- Stage 3: `COPY --from=builder --chown=nodejs:nodejs /app/prisma ./prisma`

- [ ] **Step 2: Remove `.env.production` copy**

Delete: `COPY --chown=nodejs:nodejs .env.production ./`

- [ ] **Step 3: Fix CMD entry point**

Change: `CMD ["node", "dist/main.js"]`
To: `CMD ["node", "dist/server.js"]`

- [ ] **Step 4: Verify Docker build**

```bash
cd chatbot-platform
docker build -f infra/Dockerfile -t chatbot-api ./api
```

Expected: successful build.

- [ ] **Step 5: Commit**

```bash
git add infra/Dockerfile
git commit -m "docker: remove Prisma, fix entry point to dist/server.js"
```

---

### Task 16: Create Portal Dockerfile

**Files:**
- Create: `chatbot-platform/portal/Dockerfile`
- Create: `chatbot-platform/portal/nginx.conf`

- [ ] **Step 1: Create `portal/Dockerfile`**

```dockerfile
# Stage 1: Build
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
ARG VITE_API_URL
ARG VITE_WS_URL
ENV VITE_API_URL=$VITE_API_URL
ENV VITE_WS_URL=$VITE_WS_URL
RUN npm run build

# Stage 2: Serve
FROM nginx:alpine
COPY --from=builder /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
```

- [ ] **Step 2: Create `portal/nginx.conf`**

```nginx
server {
    listen 80;
    server_name _;
    root /usr/share/nginx/html;
    index index.html;

    # SPA fallback — all routes serve index.html
    location / {
        try_files $uri $uri/ /index.html;
    }

    # Cache static assets
    location ~* \.(js|css|png|jpg|jpeg|gif|ico|svg|woff|woff2)$ {
        expires 1y;
        add_header Cache-Control "public, immutable";
    }

    # Gzip
    gzip on;
    gzip_types text/plain text/css application/json application/javascript text/xml application/xml text/javascript;
    gzip_min_length 1000;
}
```

- [ ] **Step 3: Test portal Docker build**

```bash
cd chatbot-platform/portal
docker build --build-arg VITE_API_URL=http://localhost:3000/api/v1 --build-arg VITE_WS_URL=http://localhost:3000 -t chatbot-portal .
```

- [ ] **Step 4: Commit**

```bash
git add portal/Dockerfile portal/nginx.conf
git commit -m "portal: add Dockerfile and nginx config for Railway deployment"
```

---

### Task 17: Update Railway Configuration

**Files:**
- Modify: `chatbot-platform/railway.toml`

- [ ] **Step 1: Update `railway.toml`**

```toml
[build]
builder = "DOCKERFILE"
dockerfilePath = "infra/Dockerfile"

[deploy]
startCommand = "node dist/server.js"
healthcheckPath = "/health"
healthcheckTimeout = 300
restartPolicyType = "on_failure"
restartPolicyMaxRetries = 3
numReplicas = 1
```

- [ ] **Step 2: Create `.env.example` for Railway deployment reference**

Create `api/.env.example` listing all required and optional variables from the spec:

```env
# === Required (auto-provided by Railway) ===
# DATABASE_URL=postgresql://...  (from Railway PostgreSQL plugin)
# REDIS_URL=redis://...          (from Railway Redis plugin)
# PORT=3000                      (assigned by Railway)

# === Required (set manually) ===
NODE_ENV=production
API_URL=https://your-api.up.railway.app
JWT_SECRET=                      # openssl rand -base64 32
JWT_REFRESH_SECRET=              # openssl rand -base64 32
ENCRYPTION_KEY=                  # openssl rand -base64 32
WIDGET_API_KEY=                  # openssl rand -base64 24
CORS_ORIGIN=https://your-portal.up.railway.app

# === AWS S3 (required for file uploads) ===
AWS_ACCESS_KEY_ID=
AWS_SECRET_ACCESS_KEY=
AWS_REGION=eu-west-1
AWS_S3_BUCKET=

# === Optional ===
# N8N_WEBHOOK_URL=               # If not set, message forwarding disabled
# CLAMAV_HOST=                   # If not set, virus scanning skipped
# CLAMAV_PORT=3310
# CDN_URL=                       # If not set, files served via S3 signed URLs
# SMTP_HOST=                     # If not set, email notifications disabled
```

- [ ] **Step 3: Verify all changes compile and build**

```bash
cd chatbot-platform/api
npm run build
```

- [ ] **Step 4: Final commit**

```bash
git add railway.toml api/.env.example
git commit -m "railway: fix config, add .env.example for deployment reference"
```

---

### Phase 3 Checkpoint

The project is now ready for Railway deployment. To deploy:

1. `railway login && railway init` (or `railway link` to existing project)
2. Add PostgreSQL and Redis plugins in Railway dashboard
3. Set environment variables (see Spec Section 12)
4. `railway up` for the API service
5. Deploy portal as a separate service with `VITE_API_URL` and `VITE_WS_URL` build args

---

## Post-Deployment Checklist

- [ ] Verify `https://<api>.railway.app/health` returns healthy
- [ ] Verify `https://<portal>.railway.app` loads the React app
- [ ] Test login flow (portal → API)
- [ ] Test widget WebSocket connection
- [ ] Test chat message flow (widget → API → n8n if configured)
- [ ] Verify CORS allows portal origin
- [ ] Test file upload (if S3 configured)
