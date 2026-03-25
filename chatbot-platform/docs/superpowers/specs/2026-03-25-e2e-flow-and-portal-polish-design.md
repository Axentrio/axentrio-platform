# HandsOff E2E Flow & Portal Polish — Design Spec

**Goal:** Wire the existing UI and API into a working end-to-end flow: visitor chats via widget → n8n AI processes → handoff to human agent in portal. Fix portal scaffolding along the way.

**Architecture:** Self-service SaaS model. Clerk orgs = tenants. n8n is the pluggable AI layer — system works without it (human-first queue). Each tenant configures their own n8n webhook URL.

**Tech Stack:** Existing — Express, TypeORM, Socket.io, React 18, Clerk, PostgreSQL, Redis.

---

## 1. End-to-End Message Flow

### Flow Diagram

```
Visitor (widget) → API → n8n webhook (AI) → API → Visitor
                                ↓ (handoff triggered)
                          Agent sees in Portal → Agent replies → Visitor
```

### Detailed Steps

1. **Visitor opens widget** → `POST /api/v1/auth/widget` with tenant API key → gets session token + session ID.
2. **Visitor connects WebSocket** → API key mode auth (see Security section below) → joins session room.
3. **Visitor sends message** → saved to DB → if tenant has `webhookUrl` configured AND session status is `bot` or `waiting`, forward to n8n via `OutboundService`.
4. **n8n processes** → calls AI, runs logic → sends response back via `POST /api/v1/n8n/webhook/inbound` (existing global endpoint, `tenantId` in request body).
5. **API delivers response** → saved to DB → broadcast to session room via WebSocket.
6. **n8n triggers handoff** → sends `handsoff.trigger` action → session status changes to `handoff` → appears in agent Queue → agents notified via WebSocket.
7. **Agent accepts handoff** → joins session room → messages go directly between agent and visitor via WebSocket (bypassing n8n).
8. **No n8n configured** → session stays `waiting` → appears in agent Queue immediately → human-first support.
9. **n8n down** → message forwarding logic catches the error, sends a fallback message to visitor ("We're connecting you to an agent"), transitions session to `handoff` status. The `FallbackService` provides the message content; the forwarding logic in the WebSocket handler/route performs the status transition and DB save.

### Session Status State Machine

**Current DB enum:** `'active' | 'closed' | 'waiting' | 'handoff'`

**Migration required:** Add `'bot'` to the `SessionStatus` enum. The existing `'handoff'` status maps to what the system needs for handoff requests. No rename needed.

```
waiting → bot           (n8n configured, on first forwarded message)
waiting → handoff       (no n8n configured, queue for human immediately)
waiting → closed        (visitor abandons before anyone picks up)
bot → handoff           (n8n triggers handoff)
bot → waiting           (n8n down, fallback — re-queue for human)
bot → closed            (visitor closes while talking to bot)
handoff → active        (agent accepts)
handoff → waiting       (agent rejects, re-queue)
handoff → closed        (visitor closes while waiting for agent)
active → closed         (agent or visitor closes)
active → handoff        (agent returns session to queue / transfers)
```

**Migration steps:**
1. Add `'bot'` to the `SessionStatus` type and the `@Column` enum array in `ChatSession.ts`
2. Since DB_SYNC is enabled, TypeORM will auto-apply the enum change
3. Update `analytics.routes.ts` queries that filter by status to include `'bot'` where relevant
4. The existing `ChatSession.requestHandoff()` method sets `status = 'handoff'` — this stays as-is

### Message Forwarding Logic (New)

In the WebSocket `message:send` handler and the HTTP `POST /chat/:sessionId/message` route, after saving the message to DB:

```typescript
if (session.status === 'bot' || session.status === 'waiting') {
  const tenant = await tenantRepo.findOne({ where: { id: session.tenantId } });

  if (tenant?.webhookUrl) {
    // Build WebhookConfig from tenant
    const webhookConfig: WebhookConfig = {
      id: tenant.id,
      url: tenant.webhookUrl,
      secret: tenant.webhookSecret || '',
      name: tenant.name,
      active: true,
      timeout: 30000,
      retryPolicy: { maxRetries: 3, backoffMs: 1000 },
      headers: {},
    };

    try {
      await outboundService.sendToWebhook(webhookConfig, outboundPayload);

      // Transition waiting → bot atomically
      if (session.status === 'waiting') {
        await sessionRepo
          .createQueryBuilder()
          .update(ChatSession)
          .set({ status: 'bot' })
          .where('id = :id AND status = :status', { id: session.id, status: 'waiting' })
          .execute();
      }
    } catch (error) {
      // n8n is down — send fallback message, transition to handoff
      const fallback = fallbackService.getFallbackResponse('connection_error');
      // Save fallback message to DB and broadcast to visitor
      // Transition session to 'handoff' so agents can pick it up
      await sessionRepo.update(session.id, { status: 'handoff' });
    }
  }
  // If no webhookUrl, message stays in DB, session stays 'waiting'
  // Agent picks it up from Queue
}
// If session.status === 'active', message goes to agent via WebSocket only (no n8n)
```

**Note:** The `waiting → bot` transition uses an atomic `UPDATE ... WHERE status = 'waiting'` to prevent race conditions when multiple messages arrive simultaneously.

### What Exists vs What's New

**Exists:**
- `OutboundService` — sends to webhook URL with context enrichment, circuit breaker, retry. Expects `WebhookConfig` object (not a tenant entity directly).
- `WebhookController` — receives n8n responses at `POST /api/v1/n8n/webhook/inbound`, handles 10+ action types
- `WebhookService` — processes incoming actions, broadcasts via WebSocket
- `FallbackService` — builds fallback response payloads (does NOT do DB operations or status transitions)
- WebSocket dual-auth, room management, message persistence
- Widget auth endpoint, session creation
- Handoff request/accept/reject/complete lifecycle

**New to build:**
- Add `'bot'` to `SessionStatus` enum in `ChatSession.ts`
- Message forwarding decision logic (in WebSocket handler + chat routes)
- `WebhookConfig` factory: helper function `buildWebhookConfig(tenant: Tenant): WebhookConfig` to bridge tenant entity to `OutboundService` interface
- Session status transition from `waiting` → `bot` on first n8n-forwarded message (atomic update)
- Fallback handler: on n8n failure, save fallback message + transition to `handoff` (in forwarding logic, not FallbackService)
- Update `OutboundService.getPreviousMessages()` to query `MessageRepository` for last 10 messages (currently returns `[]`)
- Update `WebhookService` (n8n) to use repositories directly instead of calling stub services (`ChatSessionService.getSession()` → `sessionRepo.findOne()`, `MessageService.createMessage()` → `messageRepo.save()`, `HandoffService.requestHandoff()` → `handoffRepo.save()`)

---

## 2. Tenant Settings — Integration Tab

### UI Design

New "Integration" tab in the existing Settings page. Sections:

**API Key:**
- Masked display: `sk_live_****...****a3f2`
- Copy button
- Rotate button (with confirmation modal) — calls existing `POST /api/v1/tenants/me/api-key/rotate`

**n8n Webhook URL:**
- Text input field
- Save button → `PATCH /api/v1/tenants/me` with `{ webhookUrl }`
- Test Connection button → `POST /api/v1/tenants/me/webhook-test`
- Status indicator: green checkmark (connected), red X (failed), gray (not configured)

**Inbound Webhook Endpoint (read-only):**
- Displays: `{API_URL}/api/v1/n8n/webhook/inbound`
- Copy button
- Helper text: "Configure your n8n workflow to send responses to this URL. Include your tenant ID in the request body."

**Webhook Secret:**
- New field on Tenant entity: `webhookSecret` (varchar, nullable)
- Auto-generated on first save (crypto.randomBytes(32).toString('hex'))
- Masked display with copy + regenerate buttons
- Used by n8n to sign requests, verified by `WebhookController`

### New Endpoints

**`POST /api/v1/tenants/me/webhook-test`**
- If `webhookUrl` is not configured, return `{ success: false, error: 'No webhook URL configured' }`
- Validates URL format before sending
- Sends a test payload to `tenant.webhookUrl`
- Expects a 200 response within 5 seconds
- Returns `{ success: true, responseTimeMs }` or `{ success: false, error }`

### Per-Tenant Webhook Secret Verification

**Current state:** `WebhookController` uses a single global `config.secret` for HMAC verification.

**Change required:** The inbound webhook endpoint needs to:
1. Parse the request body to extract `tenantId`
2. Look up the tenant from DB to get `tenant.webhookSecret`
3. Verify the request signature against the tenant's secret
4. If no `webhookSecret` is set on the tenant, skip verification (for easy initial setup)

This changes the flow from "verify then parse" to "parse then verify." The `WebhookController.verifySignature()` method needs to accept the secret as a parameter instead of using `this.config.secret`.

### Entity Changes

**Tenant entity** — add:
```typescript
@Column({ type: 'varchar', length: 255, nullable: true, name: 'webhook_secret' })
webhookSecret?: string;
```

### What Exists vs What's New

**Exists:**
- Tenant CRUD endpoints, `webhookUrl` field, API key rotate
- Settings page UI shell
- `OutboundService` with HMAC signing

**New to build:**
- Integration tab UI component in portal Settings page
- Webhook test endpoint (`POST /tenants/me/webhook-test`)
- `webhookSecret` column on Tenant entity
- Refactor `WebhookController` signature verification to per-tenant lookup
- Webhook secret regenerate endpoint (or add to existing `PATCH /tenants/me`)

---

## 3. Widget Test Page

### Purpose

Standalone page at `/widget-test` to validate the full e2e flow without building an embeddable `<script>` widget. Not behind Clerk auth — uses widget API key auth.

### UI

- Full-page chat interface (mobile-friendly, centered max-width container)
- URL: `/widget-test?apiKey={tenant-api-key}`
- Components:
  - Header: "HandsOff Chat" + connection status dot
  - Message list: visitor messages right-aligned, bot/agent messages left-aligned
  - Typing indicator
  - Text input + send button
  - Session status indicator (bot / waiting for agent / connected to agent)

### Technical Implementation — Routing Architecture

The current `App.tsx` has `BrowserRouter` inside `<SignedIn>`, so the widget-test page cannot use it. The fix:

```tsx
<ClerkProvider ...>
  <QueryClientProvider client={queryClient}>
    {/* Widget test page — outside auth entirely */}
    <WidgetTestRouter />

    <SignedOut>
      <SignIn ... />
    </SignedOut>

    <SignedIn>
      <TokenProviderSetup>
        <OrganizationRequired>
          <BrowserRouter>
            {/* ... existing routes ... */}
          </BrowserRouter>
        </OrganizationRequired>
      </TokenProviderSetup>
    </SignedIn>
  </QueryClientProvider>
</ClerkProvider>
```

`WidgetTestRouter` is a small component that checks `window.location.pathname === '/widget-test'` and renders the widget test page with its own `BrowserRouter` instance. When the path doesn't match, it renders nothing, so the normal Clerk flow takes over.

### Widget Test Page Flow

On load:
1. Read `apiKey` from URL params
2. `POST /api/v1/auth/widget` with `{ apiKey }` → get token + sessionId + tenantId
3. Connect WebSocket with `{ query: { apiKey, visitorId: generated-uuid, tenantId: from-auth-response } }`
4. Listen for `message:received`, `typing:indicator`, `handoff:accept`
5. Send messages via `message:send` WebSocket event

### WebSocket Widget Auth — Security Fix

**Current problem:** The WebSocket widget auth mode at `socket.handler.ts` trusts `tenantId` from the query string without verifying it against the API key. An attacker could pass any `tenantId`.

**Fix:** In the WebSocket widget auth middleware, validate the API key against the tenant:
```typescript
if (socket.handshake.query?.apiKey) {
  const tenant = await getTenantByApiKey(socket.handshake.query.apiKey as string);
  if (!tenant) return next(new Error('Invalid API key'));

  socket.data.user = {
    id: (socket.handshake.query.visitorId as string) || socket.id,
    email: '',
    role: 'visitor',
    tenantId: tenant.id,  // Use verified tenant ID, not client-supplied
    type: 'widget' as const,
  };
  socket.data.tenantId = tenant.id;
  return next();
}
```

### Bot Welcome Message

On session creation, if tenant has `webhookUrl` configured, the message forwarding logic sends an initial `session.start` event to n8n using the existing `OutboundService`. This is an outbound event (platform → n8n) using the same `sendToWebhook` method with a special event type. n8n can respond with a welcome message. If no n8n, show a client-side default: "You're in the queue, an agent will be with you shortly."

### What Exists vs What's New

**Exists:**
- Widget auth endpoint (`POST /auth/widget`)
- WebSocket API key auth mode (needs security fix)
- Message send/receive events
- All backend plumbing

**New to build:**
- `WidgetTest.tsx` page component
- `WidgetTestRouter` wrapper for routing outside auth
- WebSocket widget auth security fix (validate API key → tenant)
- Session start event to n8n (optional, uses existing outbound service)

---

## 4. Portal Polish — Wire Mock Data to Real APIs

### Dashboard Page

**Current:** Hardcoded `mockMetrics` object with fake numbers.

**API response reality check:** `GET /api/v1/analytics/dashboard` returns:
- `sessions.total`, `sessions.active`, `sessions.waiting`, `sessions.handoff`
- `agents.total`, `agents.online`
- `avgResponseTimeSeconds`

**Does NOT return:** `csatScore`, `botResolutionRate`, `avgWaitTime` (which the mock data includes).

**Fix:**
- Wire the endpoint for metrics it does return (active chats, pending handoffs, online agents, avg response time)
- For missing metrics (`csatScore`, `botResolutionRate`): either add new aggregate queries to the dashboard endpoint, or remove these cards from the UI for now. Recommendation: add simple queries — `AVG(satisfaction_rating)` from chat_sessions, and count sessions that closed without handoff for bot resolution rate.
- Add loading states.

### Analytics Page

**Current:** All chart data hardcoded (7 days of fake chat volume, response times, agent performance).

**API response reality check:** `GET /api/v1/analytics/chats` returns aggregate counts only (`total`, `closed`, `open`, `avgDurationSeconds`). It does NOT return daily time-series data or bot/human/handoff breakdowns.

**Fix — new endpoint needed:** `GET /api/v1/analytics/chats/timeseries?startDate=...&endDate=...&groupBy=day`
- Returns: `[{ date: '2026-03-20', bot: 45, human: 12, handoff: 8 }, ...]`
- Groups sessions by day and status
- This is a new query, not a wire-up of an existing endpoint

**Agent performance:** `GET /api/v1/analytics/agents` returns agent data with performance metrics — this can be wired directly.

**Fix summary:**
- Add `GET /api/v1/analytics/chats/timeseries` endpoint with daily grouping
- Wire agent performance table to `GET /api/v1/analytics/agents`
- Wire date range picker to refetch
- Add loading skeletons for charts

### ChatTakeover Agent Transfer Modal

**Current:** Hardcoded `mockAgents` array with fake agent data.

**Fix:** Call `GET /api/v1/agents?status=online` to fetch real available agents. The endpoint already supports filtering.

### Service Layer Cleanup

**Current:** `ChatSessionService`, `MessageService`, `HandoffService` are stubs returning null/fake IDs. Routes bypass them and use repositories directly.

**Fix:**
- Delete the three stub service files
- Update `WebhookService` (n8n) to use repositories directly. Specific replacements:
  - `this.chatSessionService.getSession(sessionId)` → `this.sessionRepo.findOne({ where: { id: sessionId } })`
  - `this.messageService.createMessage(data)` → `this.messageRepo.create(data)` + `this.messageRepo.save(message)`
  - `this.handoffService.requestHandoff(data)` → `this.handoffRepo.create(data)` + `this.handoffRepo.save(handoff)`
  - `this.chatSessionService.clearSessionContext(id)` → remove (no-op, not needed)
  - `this.chatSessionService.transferSession(id, opts)` → `this.sessionRepo.update(id, { assignedAgentId: opts.agentId })`
- `UserService` is also injected into `WebhookService` — check if it's a stub or real. If stub, replace similarly.
- Remove the deleted service imports from any barrel exports (`services/index.ts` if it exists)

### What Exists vs What's New

**Exists:**
- Most API endpoints with real DB queries
- Portal pages with UI layout
- Service files (to be deleted)

**New to build:**
- `GET /api/v1/analytics/chats/timeseries` endpoint (new query for daily chart data)
- Add `csatScore` and `botResolutionRate` queries to dashboard endpoint
- API calls in Dashboard, Analytics, ChatTakeover pages
- Loading states and error handling
- WebhookService refactor to use repositories

---

## 5. Out of Scope (Future Phases)

- Embeddable `<script>` widget for production use
- Billing / plan tiers
- Widget visual customization (colors, logo, position)
- Analytics export (CSV/JSON)
- Agent shift scheduling
- Satisfaction rating collection UI
- Multi-language support
- Custom Clerk roles (`org:supervisor`)
