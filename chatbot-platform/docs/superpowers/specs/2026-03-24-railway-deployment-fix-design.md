# Railway Deployment Fix — Design Spec

**Date:** 2026-03-24
**Goal:** Wire up all orphaned features into a working server, fix the Dockerfile, and deploy to Railway as a ManyChat-style white-label chatbot platform.
**Approach:** Fresh `server.ts` cherry-picking the best of both Layer 1 (active) and Layer 2 (orphaned) codebases.

---

## Context

The codebase has two parallel layers that don't connect:

- **Layer 1 (active):** `server.ts` → `config/env.ts` → `config/database.ts` → `models/` (4 entities) → 3 routes → `socket.handler.ts`. This is what currently boots.
- **Layer 2 (orphaned):** `config/environment.ts` → `database/data-source.ts` → `database/entities/` (8 entities) → 5+ additional route files → n8n integration → security middleware → file handling → queue system. Never wired into the server.

The client's feature list describes Layer 2, but Layer 1 is what runs. The portal frontend expects ~30+ API endpoints; the API serves ~3. The widget and socket handler use incompatible auth protocols.

---

## 1. Configuration

### Decision
Use Layer 2's `environment.ts` as the single config source.

### Changes
- **Add `DATABASE_URL` support:** When present (Railway injects this), parse it to extract host/port/name/user/password instead of requiring individual vars.
- **Add `REDIS_URL` support:** Same pattern — parse the connection string when provided by Railway.
- **Add from `env.ts`:** `WIDGET_API_KEY`, `API_URL`, `LOG_FORMAT`.
- **Add new:** `N8N_WEBHOOK_URL` (URL the API posts to for n8n forwarding).

### Schema additions to `environment.ts`
```typescript
// Railway connection strings (take priority over individual vars)
DATABASE_URL: z.string().optional(),
REDIS_URL: z.string().optional(),

// Widget
WIDGET_API_KEY: z.string().default('widget-dev-key'),

// API
API_URL: z.string().default('http://localhost:3000'),

// N8N
N8N_WEBHOOK_URL: z.string().optional(),
```

When `DATABASE_URL` is present, parse it using `pg-connection-string` (handles passwords with special characters that `new URL()` breaks on):
```typescript
import { parse } from 'pg-connection-string';
const parsed = parse(env.DATABASE_URL);
// Override individual vars: host, port, username, password, database
```

Same pattern for `REDIS_URL` (parse with `ioredis` URL constructor).

### S3/AWS additions to schema
```typescript
AWS_ACCESS_KEY_ID: z.string().optional(),
AWS_SECRET_ACCESS_KEY: z.string().optional(),
AWS_REGION: z.string().default('eu-west-1'),
AWS_S3_BUCKET: z.string().optional(),
S3_ENDPOINT: z.string().optional(),
S3_FORCE_PATH_STYLE: z.string().default('false').transform((v) => v === 'true'),
S3_SIGNED_URL_EXPIRY: z.string().default('900').transform(Number),
CDN_URL: z.string().optional(),
```

### Deleted
- `config/env.ts`

---

## 2. Database & Entities

### Decision
Use Layer 2's `database/entities/` (8 entities) with `data-source.ts`.

### Entities
| Entity | Key fields |
|--------|-----------|
| **Tenant** | `tier: free/pro/enterprise`, `status: active/suspended/cancelled`, webhook config |
| **User** | `role: admin/agent/viewer`, login credentials, 2FA |
| **Agent** | Links to User, `skills[]`, `languages[]`, `status: online/away/busy/offline` |
| **ChatSession** | `status: active/closed/waiting/handoff`, `visitorId`, tenant-scoped |
| **Message** | AES-256 encryption via `@BeforeInsert` hooks, `contentEncrypted` flag |
| **Participant** | `type: user/agent/bot/system`, links ChatSession to participants |
| **FileUpload** | S3 key, virus scan status, thumbnails, chunked upload tracking |
| **HandoffRequest** | Priority, assignment, timeout, `status: pending/accepted/declined/expired` |

### Changes
- Update `data-source.ts` to use unified `environment.ts` config (with `DATABASE_URL` parsing).
- Ensure `synchronize: true` only when `NODE_ENV === 'development'` AND `DATABASE_URL` is not set (extra guard against accidental schema changes on Railway).
- Message entity's encryption hooks must use `ENCRYPTION_KEY` from environment config.
- **Data migration:** Since this is a fresh Railway deployment (no existing data), `synchronize: true` can be used for the first deploy in development mode, then a proper migration should be written before going to production.

### Entity method compatibility
Layer 1's routes use entity methods like `session.touch()`, `message.toJSON()`, `agent.recordLogin()`, `tenant.getConfig()`. Layer 2 entities may not have these. During implementation, each route file must be checked for entity method calls and either:
- Add the missing methods to Layer 2 entities, or
- Rewrite the route logic to use Layer 2's patterns

### Deleted
- `models/` directory (Tenant.ts, ChatSession.ts, Message.ts, Agent.ts, index.ts)
- `config/database.ts`

---

## 3. Authentication & Middleware

### Decision
Merge best of both layers into one consolidated auth module.

### Auth middleware (consolidated)
| Function | Source | Purpose |
|----------|--------|---------|
| `authenticateAgent()` | Layer 1 `auth.middleware.ts` | JWT auth for portal agents |
| `authenticateWidget()` | Layer 1 `auth.middleware.ts` | API key auth for widget sessions |
| `authenticateSocket()` | Layer 1 `auth.middleware.ts` | WebSocket connection auth (both JWT and widget) |
| `generateAccessToken()` | Layer 2 `auth/jwt.ts` | With issuer/audience claims |
| `generateRefreshToken()` | Layer 2 `auth/jwt.ts` | For portal long sessions |
| `refreshTokenRotation()` | Layer 2 `auth/jwt.ts` | Exchange refresh token for new pair |
| `verifyToken()` | Merged | Validates issuer/audience + standard JWT verification |

### Security middleware stack (mount in server.ts)
| Middleware | Source | Order |
|-----------|--------|-------|
| `helmet()` | npm package | 1st — HTTP security headers |
| `cspMiddleware()` | Layer 2 `security/csp.middleware.ts` | 2nd — Content Security Policy |
| `xssProtection()` | Layer 2 `security/xss-protection.ts` | 3rd — XSS sanitization |
| `cors()` | npm package, config from `environment.ts` | 4th — CORS |
| `rateLimitByIp()` | Layer 1 `rate-limit.middleware.ts` | 5th — Rate limiting |
| `tenantMiddleware()` | Layer 1 `tenant.middleware.ts` | Per-route — Tenant isolation |
| `auditLogger()` | Layer 2 `security/audit.logger.ts` | Per-route — Compliance logging |
| `errorHandler()` | Layer 2 `middleware/error-handler.ts` | Last — Global error handling |

### Deleted after merge
- `auth/jwt.ts`
- `auth/api-key.ts`
- `auth/index.ts`
- `middleware/auth.ts` (the orphaned duplicate, not `auth.middleware.ts`)

---

## 4. Routes

### Decision
Mount all routes under `/api/v1/` prefix. Health check stays at root `/health`.

### Route table
| Path | Source | Auth | Purpose |
|------|--------|------|---------|
| `GET /health` | Inline in server.ts | None | Health check for Railway |
| `/api/v1/auth/*` | `routes/auth.routes.ts` (enhanced) | None / JWT | Login, 2FA, refresh, logout, `/me` |
| `/api/v1/chats/*` | `routes/chat.routes.ts` (enhanced) | JWT | CRUD, messages, takeover, transfer, close, history |
| `/api/v1/handoffs/*` | `routes/handsoff.routes.ts` (enhanced) | JWT | Queue, accept, decline, create |
| `/api/v1/agents/*` | New route file | JWT | List, CRUD, status, performance, shifts |
| `/api/v1/tenants/*` | `routes/tenants.ts` | JWT (admin) | Tenant CRUD, settings, webhook config, API key regen |
| `/api/v1/widget/*` | `routes/widget.ts` | API key | Widget config, embed script |
| `/api/v1/files/*` | New route file | JWT / API key | Upload, preview, download |
| `/api/v1/analytics/*` | New route file | JWT (supervisor+) | Dashboard, chat/agent/tenant metrics, export |
| `/api/v1/notifications/*` | New route file | JWT | List, mark read, mark all read |
| `/api/v1/n8n/webhook/*` | `n8n/webhook.routes.ts` | Webhook secret | Inbound/outbound n8n communication |

### Route path renames (to match portal frontend)
- `/auth` stays as `/auth` but `POST /auth/agent` must be renamed/aliased to `POST /auth/login`
- `/chat` (singular) → `/chats` (plural)
- `/handoff` (singular) → `/handoffs` (plural)

### Enhancements to existing routes
- **auth.routes.ts:** Rename `/agent` to `/login`. Add `POST /2fa/verify`, `POST /2fa/setup`, `POST /2fa/disable`, `POST /refresh`, `GET /me`. **Important:** `POST /refresh` must NOT require `authenticateAgent` middleware — it validates the refresh token from the request body, not the expired access token header.
- **chat.routes.ts:** Add `POST /:id/transfer`, `POST /:id/close`, `GET /:id/history`, `POST /:id/read`
- **handsoff.routes.ts:** Add `POST /:id/accept`, `POST /:id/decline`, `GET /queue`

### Missing routes the portal expects
- `/api/v1/users/*` — The portal defines `/users`, `/users/:id`, `/users/profile`, `/users/preferences`, `/users/password`. Add `routes/users.routes.ts` to handle user profile and preferences. Agent CRUD is separate.

### Deleted
- `routes/health.ts` (inline in server.ts)
- `routes/sessions.ts` (folded into chat routes)
- `routes/messages.ts` (folded into chat routes)

---

## 5. WebSocket

### Decision
Layer 1's `socket.handler.ts` as the base. Extend with portal events and dual auth.

### Connection authentication
Two modes, determined by connection params:

```
Widget:   io(wsUrl, { query: { sessionId, tenantId, botId, apiKey } })
Portal:   io(wsUrl, { auth: { token: 'Bearer <jwt>' } })
```

Socket middleware checks:
1. If `auth.token` present → JWT validation → join agent rooms
2. If `query.apiKey` present → Widget API key + tenant validation → join session room
3. Neither → reject connection

### Event map

**Client → Server:**
| Event | Sender | Payload | Action |
|-------|--------|---------|--------|
| `message:send` | Widget/Portal | `{ sessionId, content, type }` | Store message, broadcast to room, forward to n8n |
| `typing:indicator` | Widget/Portal | `{ sessionId, isTyping }` | Broadcast to room |
| `session:join` | Widget/Portal | `{ sessionId }` | Join Socket.io room |
| `session:leave` | Widget/Portal | `{ sessionId }` | Leave Socket.io room |
| `agent:join` | Portal | `{ agentId }` | Mark agent online, join agent room |
| `agent:leave` | Portal | `{ agentId }` | Mark agent offline |
| `agent:status` | Portal | `{ agentId, status }` | Update agent status, broadcast |
| `handoff:accept` | Portal | `{ handoffId, agentId }` | Accept handoff, update session |
| `handoff:decline` | Portal | `{ handoffId, agentId, reason }` | Decline handoff |

**Server → Client:**
| Event | Recipient | Payload | Trigger |
|-------|-----------|---------|---------|
| `chat:message:received` | Room members | Message object | New message stored |
| `chat:new` | Tenant agents | ChatSession object | New chat created |
| `chat:update` | Tenant agents | ChatSession object | Status change |
| `chat:typing:update` | Room members | `{ sessionId, isTyping, sender }` | Typing event |
| `handoff:new` | Tenant agents | HandoffRequest object | Handoff created |
| `handoff:update` | Tenant agents | HandoffRequest object | Handoff accepted/declined |
| `agent:update` | Tenant agents | Agent object | Agent status change |
| `notification` | Specific agent | Notification object | Various triggers |
| `metrics:update` | Tenant agents | Dashboard metrics | Periodic (30s) |

### Helper functions
- `emitToSession(tenantId, sessionId, event, data)` — send to all participants in a chat
- `emitToTenantAgents(tenantId, event, data)` — send to all online agents for a tenant
- `emitToAgent(agentId, event, data)` — send to a specific agent

### Deleted
- `websocket/socket-server.ts` (orphaned duplicate)
- Fix `websocket/index.ts` barrel to match actual exports

---

## 6. N8N Integration

### Decision
Mount the existing n8n module as-is, wire to Layer 2 entities and socket handler.

### Changes
- Import entities from `database/entities/` instead of `models/`
- Connect `outbound.service.ts` to socket handler: when n8n sends a response, emit `chat:message:received` to the session room
- Add `N8N_WEBHOOK_URL` to environment config
- Mount routes at `/api/v1/n8n/webhook`
- If `N8N_WEBHOOK_URL` is not set, skip message forwarding and log warning
- **Missing dependencies:** The n8n module imports from `../services/metrics.service` and `../utils/validation` which don't exist. Create stub implementations (see Section 14).

### N8N message flow
```
User message in widget
  → WebSocket → socket.handler.ts
  → Store in DB (Message entity)
  → Forward to n8n via HTTP POST (outbound.service.ts)
  → n8n processes (AI, workflow logic)
  → n8n POSTs response to /api/v1/n8n/webhook/inbound
  → webhook.controller.ts handles action
  → Store response in DB
  → Emit via WebSocket to session room
```

---

## 7. File Handling

### Decision
Mount full pipeline. ClamAV is optional.

### Pipeline
```
POST /api/v1/files/upload (multipart)
  → validation.service.ts — check file type against whitelist, check size
  → upload.service.ts — stream to S3 bucket
  → IF CLAMAV_HOST set:
      → virus-scan.service.ts — scan via ClamAV TCP
      → If infected: move to quarantine bucket, mark FileUpload as quarantined
  → IF image:
      → thumbnail.service.ts — generate preview sizes
  → Create FileUpload entity in DB
  → Return file metadata + signed URL
```

### Graceful degradation
- No `CLAMAV_HOST` → skip virus scanning, log warning at startup
- No `AWS_S3_BUCKET` → file upload endpoints return 503 with clear error message
- No `CDN_URL` → serve files via S3 signed URLs directly

---

## 8. Queue System

### Decision
Mount Bull queue, initialize after Redis connects. Fallback to synchronous if unavailable.

### Queues
| Queue | Purpose | Processor |
|-------|---------|-----------|
| `message-processing` | Forward messages to n8n | `outbound.service.ts` |
| `webhook-delivery` | Retry failed webhook deliveries | `n8n/retry.service.ts` |
| `file-processing` | Virus scan + thumbnail generation | `file-handling/*` |
| `notifications` | Send email/push notifications | Notification service |

### Fallback behavior
If Bull queue fails to initialize (Redis connection issues):
- Process messages synchronously inline
- Log warning: "Queue unavailable, falling back to synchronous processing"
- Do not crash the server

### Redis connection resilience
The current `config/redis.ts` creates 3 Redis clients at module import time. If Redis is unavailable, the server crashes before starting. Add:
- Lazy initialization: don't create clients until `initializeRedis()` is called
- Retry logic: attempt reconnection with backoff (ioredis already has `retryStrategy`, but the initial connection needs a wrapper)
- If Redis is completely unavailable after retries, start in degraded mode (no pub/sub, no queue, Socket.io runs without Redis adapter — single-instance only)

---

## 9. Logger

### Decision
Use Layer 1's `utils/logger.ts` as the base. Add daily rotation for production.

### Changes
- Keep simple console transport for development
- Add daily file rotation in production (from Layer 2's `config/logger.ts` pattern)
- Log format: JSON in production, colorized in development
- Export: `logger`, `morganStream`

### Deleted
- `config/logger.ts`

---

## 10. New `server.ts` Structure

```typescript
// 1. Imports
import 'reflect-metadata';
import express from 'express';
import { createServer } from 'http';

// 2. Config
import { config } from './config/environment';

// 3. Database & Redis init
import { initializeDatabase } from './database/data-source';
import { initializeRedis } from './config/redis';

// 4. Security middleware (in order)
// helmet → CSP → XSS → CORS → body parsing → rate limiting

// 5. Routes (all under /api/v1)
// auth, chats, handoffs, agents, tenants, widget, files, analytics, notifications, n8n

// 6. WebSocket init
import { initializeSocketIO } from './websocket/socket.handler';

// 7. Queue init (after Redis)
import { initializeQueue } from './queue/message-queue';

// 8. Error handler (last middleware)

// 9. Health check at /health

// 10. Start server
// 11. Graceful shutdown handlers
```

### Boot sequence
1. Load and validate environment config
2. Initialize database connection (TypeORM)
3. Initialize Redis connections (3 clients: pub, sub, general)
4. Initialize Bull queue (depends on Redis)
5. Mount security middleware
6. Mount routes
7. Mount error handler
8. Create HTTP server
9. Initialize Socket.io on HTTP server
10. Start listening on `PORT`
11. Register SIGTERM/SIGINT handlers

---

## 11. Dockerfile Fixes

### `infra/Dockerfile` changes
| Line | Current | Fix |
|------|---------|-----|
| Stage 1 | `COPY prisma ./prisma/` | Remove |
| Stage 1 | `RUN npx prisma generate` | Remove |
| Stage 2 | `COPY --from=deps /app/prisma ./prisma` | Remove |
| Stage 3 | `COPY --from=builder --chown=nodejs:nodejs /app/prisma ./prisma` | Remove |
| Stage 3 | `COPY --chown=nodejs:nodejs .env.production ./` | Remove |
| Stage 3 | `CMD ["node", "dist/main.js"]` | `CMD ["node", "dist/server.js"]` |

### New `portal/Dockerfile`
```dockerfile
# Stage 1: Build
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
ARG VITE_API_URL
ARG VITE_WS_URL
RUN npm run build

# Stage 2: Serve
FROM nginx:alpine
COPY --from=builder /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
```

### New `portal/nginx.conf`
- Serve static files from `/usr/share/nginx/html`
- SPA fallback: all routes → `index.html`
- Gzip compression
- Cache static assets (js/css/images)

---

## 12. Railway Configuration

### `railway.toml` update
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

### Railway project structure
```
Railway Project
├── api service
│   ├── Source: chatbot-platform/api (with infra/Dockerfile)
│   ├── PostgreSQL plugin → DATABASE_URL auto-injected
│   └── Redis plugin → REDIS_URL auto-injected
├── portal service
│   ├── Source: chatbot-platform/portal (with portal/Dockerfile)
│   └── Build args: VITE_API_URL, VITE_WS_URL
└── (optional) n8n service
    ├── Docker image: n8nio/n8n:latest
    └── Shares PostgreSQL via DATABASE_URL
```

### Environment variables

**API — auto-provided by Railway:**
- `DATABASE_URL`
- `REDIS_URL`
- `PORT`

**API — set manually:**
| Variable | How to generate |
|----------|----------------|
| `NODE_ENV` | `production` |
| `API_URL` | Your Railway API URL |
| `JWT_SECRET` | `openssl rand -base64 32` |
| `JWT_REFRESH_SECRET` | `openssl rand -base64 32` |
| `ENCRYPTION_KEY` | `openssl rand -base64 32` |
| `WIDGET_API_KEY` | `openssl rand -base64 24` |
| `CORS_ORIGIN` | Your portal Railway URL |
| `AWS_ACCESS_KEY_ID` | From AWS IAM |
| `AWS_SECRET_ACCESS_KEY` | From AWS IAM |
| `AWS_REGION` | e.g. `eu-west-1` |
| `AWS_S3_BUCKET` | Your S3 bucket name |

**API — optional:**
| Variable | If missing |
|----------|-----------|
| `CLAMAV_HOST` + `CLAMAV_PORT` | Virus scanning skipped |
| `N8N_WEBHOOK_URL` | Message forwarding disabled |
| `CDN_URL` | Files served via S3 signed URLs |
| `SMTP_HOST` + credentials | Email notifications disabled |

**Portal — build-time:**
| Variable | Value |
|----------|-------|
| `VITE_API_URL` | `https://<api-service>.up.railway.app/api/v1` |
| `VITE_WS_URL` | `https://<api-service>.up.railway.app` |

---

## 13. Files to Delete

| File | Reason |
|------|--------|
| `config/env.ts` | Replaced by `environment.ts` |
| `config/database.ts` | Replaced by `database/data-source.ts` |
| `config/logger.ts` | Consolidated into `utils/logger.ts` |
| `models/` (all 5 files) | Replaced by `database/entities/` |
| `auth/jwt.ts` | Merged into consolidated auth middleware |
| `auth/api-key.ts` | Merged into consolidated auth middleware |
| `auth/index.ts` | No longer needed |
| `middleware/auth.ts` | Duplicate of `auth.middleware.ts` |
| `routes/health.ts` | Health check inline in server.ts |
| `routes/sessions.ts` | Folded into chat routes |
| `routes/messages.ts` | Folded into chat routes |
| `websocket/socket-server.ts` | Duplicate of `socket.handler.ts` |

---

## 14. Files to Create

| File | Purpose |
|------|---------|
| `routes/agents.routes.ts` | Agent CRUD, status, performance, shifts |
| `routes/users.routes.ts` | User profile, preferences, password change |
| `routes/files.routes.ts` | Upload, preview, download |
| `routes/analytics.routes.ts` | Dashboard metrics, export |
| `routes/notifications.routes.ts` | Notification list, mark read |
| `services/metrics.service.ts` | Stub for n8n module dependency — request counting, latency tracking |
| `utils/validation.ts` | Stub for n8n module dependency — input validation helpers |
| `portal/Dockerfile` | Multi-stage build for React SPA |
| `portal/nginx.conf` | SPA serving config |

---

## 15. Files to Modify

### Config layer
| File | Changes |
|------|---------|
| `config/environment.ts` | Add DATABASE_URL, REDIS_URL, WIDGET_API_KEY, API_URL, N8N_WEBHOOK_URL, all S3/AWS vars |
| `config/s3.config.ts` | Update import from `./env` to `./environment` |
| `config/redis.ts` | Add REDIS_URL parsing, lazy initialization, retry logic |
| `database/data-source.ts` | Use environment.ts config, DATABASE_URL via `pg-connection-string` |

### Server
| File | Changes |
|------|---------|
| `server.ts` | Complete rewrite — new boot sequence, mount all routes/middleware under `/api/v1` |

### Import rewrites (deleting `config/env.ts`, `config/database.ts`, `models/`, `config/logger.ts`)
These files import from deleted modules and must be updated:

| File | Import changes |
|------|---------------|
| `middleware/auth.middleware.ts` | `../config/env` → `../config/environment`; `../models/Agent` → `../database/entities/Agent` |
| `middleware/tenant.middleware.ts` | `../config/database` → `../database/data-source`; `../models/Tenant` → `../database/entities/Tenant` |
| `middleware/rate-limit.middleware.ts` | `../config/env` → `../config/environment` |
| `routes/auth.routes.ts` | `../config/env` → `../config/environment`; `../config/database` → `../database/data-source`; `../models/*` → `../database/entities/*` |
| `routes/chat.routes.ts` | `../config/database` → `../database/data-source`; `../models/*` → `../database/entities/*` |
| `routes/handsoff.routes.ts` | `../config/database` → `../database/data-source`; `../models/*` → `../database/entities/*` |
| `websocket/socket.handler.ts` | `../config/env` → `../config/environment`; `../config/database` → `../database/data-source`; `../models/*` → `../database/entities/*` |
| `middleware/error-handler.ts` | `../config/logger` → `../utils/logger` |
| `middleware/rate-limit.ts` | `../config/logger` → `../utils/logger` |
| `routes/tenants.ts` | `../config/logger` → `../utils/logger` |
| `routes/widget.ts` | `../config/logger` → `../utils/logger` |
| `utils/encryption.ts` | `../config/logger` → `../utils/logger` |
| `queue/message-queue.ts` | `../config/logger` → `../utils/logger` |

### Feature wiring
| File | Changes |
|------|---------|
| `websocket/socket.handler.ts` | Add dual auth, portal events, n8n response emission |
| `websocket/index.ts` | Fix barrel exports to match actual functions |
| `middleware/auth.middleware.ts` | Merge in refresh rotation and issuer/audience from jwt.ts |
| `routes/auth.routes.ts` | Rename `/agent` to `/login`; add 2FA (verify, setup, disable), refresh (no JWT required), /me |
| `routes/chat.routes.ts` | Add transfer, close, history, mark-read |
| `routes/handsoff.routes.ts` | Add accept, decline, queue endpoints |
| `n8n/webhook.controller.ts` | Import from database/entities instead of models |
| `n8n/outbound.service.ts` | Connect to socket handler for real-time delivery |
| `file-handling/virus-scan.service.ts` | Make ClamAV optional |
| `queue/message-queue.ts` | Add fallback to sync processing |
| `utils/logger.ts` | Add daily rotation for production |

### Deployment
| File | Changes |
|------|---------|
| `infra/Dockerfile` | Remove Prisma refs, fix CMD to `dist/server.js`, remove .env.production copy, keep vips/ffmpeg |
| `railway.toml` | Fix config, single replica |
| `package.json` | Add missing deps, update migration scripts path |

---

## 16. Missing npm Dependencies

These packages are used by orphaned code but not in `package.json`. Must be added before the code will compile:

| Package | Used by | Add to |
|---------|---------|--------|
| `bull` + `@types/bull` | `queue/message-queue.ts` | dependencies + devDependencies |
| `sharp` | `file-handling/thumbnail.service.ts` | dependencies |
| `@aws-sdk/client-s3` | `config/s3.config.ts`, `file-handling/upload.service.ts` | dependencies |
| `@aws-sdk/s3-request-presigner` | `file-handling/upload.service.ts` | dependencies |
| `bcryptjs` + `@types/bcryptjs` | `routes/auth.routes.ts` | dependencies + devDependencies |
| `axios` | `n8n/outbound.service.ts` | dependencies |
| `pg-connection-string` | `database/data-source.ts` (new) | dependencies |

### package.json script fix
Update migration scripts from:
```json
"migration:run": "npm run typeorm migration:run -- -d src/config/database.ts"
```
To:
```json
"migration:run": "npm run typeorm migration:run -- -d src/database/data-source.ts"
```

---

## 17. Risk Areas

| Risk | Severity | Mitigation |
|------|----------|------------|
| **Entity method incompatibility** — Layer 1 routes call methods (`.touch()`, `.toJSON()`, `.recordLogin()`) that may not exist on Layer 2 entities | High | Method-level audit during implementation. Add missing methods to Layer 2 entities or rewrite route logic. |
| **N8N module missing deps** — imports `metrics.service` and `validation` which don't exist | High | Create stub implementations before attempting to compile. |
| **Redis crash at import** — clients created at module load time, crash if Redis unavailable | Medium | Refactor to lazy init. Railway Redis may not be ready at container start. |
| **New route files scope** — 5 new route files are non-trivial CRUD with auth/pagination | Medium | Consider stub endpoints (return 501) for first deploy, implement fully in phase 2. |
| **TypeScript path aliases** — tsconfig uses `@/*` path aliases that may not resolve in production build | Medium | Verify `tsc` output resolves aliases, or add `tsconfig-paths` to production. |
| **DATABASE_URL password encoding** — Railway passwords may contain special chars | Low | Use `pg-connection-string` instead of `new URL()`. |
