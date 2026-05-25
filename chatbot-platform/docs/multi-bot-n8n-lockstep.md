# n8n workflow lockstep for multi-bot — #16e checklist

The Axentrio API has been multi-bot-aware since Phase 1; this doc tracks what
must change in the n8n workflows so the n8n side stays in lockstep. As long
as the workflow keeps reading tenant-scoped state, n8n's own RAG / response
paths will silently use stale (or tenant-wide) config even though the API
is sending the correct `botId` and KB scope.

## What the API now sends to n8n

`OutboundMessage` (see `chatbot-platform/api/src/n8n/types/message.types.ts`)
has carried `botId` on every outbound webhook since Phase 1:

```json
{
  "event": "message.received",
  "tenantId": "…",
  "botId": "…",          // ← the resolved bot for this session
  "sessionId": "…",
  "timestamp": "…",
  "payload": { "type": "text", "content": "…" },
  "tenantConfig": { … },  // resolved from bot.settings since #16d
  "knowledgeBase": { "enabled": …, "documentCount": … },
  "integrations": { "calcom": { … } },  // resolved from bot.settings since #16d
  "context": { "previousMessages": [ … ] }
}
```

Since #16d the `tenantConfig` and `integrations` blocks are populated from
`bot.settings`, not `tenant.settings`. So the OUTBOUND payload is already
honest about which bot's config the agent should use.

## What the API now accepts FROM n8n

The internal RAG search route at `POST /internal/rag/search` accepts an
optional `botId` body field (Phase 3):

```json
{
  "tenantId": "…",
  "botId": "…",          // ← optional; restricts retrieval to this bot's KBs
  "query": "…",
  "conversationHistory": [ … ],
  "maxChunks": 5
}
```

When `botId` is provided, the API resolves the bot's attached KnowledgeBases
(via `chatbot_bot_knowledge_bases`) and scopes RAG retrieval to them. When
omitted, retrieval falls back to tenant-wide (legacy behaviour).

## What the n8n workflow must change

### 1. Forward `botId` from inbound webhook → all downstream nodes

Wherever the workflow extracts `tenantId` from the inbound `message.received`
event, also extract `botId`. Thread it through every subsequent node that
hits the Axentrio API.

### 2. Pass `botId` to `POST /internal/rag/search`

The RAG search node currently builds a body like:

```json
{ "tenantId": "{{ $json.tenantId }}", "query": "{{ … }}" }
```

Add the `botId` field:

```json
{
  "tenantId": "{{ $json.tenantId }}",
  "botId":    "{{ $json.botId }}",
  "query":    "{{ … }}",
  "conversationHistory": [ … ],
  "maxChunks": 5
}
```

If the workflow doesn't pass `botId`, retrieval stays tenant-wide — the bot's
attached-KB scoping is silently bypassed. For the anchor bot this happens
to produce the same result as legacy behaviour (the anchor is attached to
the tenant's primary KB), but for non-anchor bots it returns the wrong KBs.

### 3. Honor the empty-list signal (`knowledgeBaseIds: []` → no retrieval)

The API distinguishes:
- `botId` omitted / `knowledgeBaseIds` undefined → tenant-wide retrieval
  (legacy)
- `botId` set, bot has KBs attached → restrict to those
- `botId` set, bot has zero KBs attached → return empty results, no
  tenant-wide fallback

The workflow must not "rescue" the third case with a tenant-wide call —
that defeats the bot's "answer from nothing" semantic. If the RAG node
returns no chunks, the workflow's response path should fall through to
its no-knowledge prompt template, not retry without `botId`.

### 4. Use the per-bot `tenantConfig` shape that arrives in the payload

If the workflow ever reads tenant-wide config from a separate API call
(e.g. a "fetch tenant settings" step at the start), drop that step in favour
of the `tenantConfig` block that arrives in `message.received`. Same for
`integrations.calcom`. The payload already has the resolved-per-bot view.

If the workflow ABSOLUTELY needs to call back to the API for config, use
the `botId` to identify which bot's config it wants. (Today there's no
public `GET /bots/:id/config` endpoint — file a request if the workflow
needs one, but most workflows shouldn't.)

### 5. Booking node: scope to the bot's Cal.com (which is now in the payload)

The booking node previously read Cal.com credentials from the tenant. Now
they live in `integrations.calcom` on the inbound payload (already
per-bot). The booking node just needs to consume `$json.integrations.calcom`
from the inbound event.

## Verification checklist

Run the workflow end-to-end against a multi-bot tenant (Pro tier on dev):

- [ ] Inbound `message.received` extraction node reads `botId` into the
      workflow's data shape.
- [ ] `POST /internal/rag/search` includes `botId` in the body.
- [ ] When a non-anchor bot has zero KBs attached, the workflow falls
      through to the no-knowledge response template (does NOT retry
      tenant-wide).
- [ ] `tenantConfig.brandName` matches the **bot's** brand voice, not the
      tenant default.
- [ ] `integrations.calcom.eventTypeId` matches the **bot's** Cal.com
      config (if the bot has one configured separately from the anchor).
- [ ] Outbound `message.send` calls back to the API include the same
      `sessionId` (the API can re-resolve the bot from the session itself
      via Phase 1's `chat_sessions.bot_id`).

## Failure mode if you skip this

A new non-anchor bot is created (when #16f Portal Bots UI ships) and the
tenant configures it with a separate brand voice + a separate KB. Customer
chats with that bot. n8n receives `message.received` with the new bot's
`botId` and `tenantConfig`, but its RAG node ignores `botId` and queries
tenant-wide → answers come from the anchor's KB, not this bot's. From
the customer's perspective the bot lies about what it knows.

The above failure is invisible until non-anchor bots ship via #16f. Phase 1
backfilled every existing tenant to one anchor bot, so all current traffic
is anchor-only and behaves correctly even without these workflow changes.
That makes this a SHIP-BEFORE-#16f gate, not a hot-fix.

## Linkbacks

- API outbound contract: `chatbot-platform/api/src/n8n/types/message.types.ts`
  → `OutboundMessage`
- API RAG search route: `chatbot-platform/api/src/n8n/rag-search.routes.ts`
- Multi-bot Phase 3 RAG scoping: see migration `1782700000000-AddBotIdToKnowledgeBase`
- This doc's parent task: #16e in the multi-bot follow-ups list.
