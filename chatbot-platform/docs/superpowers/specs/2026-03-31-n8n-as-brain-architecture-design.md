# n8n-as-Brain Architecture — Design Spec

**Date:** 2026-03-31
**Status:** Draft
**Summary:** Restructure the AI pipeline so n8n is the orchestrator (brain) for all AI sessions, with the native RAG pipeline exposed as an internal search API that n8n calls when it needs knowledge base answers.

---

## Problem Statement

The current architecture has two parallel AI paths:
1. **Native RAG** — handles `bot` sessions directly (pgvector search → LLM → response)
2. **n8n forwarding** — handles `waiting` sessions or sessions where RAG is disabled

This creates three problems:
- **Maintenance burden:** Two AI systems to debug, tune, and keep in sync
- **Limited capability:** RAG can only answer from uploaded documents. Anything else (bookings, order lookups, general conversation, custom tenant flows) results in a low-confidence score → immediate human handoff
- **n8n overlap:** n8n already has AI agent nodes, but they're underused because RAG intercepts first

## Design Principle

**n8n is mandatory but invisible by default, customizable for power users.**

Most tenants enable AI, upload docs, and get answers — without ever knowing n8n exists. Power users can clone the default workflow and customize it.

---

## Architecture

### New Message Flow

```
Visitor sends message
    ↓
Platform saves message, broadcasts via WebSocket
    ↓
Session status = 'bot'?
    ↓ yes
Build outbound payload (message + tenant config + history + KB metadata)
    ↓
Forward to n8n webhook
    ↓
n8n default workflow:
    ├─ Has KB? → HTTP call to /api/v1/internal/rag/search → get chunks
    ├─ AI Agent node (LLM + KB chunks as context + brand voice from payload)
    ├─ Escalation detection
    └─ POST response back to /api/v1/n8n/webhook/inbound
    ↓
Platform delivers to visitor via WebSocket + channels
```

### Fallback Chain (n8n failure)

```
n8n available?
    → yes: n8n handles everything (default path)
    → no (circuit breaker open or request fails):
        → Text message AND tenant has KB?
            → yes: try native RAG directly (graceful degradation)
                → RAG succeeds: deliver response
                → RAG fails: fallback message + handoff to human
            → no (non-text or no KB): fallback message + handoff to human
```

### Session Status Handling

- **`bot` sessions:** Always forward to n8n (this is the core change).
- **`waiting` sessions:** Continue forwarding to n8n as before. First successful response transitions `waiting → bot` (existing behavior, unchanged).
- **`active`/`handoff`/`closed` sessions:** Not forwarded (existing behavior, unchanged).

### Automatic Webhook Provisioning

When a tenant enables AI (`settings.ai.enabled = true`), the platform automatically sets their `webhookUrl` to the default shared n8n workflow endpoint if not already configured. Tenants do not need to manually configure a webhook URL to use AI.

---

## Component Changes

### 1. message-forwarding.service.ts — Simplified routing

**Remove:** The RAG-first block (current lines 83-175). All `bot` sessions now go through n8n forwarding.

**Add:** RAG fallback on n8n failure. When outbound service fails or circuit breaker is open, attempt native RAG before handing off to human.

**New flow:**
```typescript
// Session status = 'bot' and message type = 'text'
// 1. Build enriched outbound payload (includes tenant AI config, KB metadata)
// 2. Forward to n8n via outbound service
// 3. If n8n fails:
//    a. If tenant has KB → call generateResponse() directly (graceful degradation)
//    b. If RAG also fails or no KB → fallback message + handoff
```

Business hours check and escalation keyword check remain in the platform (checked before forwarding to n8n), since these are cheap local checks that avoid unnecessary n8n calls.

### 2. New Internal RAG Search Endpoint

**Endpoint:** `POST /api/v1/internal/rag/search`

**Purpose:** Exposes the existing pgvector search as an API that n8n can call. Search only — no LLM call, no prompt construction, no confidence scoring. n8n's AI agent handles all of that.

**Request:**
```json
{
  "tenantId": "uuid",
  "query": "What is your return policy?",
  "maxChunks": 5
}
```

**Response:**
```json
{
  "chunks": [
    {
      "content": "Our return policy allows returns within 30 days...",
      "title": "Returns FAQ",
      "similarity": 0.87,
      "metadata": {}
    }
  ],
  "totalChunks": 3
}
```

**Auth:** Platform-level shared secret (not per-tenant webhook secrets). This is an internal API between the platform and its own n8n instance — a single `RAG_INTERNAL_SECRET` env var is sufficient. n8n sends this in the `Authorization: Bearer <secret>` header. Platform verifies before processing.

**Implementation:** Extract the vector search portion of `rag.service.ts` (current lines 105-120) into a standalone function. The query rewriting step (`rewriteQuery()`) stays — it's valuable for contextual follow-ups and cheap (gpt-4o-mini).

```typescript
// New function in rag.service.ts
export async function searchKnowledge(
  dataSource: DataSource,
  tenantId: string,
  query: string,
  conversationHistory: { role: 'user' | 'assistant'; content: string }[],
  maxChunks: number = 5
): Promise<{ chunks: RetrievedChunk[]; totalChunks: number }>
```

### 3. Outbound Payload Enrichment

The outbound payload already includes `tenantConfig` (brand name, tone, system prompt) and `context.previousMessages`. Add:

```typescript
// New fields in OutboundMessage
{
  // ... existing fields ...
  tenantConfig: {
    brandName: string;
    brandTone: string;
    systemPrompt: string;       // from tenant.settings.ai.brandVoice.customInstructions
    productInfo?: string;
    // NEW:
    guardrails: {
      topicsToAvoid: string[];
      confidenceThreshold: number;
      maxResponseLength: number;
      escalationKeywords: string[];
    };
  },
  knowledgeBase: {
    enabled: boolean;           // true if tenant has indexed documents
    documentCount: number;      // informational
  }
}
```

**Source of truth:** Platform DB owns brand voice, guardrails, and KB metadata. Passed in every outbound payload. n8n workflow reads these dynamically — never hardcodes them.

### 4. Conversation Memory — Platform Owns It

**Remove:** n8n Window Buffer Memory node from the workflow. It's redundant (platform already sends last 10 messages) and volatile (lost on n8n restart).

**Keep:** `context.previousMessages` in the outbound payload. n8n's AI Agent node uses this as conversation context. Platform DB is the source of truth.

### 5. Default n8n Workflow Template

Single shared workflow serving all tenants. Tenant-specific behavior driven by payload data.

**Workflow nodes:**

```
Webhook Trigger
    → Acknowledge (immediate 200)
    → Extract Message (validate + parse payload)
    → Valid Payload?
        → yes → Send Typing Start
            → Has Knowledge Base? (check payload.knowledgeBase.enabled)
                → yes → HTTP: POST /api/v1/internal/rag/search
                         (sends tenantId + query + HMAC signature)
                → no → skip
            → Build System Prompt (from payload.tenantConfig: brand voice + guardrails + KB chunks if any)
            → AI Agent (LLM call with system prompt + conversation history from payload)
            → Detect Escalation
            → Needs Escalation?
                → yes → Send Handoff + Send Message + Typing Stop
                → no → Send Message + Typing Stop
        → no → drop
```

**Key difference from current workflow:**
- Brand voice comes from payload, not hardcoded in AI Agent system prompt
- KB chunks injected into context (new node)
- No Window Buffer Memory — history from payload
- Guardrails (topics to avoid, max response length) come from payload

### 6. Webhook Timeout Fix

Current default timeout in outbound.service.ts is 5000ms. AI-bound calls need 30-45 seconds.

**Change:** When building webhook config for AI-enabled tenants, set timeout to 30000ms (already the value in `buildWebhookConfig()`, but `OutboundService` defaults override it to 5000ms when no explicit timeout is passed).

**Fix:** Pass `webhookConfig.timeout` explicitly in the `sendToWebhook()` call, or change the outbound service default for AI-bound calls.

### 7. Tenant Experience Tiers

| Tier | Experience | How it works |
|---|---|---|
| **Basic** | Dashboard: enable AI, upload docs, set brand voice | Shared default n8n workflow. Tenant never sees n8n. |
| **Power user** | Dashboard + "Customize AI workflow" | Clones default workflow, points their `webhookUrl` at the clone. Edits in n8n UI. |
| **Agency** | Full n8n access | Manages workflows across sub-tenants. |

**Auto-provisioning (Basic tier):** When tenant enables AI, their `webhookUrl` is set to the default shared workflow endpoint. No per-tenant workflow cloning needed.

**Power user upgrade:** Tenant clicks "Customize" → platform clones the workflow via n8n REST API → sets the tenant's `webhookUrl` to the new workflow's webhook URL. Their traffic now routes to their custom workflow, isolated from the shared one.

---

## What Stays The Same

- **pgvector, embeddings, document ingestion** — all stay. KB upload/indexing pipeline unchanged.
- **Inbound webhook processing** (webhook.service.ts) — already handles all action types from n8n. No changes needed.
- **Circuit breaker, retry queue, HMAC signatures** — all stay. Production-ready resilience.
- **WebhookDeliveryLog** — audit trail stays.
- **Tenant settings UI** — brand voice, guardrails, KB management all stay in the dashboard.

## What Gets Removed

- **RAG-first block in message-forwarding.service.ts** (lines 83-175) — replaced by n8n forwarding for all bot sessions, with RAG as fallback on n8n failure.
- **Direct LLM call in rag.service.ts** for normal flow — the `generateResponse()` function stays but is only used as fallback. The new `searchKnowledge()` function handles the n8n-callable search.
- **n8n Window Buffer Memory node** — platform sends history in payload.

## What Gets Added

- **`POST /api/v1/internal/rag/search`** — new endpoint exposing KB search to n8n.
- **KB metadata in outbound payload** — `knowledgeBase.enabled`, `searchEndpoint`, `documentCount`.
- **Guardrails in outbound payload** — topics to avoid, escalation keywords, thresholds.
- **RAG fallback path in message-forwarding** — try native RAG before handoff when n8n is down.
- **Updated default n8n workflow** — with KB fetch node, dynamic brand voice, no buffer memory.

---

## Security

- **RAG search endpoint:** Bearer token auth with platform-level `RAG_INTERNAL_SECRET`. Single secret for the internal n8n→platform API (not per-tenant).
- **Tenant isolation:** RAG search filters by `tenantId` (existing `WHERE kc.tenantId = $2`). n8n passes tenantId from the original outbound payload — never user-supplied.
- **No new external credentials exposed:** The RAG endpoint is internal infrastructure, not exposed to tenants or external systems.

## Out of Scope

These pre-existing issues are not addressed by this change but should be tracked separately:
- **Concurrent message race conditions:** Non-atomic `messageCount` increment, `waiting→bot` transition silently failing for second concurrent message, out-of-order processing in Bull queue.
- **Widget message deduplication:** No dedup for double-click sends (external channels have dedup via `dedupeKey`).
- **ConversationBinding duplicate creation:** No unique constraint prevents duplicate bindings for the same external user.

## Performance Considerations

- **Latency increase for KB questions:** ~200-500ms extra (HTTP call to RAG endpoint + n8n processing overhead). Acceptable tradeoff for architectural flexibility.
- **No latency increase for non-KB questions:** n8n skips RAG fetch when `knowledgeBase.enabled = false`.
- **Webhook timeout:** Must be 30s+ for AI-bound calls. Current 5s default is a bug.
- **Circuit breaker is global:** One shared breaker for the default workflow. Power users with custom workflows are isolated (different webhookUrl, different breaker would be needed if scaling demands it).

## Migration Path

1. Add RAG search endpoint (additive, no breaking changes)
2. Update outbound payload with KB metadata and guardrails (additive)
3. Update default n8n workflow with KB fetch node
4. Switch message-forwarding to always forward `bot` sessions to n8n
5. Add RAG fallback on n8n failure
6. Remove direct RAG call from normal message flow
7. Test with existing tenants — behavior should be identical

Steps 1-3 can ship independently. Steps 4-6 are the cutover (should be deployed together). Step 7 validates zero regression.
