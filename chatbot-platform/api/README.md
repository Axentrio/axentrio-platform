# Chatbot Platform API

Core API Server with WebSocket Gateway for the Chatbot Platform.

## Features

- **Express.js** RESTful API
- **Socket.io** with Redis Adapter for multi-server scaling
- **PostgreSQL** database with TypeORM
- **JWT Authentication** for agents and widget sessions
- **Rate Limiting** per IP and tenant
- **Real-time messaging** with room-based architecture
- **Human handoff** system

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      API Server (Port 3000)                  │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐  │
│  │   Express   │  │  Socket.io  │  │   Redis Adapter     │  │
│  │   Routes    │  │   Handler   │  │   (Pub/Sub)         │  │
│  └─────────────┘  └─────────────┘  └─────────────────────┘  │
│           │              │                    │              │
│           └──────────────┴────────────────────┘              │
│                          │                                   │
│  ┌───────────────────────┴──────────────────────────────┐   │
│  │              Middleware Layer                         │   │
│  │  • JWT Auth  • Tenant Validation  • Rate Limiting    │   │
│  └───────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
                              │
        ┌─────────────────────┼─────────────────────┐
        ▼                     ▼                     ▼
   ┌─────────┐          ┌─────────┐          ┌─────────┐
   │PostgreSQL│          │  Redis  │          │  Client │
   │         │          │         │          │         │
   │• Tenants│          │• Adapter│          │• Widget │
   │• Sessions│         │• Rate   │          │• Agent  │
   │• Messages│         │  Limit  │          │  Portal │
   │• Agents │          │• Sessions│         │         │
   └─────────┘          └─────────┘          └─────────┘
```

## Quick Start

### Prerequisites

- Node.js 18+
- PostgreSQL 14+
- Redis 6+

### Installation

```bash
# Install dependencies
npm install

# Setup environment
cp .env.example .env
# Edit .env with your configuration

# Run database migrations
npm run migration:run

# Start development server
npm run dev

# Build for production
npm run build
npm start
```

## Environment Variables

### Core

| Variable | Description | Default |
|----------|-------------|---------|
| `NODE_ENV` | Environment mode | `development` |
| `PORT` | Server port | `3000` |
| `DB_HOST` | PostgreSQL host | `localhost` |
| `DB_PORT` | PostgreSQL port | `5432` |
| `DB_USERNAME` | PostgreSQL username | `postgres` |
| `DB_PASSWORD` | PostgreSQL password | `postgres` |
| `DB_DATABASE` | PostgreSQL database | `chatbot_platform` |
| `REDIS_HOST` | Redis host | `localhost` |
| `REDIS_PORT` | Redis port | `6379` |
| `JWT_SECRET` | JWT signing secret | Required |
| `JWT_EXPIRES_IN` | JWT expiration | `24h` |

### Billing (Stripe)

The four Stripe variables are **required outside of `NODE_ENV=test`** — the server fails fast on boot if any of them is missing or empty. See _Billing invariants_ below.

| Variable | Description | Default |
|----------|-------------|---------|
| `STRIPE_SECRET_KEY` | Stripe secret key (`sk_test_…` for dev, `sk_live_…` for prod) | Required |
| `STRIPE_WEBHOOK_SECRET` | Signing secret for the `/api/v1/webhooks/billing/stripe` endpoint (`whsec_…`) | Required |
| `STRIPE_PRICE_PRO_USD_MONTHLY` | Recurring Price ID for the Pro plan ($49/mo USD) | Required |
| `STRIPE_PRICE_PREMIUM_USD_MONTHLY` | Recurring Price ID for the Premium plan ($199/mo USD) | Required |
| `BILLING_TRIAL_DAYS` | Reverse-trial length for new tenants (`trialing-pro` for N days, then auto-downgrade to free) | `7` |
| `LLM_DAILY_LIMIT_PER_TENANT` | Fallback daily LLM-call cap when entitlements lookup fails | `5000` |

#### Local Stripe webhook setup

```bash
stripe login
stripe listen --forward-to localhost:4081/api/v1/webhooks/billing/stripe
# Copy the printed `whsec_…` into STRIPE_WEBHOOK_SECRET and restart the API.
```

Keep `stripe listen` running while you exercise checkout flows — the webhook is what actually updates local billing state after Stripe processes the subscription.

### Billing invariants

Two non-obvious wiring rules that the billing layer depends on:

1. **Raw-body middleware ordering.** The Stripe webhook handler verifies an HMAC signature over the raw request body. `server.ts` mounts the webhook router with `express.raw({ type: 'application/json' })` **before** any global `express.json()` middleware:

   ```ts
   app.use(
     '/api/v1/webhooks/billing',
     express.raw({ type: 'application/json' }),
     billingWebhookRoutes,
   );
   ```

   The handler receives `req.body` as a `Buffer` and passes it directly to `provider.verifyWebhook` — it must **not** be JSON-parsed. Re-ordering the middleware or registering an extra body-parser on `/webhooks/billing/*` will break signature verification.

2. **Boot-time fail-fast on missing Stripe config.** `src/config/environment.ts` validates the four Stripe variables on import and calls `process.exit(1)` if any is empty (outside `NODE_ENV=test`). This is by design — running with placeholder keys would silently break checkout, webhooks, and customer-portal flows. To run the API without real Stripe credentials (CI smoke tests, etc.), set `NODE_ENV=test`.

## Response Envelope Convention

Every portal-facing JSON endpoint emits one of two shapes. Handlers don't write `res.json(...)` directly — they call a helper from `utils/response.ts` or `throw` a typed error from `middleware/error-handler.ts`. The global `errorHandler` does the rest.

### Success

```ts
import { sendSuccess, sendCreated, sendPaginated, sendNoContent } from '@/utils/response';

sendSuccess(res, { agent });                                   // 200  { success, data }
sendCreated(res, { agent });                                   //  201
sendPaginated(res, items, { page, limit, total, totalPages }); // 200  { success, data, meta:{pagination} }
sendNoContent(res);                                            // 204  empty body
```

Convention rules:
- `sendSuccess(res, null)` is legal only for documented null-as-empty-state endpoints (e.g. `getAiSettings` when AI isn't configured). Confirm portal callers tolerate `null` before using.
- `sendSuccess(res, undefined)` is forbidden — the portal interceptor unwraps to `undefined`, breaking caller destructuring. For handlers with no payload use `sendSuccess(res, { message: '...' })`.
- Status preservation: 200 → `sendSuccess`, 201 → `sendCreated`, 204 → `sendNoContent`, paginated → `sendPaginated`.

### Errors

```ts
import {
  BadRequestError,
  UnauthorizedError,
  ForbiddenError,
  NotFoundError,
  ConflictError,
  ValidationError,
  RateLimitError,
  ApiError,
} from '@/middleware/error-handler';
import { ERROR_CODES } from '@/middleware/error-codes';

throw new BadRequestError('Tenant ID required');
throw new NotFoundError('Widget not found');
throw new RateLimitError('Too many requests', { retryAfter: 30 });

// Custom code? `UnauthorizedError`/`ForbiddenError`/`NotFoundError`
// constructors DO NOT accept details — use `ApiError`:
throw new ApiError('Organization suspended', 403, ERROR_CODES.TENANT_SUSPENDED);
throw new ApiError('Failed to send invite via Clerk', 502, ERROR_CODES.CLERK_UPSTREAM_FAILED);
```

Async handlers must be wrapped in `asyncHandler` so thrown errors propagate. `asyncHandler` also converts a `ZodError` from `schema.parse(...)` into a `ValidationError` with the flattened issues in `error.details.fieldErrors` — bad input lands as `422 / VALIDATION_ERROR`, not 500.

Every error response carries:

```jsonc
{
  "success": false,
  "error": { "code": "NOT_FOUND", "message": "...", "details": {…} },
  "meta": { "timestamp": "…", "requestId": "req_…", "path": "/api/v1/…" }
}
```

The `requestId` makes Sentry / log correlation a one-step lookup for support.

### Out-of-scope endpoints (preserve legacy shapes)

These intentionally do NOT emit the envelope — provider-integration contracts or browser flows:
- Webhook receivers: `webhooks/billing-webhook.routes.ts`, `channels/meta/webhook.routes.ts`, `channels/channel-webhook.routes.ts`, n8n inbound + `/events`.
- OAuth callback redirects: `channels/meta/oauth.routes.ts` `res.redirect(...?error=...)`.
- `server.ts /health` Railway probe.
- The unmounted `file-handling/upload.controller.ts` (Phase 5C cleanup-only).

Rate-limit and timeout middlewares carry a `req.originalUrl` carve-out so 429/503 responses on the above paths keep their legacy body shape — the carve-out is body-shape only, not bypass.

### Guardrail

A grep-based pre-commit / CI check lives at:
```bash
chatbot-platform/api/scripts/check-envelope-conventions.sh
```
It bans `res.json({ error })`, `res.json({ success: true })`, and `res.status(N).json({ literal })` outside the allow-list. For legitimate carve-outs add an inline marker on the emit line:
```ts
res.status(429).json({ /* ... */ }); // envelope-allow: OOS legacy 429 (plan §10)
```

See [ADR 0011](../../docs/adr/0011-api-response-envelope.md) and [the migration plan](../docs/api-response-standardization-plan.md) for the full audit + the 6-round codex review that produced the contract.

## API Endpoints

### Authentication

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/auth/widget` | Authenticate widget (API key) |
| POST | `/auth/agent` | Authenticate agent (email/password) |
| POST | `/auth/refresh` | Refresh JWT token |
| POST | `/auth/logout` | Logout agent |
| GET | `/auth/verify` | Verify token validity |

### Chat

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/chat/:sessionId/history` | Get message history |
| POST | `/chat/:sessionId/message` | Send message (HTTP) |
| GET | `/chat/:sessionId/status` | Get session status |
| POST | `/chat/:sessionId/close` | Close session |
| GET | `/chat/sessions` | List sessions (agent) |

### Handoff

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/handoff/request` | Request human handoff |
| POST | `/handoff/accept` | Accept handoff (agent) |
| POST | `/handoff/reject` | Reject handoff (agent) |
| POST | `/handoff/return` | Return to bot (agent) |
| GET | `/handoff/pending` | List pending requests |

### Billing

All routes gated to `User.role IN ('admin', 'super_admin')`. Stripe-targeting actions return HTTP 400 with `{ error: { code: 'no_stripe_subscription' } }` for tenants on manual billing (free / trial / Enterprise).

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET    | `/billing/state` | Current plan, status, period, pending change, last 20 billing events |
| POST   | `/billing/checkout-session` | Start Stripe Checkout for `{ planId: 'pro' \| 'premium' }` |
| POST   | `/billing/portal-session` | Open Stripe Customer Portal (manage payment method) |
| POST   | `/billing/change-plan` | Upgrade / downgrade — webhook applies the change |
| POST   | `/billing/cancel` | Cancel at period end |
| POST   | `/billing/undo-cancel` | Reverse a scheduled cancellation |
| POST   | `/billing/undo-pending-change` | Release a pending downgrade schedule |
| PUT    | `/billing/email` | Update billing email (propagates to Stripe customer) |
| POST   | `/webhooks/billing/:provider` | Stripe webhook entry point (signature-verified; raw body) |

### Admin (super-admin only)

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST   | `/admin/tenants/:id/set-tier` | Manual tier override — body `{ tier: 'free' \| 'pro' \| 'premium' \| 'enterprise' }`. Audits + writes a `tier.manual_override` billing event |
| POST   | `/admin/tenants/:id/set-enterprise` | Legacy Enterprise-specific path (wraps `set-tier`) |
| GET    | `/admin/tenants/:id/api-key/reveal` | Return unmasked API key. Audited per reveal |
| POST   | `/admin/tenants/:id/api-key/rotate` | Generate a new API key |

### Health

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/health` | Health check |

## WebSocket Events

### Client → Server

| Event | Data | Description |
|-------|------|-------------|
| `session:join` | `{ sessionId }` | Join a session room |
| `session:leave` | `{ sessionId }` | Leave a session room |
| `message:send` | `{ sessionId, content, type }` | Send a message |
| `message:read` | `{ messageId }` | Mark message as read |
| `typing:indicator` | `{ sessionId, isTyping }` | Send typing indicator |
| `handoff:request` | `{ sessionId, reason }` | Request handoff |
| `handoff:accept` | `{ sessionId }` | Accept handoff |
| `handoff:reject` | `{ sessionId }` | Reject handoff |
| `presence:update` | `{ status }` | Update presence |

### Server → Client

| Event | Data | Description |
|-------|------|-------------|
| `connection:ack` | `{ socketId, timestamp }` | Connection acknowledged |
| `session:joined` | `{ sessionId, roomName, status }` | Successfully joined |
| `message:receive` | Message object | New message received |
| `message:read` | `{ messageId, readAt }` | Message marked read |
| `typing:indicator` | `{ sessionId, isTyping, senderType }` | Typing status |
| `handoff:requested` | `{ sessionId, reason }` | Handoff requested |
| `handoff:accepted` | `{ sessionId, agent }` | Handoff accepted |
| `handoff:pending` | `{ sessionId, status }` | Handoff pending |
| `handoff:assigned` | `{ sessionId, agentId }` | Handoff assigned |
| `agent:online` | `{ agentId }` | Agent came online |
| `agent:offline` | `{ agentId }` | Agent went offline |
| `agent:status` | `{ agentId, status }` | Agent status changed |

## Room Format

- Session rooms: `${tenantId}:${sessionId}`
- Tenant agent pool: `agents:${tenantId}`
- Agent-specific: `agent:${agentId}`

## License

MIT
