# Agent Flow & n8n Integration Analysis

**Date:** 2026-04-03
**Scope:** Full agent flow trace, n8n integration, MCP config, multi-tenancy gaps

---

## 1. Complete Agent Flow (Message Lifecycle)

```
User sends message (widget / Telegram / Messenger / Instagram)
    │
    ├─ Widget: POST /api/v1/chats/:sessionId/message  OR  Socket.IO event
    ├─ Telegram: POST /api/v1/channels/telegram/webhook
    └─ Meta: POST /api/v1/channels/meta/webhook
    │
    ▼
┌─────────────────────────────────────┐
│  Inbound Pipeline                    │
│  - Deduplication                     │
│  - Message type normalization        │
│  - Content encryption                │
│  - Session/Participant lookup        │
│  - DB save (Message entity)          │
│  - WebSocket broadcast to portal     │
└──────────────┬──────────────────────┘
               │
               ▼
┌─────────────────────────────────────┐
│  forwardMessageToN8n()               │
│  message-forwarding.service.ts       │
│                                      │
│  Guard: session.status must be       │
│         'bot' or 'waiting'           │
│                                      │
│  1. Load tenant from DB              │
│  2. Resolve webhook URL:             │
│     tenant.webhookUrl (non-localhost) │
│     → config.n8n.defaultWebhookUrl   │
│     → null (no forwarding)           │
│  3. Pre-forwarding checks:           │
│     - Business hours check           │
│     - Escalation keyword detection   │
│  4. Build enriched outbound payload  │
│  5. Send to n8n via OutboundService  │
└──────────────┬──────────────────────┘
               │
    ┌──────────┼──────────────┐
    │          │              │
    ▼          ▼              ▼
 SUCCESS    FAILURE        FAILURE
 (n8n OK)  (n8n down)    (circuit open)
    │          │              │
    │          ▼              ▼
    │    RAG Fallback    FallbackService
    │    (if KB exists)  (canned message)
    │          │              │
    │          ▼              ▼
    │    generateResponse()  Handoff trigger
    │    (rag.service.ts)
    │          │
    └────┬─────┘
         │
         ▼
┌─────────────────────────────────────┐
│  n8n Workflow Processing             │
│  (chatbot-platform-v2-brain)         │
│                                      │
│  Webhook Trigger                     │
│  → Acknowledge (200 immediately)     │
│  → Extract Message (validate IDs)    │
│  → Valid Payload? gate               │
│  → Send Typing Start                 │
│  → Has Knowledge Base?               │
│  → KB Search (RAG endpoint)          │
│  → System Prompt Builder             │
│  → AI Response Generation            │
│  → Send Response Back to Platform    │
└──────────────┬──────────────────────┘
               │
               ▼
┌─────────────────────────────────────┐
│  POST /api/v1/webhooks/inbound       │
│  webhook.controller.ts               │
│                                      │
│  1. Schema validation                │
│  2. Per-tenant secret verification   │
│  3. Session state guard              │
│  4. Action routing (14 actions):     │
│     message.send, message.edit,      │
│     typing.start/stop,               │
│     handsoff.trigger/release, etc.   │
│  5. WebhookService processes action  │
│  6. routeOutboundMessage() delivers  │
│     to widget/Telegram/Meta          │
└─────────────────────────────────────┘
```

---

## 2. Identified Flaky Behaviors

### 2.1 GLOBAL Circuit Breaker (CRITICAL)

**File:** `api/src/n8n/circuit-breaker.ts`
**Problem:** There is ONE circuit breaker instance shared across ALL tenants.

If Tenant A's n8n webhook is misconfigured and fails 5 times, the circuit breaker opens **globally**, blocking ALL tenants from reaching n8n — even tenants with perfectly working webhooks.

**Impact:** One bad tenant can take down AI for all tenants.

**Fix:** Circuit breaker must be per-tenant or per-webhook-URL.

### 2.2 Acknowledge-Then-Process Pattern Creates Race Conditions

**File:** `chatbot-platform-v2-brain-no-cancel.json` (n8n workflow)

The workflow immediately returns `{"status": "received"}` via the Acknowledge node, then processes asynchronously. The platform's `OutboundService.sendToWebhook()` treats this 200 as "success" and records `circuitBreaker.recordSuccess()`.

**Problem:** The n8n workflow can fail AFTER acknowledging:
- AI generation fails (API key invalid, rate limited)
- KB search times out
- Send Response Back to Platform fails (platform unreachable)

The platform thinks delivery succeeded but the user never gets a response. No retry happens because the circuit breaker recorded success.

**Impact:** Silent message drops. User sends a message and gets nothing back.

### 2.3 Webhook URL Resolution is Fragile

**File:** `message-forwarding.service.ts:168-174`

```typescript
const tenantUrl = tenant.webhookUrl && !tenant.webhookUrl.includes('localhost')
  ? tenant.webhookUrl : undefined;
const webhookUrl = tenantUrl || (aiSettings?.enabled
  ? config.n8n.defaultWebhookUrl : undefined);
```

**Problems:**
1. `localhost` check is a string match — breaks for `http://localhost:5678` AND `https://my-n8n.localhost.run`
2. If `N8N_DEFAULT_WEBHOOK_URL` is set, ALL AI-enabled tenants without custom URLs share the same workflow
3. No validation that the webhook URL is actually reachable at startup
4. The fallback chain (`tenant URL → default URL → null`) means a misconfigured env var silently disables all AI

### 2.4 Retry Queue May Not Process After Circuit Recovery

**File:** `api/src/n8n/retry.service.ts`

When the circuit breaker opens, messages are queued in Redis. When the circuit transitions to HALF_OPEN, there's no drain mechanism to reprocess queued messages. They sit in Redis until:
- A new message comes in and triggers a retry attempt
- Or they expire

**Impact:** Messages queued during an outage may never be delivered.

### 2.5 Session Status Race Condition

**File:** `message-forwarding.service.ts:260-268`

```typescript
if (session.status === 'waiting') {
  await sessionRepository
    .createQueryBuilder()
    .update(ChatSession)
    .set({ status: 'bot' })
    .where('id = :id AND status = :status', { id: session.id, status: 'waiting' })
    .execute();
}
```

This uses optimistic locking (`AND status = :status`), which is good. But if a human agent picks up the session between the n8n send and this status update, the session flips back to 'bot', overriding the agent's claim. The WHERE clause prevents this, but the code doesn't check the `affected` count — it silently succeeds with 0 rows updated.

### 2.6 n8n Workflow Uses Global Secret, Not Per-Tenant

**File:** `chatbot-platform-v2-brain-no-cancel.json:99`

```json
"X-Webhook-Secret": "={{ $env.N8N_INBOUND_SECRET }}"
```

The n8n workflow sends back responses using a single `$env.N8N_INBOUND_SECRET` for ALL tenants. The platform's `verifyPerTenantSecret()` looks up the tenant's `webhookSecret`, but the n8n workflow doesn't know per-tenant secrets.

**Impact:** Either all tenants share one secret (no isolation), or you need one n8n workflow per tenant (doesn't scale).

---

## 3. Multi-Tenancy Analysis

### What Works

| Aspect | Status | How |
|--------|--------|-----|
| DB isolation | OK | All tables have `tenantId` FK + index |
| API isolation | OK | `validateTenant()` middleware on all routes |
| WebSocket isolation | OK | Rooms keyed by `tenant:${id}` |
| Widget auth | OK | Per-tenant `apiKey` lookup |
| Message encryption | OK | Per-message encryption with `decrypt()` |
| RAG isolation | OK | KB queries filtered by `tenantId` |
| Session quotas | Partial | `maxSessions` exists but NOT enforced in middleware |

### What's Broken for Multi-Tenancy

#### 3.1 Single n8n Workflow for All Tenants (CRITICAL)

The current architecture assumes ONE n8n workflow handles ALL tenants. The workflow receives `tenantConfig` in the payload and dynamically adjusts its system prompt per-request. This means:

- **No workflow isolation:** All tenants share the same AI processing pipeline
- **No per-tenant API keys in n8n:** The workflow uses whatever OpenAI/Anthropic key is configured in n8n, not the tenant's key
- **No per-tenant rate limits:** One tenant's traffic floods the same n8n execution queue
- **No per-tenant conversation memory in n8n:** n8n doesn't persist conversation state per tenant — it only gets the last 10 messages from the platform

**To support true multi-tenancy in n8n, you need one of:**
1. One n8n workflow per tenant (manual, doesn't scale)
2. n8n workflow that dynamically reads tenant config and uses tenant's API keys (possible but complex)
3. Move AI processing into the platform itself (bypass n8n for AI, use n8n only for integrations)

#### 3.2 Global Circuit Breaker (CRITICAL)

Already described in 2.1. One tenant's failures affect all tenants.

#### 3.3 Shared Default Webhook Secret

**File:** `knowledge.controller.ts:210-211`

When AI is enabled for a tenant without a custom webhook URL, the system auto-provisions using:
```typescript
tenant.webhookSecret = config.n8n.inboundSecret; // Same for ALL tenants
```

All auto-provisioned tenants share the same webhook secret. If one tenant's secret leaks, all tenants are compromised.

#### 3.4 No Tenant-Level Rate Limiting on Webhook Endpoints

**File:** `webhook.routes.ts`

Rate limiting is per-IP (100 req/min), not per-tenant. A single tenant could send unlimited webhook requests from different IPs, or multiple tenants behind a NAT would share the same rate limit.

#### 3.5 editMessage / deleteMessage Don't Verify Tenant Ownership

**File:** `webhook.service.ts:160-233`

`editMessage()` and `deleteMessage()` accept a `messageId` from the n8n payload and directly update/delete it. There's no check that the message belongs to the tenant making the request.

**Impact:** A malicious n8n workflow (or a compromised tenant webhook) could edit/delete messages from other tenants by guessing message UUIDs.

#### 3.6 transferSession Doesn't Verify Agent Belongs to Tenant

**File:** `webhook.service.ts:433-469`

`transferSession()` accepts a `target` agentId and directly updates the session. No check that the target agent belongs to the same tenant.

---

## 4. MCP Configuration

**Root `.mcp.json`:**
```json
{
  "mcpServers": {
    "shadcn": { "command": "npx", "args": ["shadcn@latest", "mcp"] },
    "codex": { "command": "codex", "args": ["mcp-server"] }
  }
}
```

**Portal `.mcp.json`:**
```json
{
  "mcpServers": {
    "shadcn": { "command": "npx", "args": ["shadcn@latest", "mcp"] }
  }
}
```

These MCP configs are for the **development environment** (Claude Code tooling) — not the chatbot agent. They provide component library access for the portal UI development. There is no MCP server configured for the chatbot agent's runtime.

---

## 5. n8n Workflow Architecture

### Available Workflows (8 total)

| Workflow | Trigger Path | Purpose |
|----------|-------------|---------|
| `chatbot-platform-v2-brain-no-cancel.json` | `/webhook/chatbot-platform` | **Production brain** - KB-aware AI responses |
| `chatbot-platform-v2-brain.json` | `/webhook/chatbot-platform` | Earlier version with cancellation logic |
| `ai-chatbot.json` | `/webhook/ai-chatbot-inbound` | Standalone AI chatbot (no platform integration) |
| `basic-chatbot.json` | Chat trigger | Simple echo bot |
| `lead-capture.json` | `/webhook/lead-capture-inbound` | Lead qualification and DB storage |
| `handsoff-escalation.json` | `/webhook/handoff-inbound` | Escalation detection and agent handoff |
| `file-handling.json` | `/webhook/file-handler-inbound` | File processing + ClamAV scanning |
| `chatbot-platform-integration.json` | Generic | Bidirectional platform integration |

### Production Brain Flow (v2-brain-no-cancel)

```
Webhook Trigger (POST /webhook/chatbot-platform)
    │
    ├─ Acknowledge (200 immediately)
    │
    ├─ Extract Message (JS Code node)
    │   - Validate sessionId + tenantId (UUID format)
    │   - Parse payload type (text/image/file/audio/video)
    │   - Extract tenantConfig (brandName, brandTone, systemPrompt)
    │   - Extract knowledgeBase config
    │   - Build tenantContext string
    │   - Truncate messages > 4000 chars
    │
    ├─ Valid Payload? (IF node)
    │   ├─ FALSE → Stop (skip invalid payloads)
    │   └─ TRUE ↓
    │
    ├─ Send Typing Start
    │   POST {API_URL}/api/v1/webhooks/inbound
    │   action: "typing.start"
    │
    ├─ Has Knowledge Base? (IF node)
    │   ├─ TRUE → KB Search
    │   │   POST {API_URL}/api/v1/internal/rag
    │   │   Returns relevant chunks
    │   └─ FALSE → Skip KB
    │
    ├─ System Prompt Builder (JS Code)
    │   - Builds system prompt from tenantConfig
    │   - Injects KB context if available
    │   - Applies guardrails
    │
    ├─ AI Response Generation
    │   - Uses OpenAI Chat node (GPT-4o-mini)
    │   - Conversation history from previousMessages
    │
    ├─ Session Update
    │
    └─ Send Response Back to Platform
        POST {API_URL}/api/v1/webhooks/inbound
        action: "message.send"
        X-Webhook-Secret: {N8N_INBOUND_SECRET}
```

### Key Problem: The workflow is monolithic

All tenants go through the same workflow nodes. The OpenAI key is set in the n8n node configuration, not from the tenant's AI settings. This means:
- All tenants use the **same OpenAI API key** (the one configured in n8n)
- Tenant's `ai.apiKey` stored in the platform DB is **never used** by n8n
- Brand voice and guardrails ARE passed dynamically (via system prompt), which works
- But model selection is hardcoded in the n8n OpenAI node

---

## 6. Prioritized Recommendations

### P0 — Must Fix (Flaky Behavior / Data Isolation)

| # | Issue | Fix |
|---|-------|-----|
| 1 | Global circuit breaker | Implement per-tenant circuit breaker map (Map<tenantId, CircuitBreaker>) |
| 2 | Acknowledge-then-process drops messages | Move to synchronous response (remove Acknowledge node) OR implement async callback verification |
| 3 | editMessage/deleteMessage no tenant check | Add `WHERE tenantId = :tenantId` to all message mutations |
| 4 | transferSession no tenant check | Verify target agent belongs to session's tenant |
| 5 | Shared webhook secret on auto-provision | Generate `crypto.randomBytes(32).toString('hex')` per tenant |

### P1 — Should Fix (Multi-Tenancy Architecture)

| # | Issue | Fix |
|---|-------|-----|
| 6 | All tenants share one n8n OpenAI key | Pass tenant's API key in payload; n8n workflow uses dynamic credentials |
| 7 | No per-tenant rate limiting | Add Redis-backed rate limiter keyed by tenantId |
| 8 | Queued messages not drained on circuit recovery | Add drain job on HALF_OPEN transition |
| 9 | Session quota not enforced | Add middleware check before session creation |
| 10 | localhost URL check too broad | Use `new URL()` parse + check hostname specifically |

### P2 — Nice to Have (Scalability)

| # | Issue | Fix |
|---|-------|-----|
| 11 | One workflow for all tenants | Consider moving AI processing into the platform (use n8n for integrations only) |
| 12 | No webhook URL health check on startup | Add optional connectivity test when tenant enables AI |
| 13 | Retry queue has no TTL | Add message expiry (e.g., 5 minutes) to prevent stale retries |
| 14 | No observability per tenant | Add tenant dimension to all metrics |

---

## 7. Architecture Decision: n8n's Role Going Forward

The current architecture uses n8n as the **AI brain** — it receives messages, calls OpenAI, and sends responses. This creates multi-tenancy friction because n8n doesn't natively support per-request credentials.

**Option A: Keep n8n as brain, add dynamic credentials**
- n8n workflow reads API key from platform payload
- Use n8n's Code node to make direct OpenAI API calls with tenant's key
- Pros: No platform code changes for AI logic
- Cons: Complex n8n workflow; debugging is in n8n UI, not code

**Option B: Move AI into platform, n8n for integrations only**
- Platform handles OpenAI/Anthropic calls directly (RAG service already does this)
- n8n handles: lead capture, file processing, CRM integration, escalation logic
- Pros: True multi-tenancy with per-tenant keys; testable code; simpler n8n workflows
- Cons: More platform code; loses n8n's visual workflow builder for AI logic

**Option C: Hybrid (recommended for current stage)**
- RAG fallback path already works without n8n
- Promote RAG path to primary for tenants with KB
- Use n8n only for tenants who need custom integration workflows
- Per-tenant flag: `aiProcessingMode: 'platform' | 'n8n'`

---

## 8. Council Verdict: n8n's Role Going Forward

**Unanimous recommendation: Option B — Move AI into the platform, scope n8n to integration workflows.**

### Reasoning

1. **The RAG path already exists and is superior.** `rag.service.ts` already handles per-tenant API keys, multi-provider (OpenAI + Anthropic), brand voice, guardrails, confidence-based handoff, and hybrid vector + keyword search. It runs as a fallback today — promoting it to primary is ~20 lines of reordering in `forwardMessageToN8n()`.

2. **n8n cannot use per-tenant API keys.** The workflow uses a single global OpenAI key configured in the n8n node. The encrypted `ai.apiKey` stored per tenant in the platform DB is only used by `provider-factory.ts` — which is the platform path.

3. **One fewer service to operate.** n8n on Railway is another process to scale, monitor, and keep alive. At 1-2 devs, operational simplicity wins.

4. **n8n remains valuable for integration workflows.** Cal.com booking, lead capture, CRM sync, file processing — these use n8n's visual workflow builder and external node ecosystem effectively.

### Migration Path

1. Make platform RAG path the **primary** AI path for AI-enabled tenants
2. Keep webhook forwarding for tenants with custom `webhookUrl` (integration use cases)
3. Remove `N8N_DEFAULT_WEBHOOK_URL` fallback for AI processing
4. Make circuit breaker per-tenant for remaining webhook use cases
5. Keep n8n workflows for: lead-capture, file-handling, handoff-escalation, booking

---

## 9. MCP for Agent Runtime (Not Currently Implemented)

The `.mcp.json` files are for development tooling, not the chatbot runtime. If you want MCP in the agent runtime (e.g., tool use during conversations), that would be a separate feature requiring:
- MCP client in the platform's AI processing pipeline
- Per-tenant MCP server configuration
- Tool approval/sandboxing per tenant
- This is a future concern, not a current gap
