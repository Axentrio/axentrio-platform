# Webhook Integration — Design Spec

**Date:** 2026-03-26
**Status:** Approved
**Approach:** C — Generic Webhook System (not branded to n8n)

## Overview

Wire up the existing n8n module as a generic "Webhook Integration" system. Full bidirectional message flow between the chatbot platform and any automation tool (n8n, Make, Zapier, custom HTTP). Includes a delivery log for observability and a portal UI for configuration, testing, and debugging.

## Context

### What exists

- Complete n8n module at `api/src/n8n/` with 8+ files: webhook controller, outbound service, circuit breaker (5-failure threshold), retry service (Bull/Redis, 3x exponential backoff), fallback service, JSON schemas, types
- `message-forwarding.service.ts` bridges socket events → n8n outbound (used by WebSocket handler)
- Per-tenant `webhookUrl` and `webhookSecret` columns on `Tenant` entity
- 5 example n8n workflow JSON files in `docs/n8n-workflows/`
- Routes for inbound webhook, health, circuit status, queue status, retry, register/unregister

### What's broken/missing

- `createN8nModule()` is **never called** in `server.ts` — none of the endpoints are reachable
- `initializeForwarding()` is never called — outbound messages don't flow
- `register`/`unregister`/`registered` endpoints are stubs (hardcoded responses, no DB)
- No delivery log entity — no audit trail for webhook deliveries
- No portal UI for managing the integration (webhook URL is a basic field in Settings)
- All naming references "n8n" — should be generic "webhook"

## Infrastructure

- Self-hosted n8n on Railway (same infrastructure as API and Portal)
- Single webhook URL per tenant (multi-webhook deferred to future)

---

## Section 1: Boot & Wiring

### server.ts boot sequence

After DB and Redis init, call `createWebhookModule()` (renamed from `createN8nModule()`) with config from environment variables. Mount the router at `/api/v1/webhooks`.

The inbound endpoint needs `express.raw()` for signature verification, registered **before** `express.json()` — same pattern as the Clerk webhook.

### initializeForwarding()

Called right after `createWebhookModule()`, passing the outbound and fallback services. This connects the socket handler's message flow to the outbound pipeline. `message-forwarding.service.ts` uses module-level singletons — we keep that pattern since it already matches how the socket handler works.

### Route paths (renamed)

| Endpoint | Method | Description | Auth |
|----------|--------|-------------|------|
| `/api/v1/webhooks/inbound` | POST | Receive messages from automation tools | Webhook secret |
| `/api/v1/webhooks/health` | GET | Integration health check | Public |
| `/api/v1/webhooks/circuit-status` | GET | Circuit breaker state | Admin |
| `/api/v1/webhooks/circuit-reset` | POST | Manual circuit breaker reset | Admin |
| `/api/v1/webhooks/queue-status` | GET | Retry queue state | Admin |

### Stubs to remove

- `POST /register` — not backed by DB
- `DELETE /unregister/:webhookId` — stub
- `GET /registered` — returns empty array

These come back when multi-webhook support is needed.

---

## Section 2: Delivery Log

### WebhookDeliveryLog entity

New TypeORM entity + migration:

| Column | Type | Description |
|--------|------|-------------|
| `id` | uuid (PK) | |
| `tenantId` | uuid (FK → Tenant) | Which tenant this delivery belongs to |
| `event` | varchar | Event name: `message.received`, `session.started`, etc. |
| `direction` | enum(`inbound`, `outbound`) | Direction of the webhook call |
| `url` | varchar | The webhook URL that was called |
| `status` | enum(`success`, `failed`, `retrying`, `dropped`) | Delivery outcome |
| `httpStatus` | int, nullable | HTTP response code (200, 500, timeout) |
| `durationMs` | int | Request duration in milliseconds |
| `error` | text, nullable | Error message if failed |
| `requestBody` | jsonb, nullable | Truncated payload (first 2KB) for debugging |
| `createdAt` | timestamp | When the delivery was attempted |

### Logging strategy

- The outbound service writes a log entry after every delivery attempt (success or failure)
- Cap storage at **500 entries per tenant** using rolling delete on insert
- No retention policy UI — automatic pruning only

### API endpoint

`GET /api/v1/tenants/me/webhooks/deliveries?page=1&limit=20` — paginated delivery logs for the current tenant. Uses existing pagination helper.

### Retry handling

If a message retries 3 times, that's 3 rows in the delivery log (one per attempt), each with its own status. Simple, no joins needed.

---

## Section 3: Outbound Flow (Platform → Automation Tool)

### Message flow

```
Visitor sends message (widget/socket)
  → socket.handler receives it
  → message-forwarding.service.ts builds the outbound payload
  → OutboundService.sendMessage()
    → Circuit breaker check (is automation tool reachable?)
      → YES: HTTP POST to tenant.webhookUrl with payload + context
        → Log delivery (success/fail) to WebhookDeliveryLog
        → If fail: queue for retry via RetryService (Bull/Redis)
      → NO (circuit open): FallbackService returns a fallback message
        → "I'm having trouble connecting. Let me get a human to help."
        → Optionally triggers handoff
```

### What needs to happen

1. `initializeForwarding(outboundService, fallbackService)` called during boot
2. Outbound service already builds rich context (user info, session history, tenant metadata) — keep as-is
3. After each delivery attempt, write to `WebhookDeliveryLog`
4. Payload follows existing `OutboundMessage` schema — no changes

### Outbound payload shape

```json
{
  "event": "message.received",
  "sessionId": "uuid",
  "tenantId": "uuid",
  "payload": {
    "type": "text",
    "content": "Hello, I need help with my order"
  },
  "context": {
    "user": { "anonymousId": "...", "metadata": {} },
    "session": { "startedAt": "...", "messageCount": 3 },
    "history": [{ "role": "user", "content": "..." }]
  },
  "timestamp": "2026-03-26T..."
}
```

---

## Section 4: Inbound Flow (Automation Tool → Platform)

### Message flow

```
Automation tool sends HTTP POST to /api/v1/webhooks/inbound
  → Validate JSON schema (action, sessionId, payload)
  → Verify per-tenant webhook secret (X-Webhook-Secret header)
  → Route by action type:
    → message.send     → Save message to DB, emit via Socket.io to visitor
    → typing.start     → Emit typing indicator to visitor
    → typing.stop      → Stop typing indicator
    → handoff.trigger  → Create handoff request, notify agents
    → handoff.release  → Release session back to bot
    → session.clear    → Clear session history
    → session.transfer → Transfer to different agent
  → Log delivery to WebhookDeliveryLog (direction: 'inbound')
  → Return success/error response
```

### Changes from current code

1. Route path: `/api/v1/n8n/webhook/inbound` → `/api/v1/webhooks/inbound`
2. Raw body parsing: `express.raw()` registered before `express.json()` for HMAC verification
3. Delivery logging: write to `WebhookDeliveryLog` for every inbound request
4. Actions `message.edit`, `message.delete`, `file.request`, `user.update` stay in the schema but return "not yet implemented" if service method isn't ready

### Security model (unchanged)

- Per-tenant secret lookup via `tenantId` in request body
- Timing-safe comparison against `Tenant.webhookSecret`
- Dev mode: warn and allow if no secret configured
- Production: reject if no secret configured

---

## Section 5: Portal UI — Integrations Tab in Settings

Add a new "Integrations" tab to the existing Settings page.

### 5a. Connection Configuration

- **Webhook URL** field (relocate from General tab)
- **Webhook Secret** display (masked, with copy button — relocate from General tab)
- **Regenerate Secret** button (already exists)
- **Save** button

### 5b. Connection Health

Status card at the top:

| Element | Source |
|---------|--------|
| Status indicator (green/yellow/red dot) | Green = last delivery succeeded. Yellow = circuit half-open. Red = circuit open or last delivery failed. |
| Circuit breaker state | `GET /api/v1/webhooks/circuit-status` — CLOSED/OPEN/HALF_OPEN |
| Last successful delivery | From delivery log — timestamp + duration |
| Test Webhook button | `POST /api/v1/tenants/me/webhooks/test` — sends test ping, shows result inline |

### 5c. Delivery Log Table

| Column | Content |
|--------|---------|
| Time | Relative timestamp ("2 min ago") |
| Direction | Inbound / Outbound badge |
| Event | `message.received`, `session.started`, etc. |
| Status | Success (green) / Failed (red) / Retrying (yellow) badge |
| HTTP Status | 200, 500, timeout, etc. |
| Duration | e.g. "120ms" |
| Error | Truncated error message, expandable on click |

Uses existing `Pagination` component. Default 20 per page.

### New API endpoints for portal

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/v1/tenants/me/webhooks/status` | GET | Health + circuit breaker state |
| `/api/v1/tenants/me/webhooks/deliveries` | GET | Paginated delivery log |
| `/api/v1/tenants/me/webhooks/test` | POST | Send test webhook ping |

Webhook URL/secret save and regenerate already exist on `/tenants/me`.

---

## Section 6: Naming Rename & Cleanup

### What gets renamed

| Current | New |
|---------|-----|
| Route path `/api/v1/n8n/webhook/*` | `/api/v1/webhooks/*` |
| `N8nModuleConfig`, `N8nModule`, `createN8nModule` | `WebhookModuleConfig`, `WebhookModule`, `createWebhookModule` |
| `n8n_webhook_success` metric names | `webhook_delivery_success` |
| Portal UI labels | "Webhook Integration" (not "n8n") |
| `docs/n8n-integration.md` | `docs/webhook-integration.md` |
| `N8N_WEBHOOK_URL` env var | `WEBHOOK_URL` (with `N8N_WEBHOOK_URL` as fallback alias) |

### What stays the same

- `api/src/n8n/` folder path — internal organization, tenants never see it
- Service class names (`WebhookService`, `OutboundService`, `CircuitBreaker`) — already generic
- `message-forwarding.service.ts` — already generically named
- `docs/n8n-workflows/` example files — they are literally n8n-specific content

### Stubs to remove

- `POST /register`
- `DELETE /unregister/:webhookId`
- `GET /registered`

---

## Error Handling

- **Outbound failures:** Circuit breaker opens after 5 consecutive failures. Fallback service sends a graceful message to the visitor and optionally triggers handoff. Failed messages queue for retry (3x, exponential backoff).
- **Inbound validation failures:** Return 400 with details. Log to delivery log with `failed` status.
- **Secret verification failures:** Return 401. Log to delivery log.
- **Circuit open:** Return fallback response. No outbound attempts until circuit half-opens after 30s timeout.

## Testing

- Unit tests for delivery log writes (mock DB)
- Integration tests for inbound endpoint (schema validation, secret verification)
- Integration test for the test webhook endpoint
- Manual E2E: configure n8n webhook URL in portal Settings → send message in widget → verify n8n receives it → n8n sends reply → verify visitor sees it

## Future (Not In Scope)

- Multi-webhook registrations per tenant (WebhookRegistration entity)
- Per-event subscriptions (subscribe to only `message.received`, not all events)
- Webhook delivery retry UI (manual retry from portal)
- Webhook request/response inspector (full payload viewer)
