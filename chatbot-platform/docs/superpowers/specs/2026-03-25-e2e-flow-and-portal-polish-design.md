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
2. **Visitor connects WebSocket** → API key mode auth → joins session room.
3. **Visitor sends message** → saved to DB → if tenant has `webhookUrl` configured AND session status is `bot` or `waiting`, forward to n8n via `OutboundService`.
4. **n8n processes** → calls AI, runs logic → sends response back via `POST /api/v1/n8n/webhook/:tenantId`.
5. **API delivers response** → saved to DB → broadcast to session room via WebSocket.
6. **n8n triggers handoff** → sends `handsoff.trigger` action → session status changes to `handoff_requested` → appears in agent Queue → agents notified via WebSocket.
7. **Agent accepts handoff** → joins session room → messages go directly between agent and visitor via WebSocket (bypassing n8n).
8. **No n8n configured** → session stays `waiting` → appears in agent Queue immediately → human-first support.
9. **n8n down** → `FallbackService` sends a canned response to visitor ("We're connecting you to an agent") → session transitions to `handoff_requested`.

### Session Status State Machine

```
waiting → bot (if n8n configured, on first message)
bot → handoff_requested (n8n triggers handoff)
bot → waiting (n8n down, fallback)
waiting → handoff_requested (no n8n, immediate queue)
handoff_requested → active (agent accepts)
handoff_requested → waiting (agent rejects, re-queue)
active → closed (agent or visitor closes)
```

### Message Forwarding Logic (New)

In the WebSocket `message:send` handler and the HTTP `POST /chat/:sessionId/message` route, after saving the message to DB:

```
if (session.status === 'bot' || session.status === 'waiting') {
  if (tenant.webhookUrl) {
    // Forward to n8n
    outboundService.sendMessage(tenant, session, message);
    if (session.status === 'waiting') {
      session.status = 'bot';
      await sessionRepo.save(session);
    }
  }
  // If no webhookUrl, message stays in DB, session stays 'waiting'
  // Agent picks it up from Queue
}
// If session.status === 'active', message goes to agent via WebSocket only (no n8n)
```

### What Exists vs What's New

**Exists:**
- `OutboundService` — sends to webhook URL with context enrichment, circuit breaker, retry
- `WebhookController` — receives n8n responses, handles 10+ action types
- `WebhookService` — processes incoming actions, broadcasts via WebSocket
- `FallbackService` — sends fallback responses when n8n is down
- WebSocket dual-auth, room management, message persistence
- Widget auth endpoint, session creation
- Handoff request/accept/reject/complete lifecycle

**New to build:**
- Message forwarding decision logic (in WebSocket handler + chat routes)
- Session status transition from `waiting` → `bot` on first n8n-forwarded message
- Update `OutboundService.getPreviousMessages()` to actually fetch from DB (currently returns `[]`)
- Update stubbed services (`WebhookService` uses `ChatSessionService`/`MessageService` which are stubs) → use repositories directly

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
- Displays: `{API_URL}/api/v1/n8n/webhook/{tenantId}`
- Copy button
- Helper text: "Configure your n8n workflow to send responses to this URL"

**Webhook Secret:**
- New field on Tenant entity: `webhookSecret` (varchar, nullable)
- Auto-generated on first save (crypto.randomBytes(32).toString('hex'))
- Masked display with copy + regenerate buttons
- Used by n8n to sign requests, verified by `WebhookController`

### New Endpoints

**`POST /api/v1/tenants/me/webhook-test`**
- Sends a test payload to `tenant.webhookUrl`
- Expects a 200 response within 5 seconds
- Returns `{ success: true, responseTimeMs }` or `{ success: false, error }`

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
- Integration tab UI component
- Webhook test endpoint
- `webhookSecret` column on Tenant
- Wire HMAC verification in `WebhookController` to use `tenant.webhookSecret`

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

### Technical Implementation

- New React page: `portal/src/pages/WidgetTest.tsx`
- **Not wrapped in ClerkProvider auth** — this page lives outside `<SignedIn>`. Add route before the `<SignedIn>` block in App.tsx.
- On load:
  1. Read `apiKey` from URL params
  2. `POST /api/v1/auth/widget` with `{ apiKey }` → get token + sessionId
  3. Connect WebSocket with `{ query: { apiKey, visitorId, tenantId } }`
  4. Listen for `message:received`, `typing:indicator`, `handoff:accept`
  5. Send messages via `message:send` WebSocket event

### Bot Welcome Message

On session creation, if tenant has `webhookUrl` configured, the API sends an initial event to n8n with action `session.start`. n8n can respond with a welcome message ("Hi! What can I help you with today?"). If no n8n, show a default "You're in the queue, an agent will be with you shortly."

### What Exists vs What's New

**Exists:**
- Widget auth endpoint
- WebSocket API key auth mode
- Message send/receive events
- All the backend plumbing

**New to build:**
- `WidgetTest.tsx` page component
- Route in App.tsx (outside SignedIn)
- Session start notification to n8n (optional — n8n can also just wait for first message)

---

## 4. Portal Polish — Wire Mock Data to Real APIs

### Dashboard Page

**Current:** Hardcoded `mockMetrics` object with fake numbers.

**Fix:** Call `GET /api/v1/analytics/dashboard` on mount. This endpoint already runs real aggregate queries:
- Total/active/closed/waiting sessions
- Active agent count
- Average duration and satisfaction

Replace the mock values with API response data. Add loading states.

### Analytics Page

**Current:** All chart data hardcoded (7 days of fake chat volume, response times, agent performance).

**Fix:**
- Chat volume chart → `GET /api/v1/analytics/chats?startDate=...&endDate=...`
- Agent performance table → `GET /api/v1/analytics/agents`
- Wire date range picker to refetch data
- Add loading skeletons for charts

### ChatTakeover Agent Transfer Modal

**Current:** Hardcoded `mockAgents` array with fake agent data.

**Fix:** Call `GET /api/v1/agents?status=online` to fetch real available agents. The endpoint already supports filtering by status.

### Service Layer Cleanup

**Current:** `ChatSessionService`, `MessageService`, `HandoffService` are stubs returning null/fake IDs. Routes bypass them and use repositories directly.

**Fix:**
- Delete the three stub service files
- Update `WebhookService` (n8n) to use repositories directly instead of calling the stub services
- This aligns the n8n code path with the route code path — both use repositories

### What Exists vs What's New

**Exists:**
- All API endpoints with real DB queries
- Portal pages with UI layout
- Service files (to be deleted)

**New to build:**
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
- Satisfaction rating collection
- Multi-language support
- Custom Clerk roles (`org:supervisor`)
