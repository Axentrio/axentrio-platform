# RAG Knowledge Base — Per-Tenant AI with pgvector

**Date:** 2026-03-27
**Status:** Reviewed (2x Codex passes incorporated)
**Approach:** Approach A — pgvector in existing PostgreSQL, custom RAG pipeline

---

## Overview

Add a per-tenant RAG (Retrieval-Augmented Generation) knowledge base to the chatbot platform. Tenants upload documents and text content, which gets chunked, embedded, and stored as vectors. When a customer sends a message in a `bot` session, the system retrieves relevant knowledge, assembles a prompt with brand voice configuration, and calls the tenant's configured LLM to generate a response.

### Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Vector store | pgvector (PostgreSQL extension) | No new infrastructure, tenant isolation via WHERE clause + composite unique indexes, fits existing migration pattern |
| Embedding model | OpenAI `text-embedding-3-small` (1536 dims) | Single model for all tenants regardless of LLM choice. Most mature, cost-effective. Platform absorbs embedding cost (~$0.02/M tokens) |
| LLM strategy | Multi-provider abstraction (OpenAI + Anthropic) | White-label differentiator. Tenants choose provider. Common interface, easy to extend |
| API key strategy | Platform default + tenant BYOK | Small tenants use platform keys, enterprises bring their own for chat LLM cost/compliance. Embeddings always use platform key |
| Knowledge sources | Text, FAQ, PDF, DOCX | Dedicated S3 upload path for KB files (separate from chat FileUpload). Web crawling deferred to Phase 2 |
| AI chat mode | Inline bot (autonomous in `bot` sessions) | Highest value — reduces agent load. Agent copilot mode deferred to Phase 2 |
| Guardrails | Moderate — tone, topics to avoid, escalation triggers, confidence threshold, fallback messages | Extensible config structure for future Advanced features |
| Processing | Async via Bull queue | Non-blocking ingestion, retry on failure, fits existing queue infrastructure |
| Chunking | Character-based with sentence boundary awareness | Sizes specified in characters (not tokens). Simpler than tokenizer-aware splitting, sufficient for RAG |
| Confidence | Structured JSON output from LLM | LLM returns `{ "response": "...", "confidence": 0.85 }` — parsed and compared to numeric threshold. Avoids brittle text parsing |
| KB content encryption | Plaintext in DB, rely on DB-level encryption at rest | Vectors cannot be encrypted (breaks similarity search). Text stored plaintext — matches industry standard. App-level encryption can be layered later for enterprise |
| RAG vs n8n | Coexist — RAG handles `bot` sessions when AI enabled, n8n forwarding continues for non-bot sessions or when AI disabled | Neither replaces the other |

### Future Phases (Noted)

- **Phase 2:** Web crawler for auto-indexing tenant websites
- **Phase 2:** Agent copilot mode (AI suggests responses, agent approves/edits)
- **Phase 3:** Advanced guardrails — per-topic response templates, response approval workflow, A/B testing of prompts

---

## Data Model

### New Entities

#### KnowledgeBase

One per tenant. Tracks configuration and aggregate stats.

```
id: UUID (PK)
tenantId: UUID (unique — one KB per tenant, FK → Tenant)
status: 'active' | 'inactive'
embeddingModel: string (default: 'text-embedding-3-small')
chunkSize: number (default: 1000 characters)
chunkOverlap: number (default: 200 characters)
lastIndexedAt: timestamp | null
createdAt: timestamp
updatedAt: timestamp
```

Note: `totalDocuments` and `totalChunks` are computed via COUNT queries, not stored as columns. This avoids counter drift on retries, partial failures, and concurrent processing.

#### KnowledgeDocument

Individual source documents uploaded by the tenant.

```
id: UUID (PK)
knowledgeBaseId: UUID (FK → KnowledgeBase)
tenantId: UUID (FK → Tenant — redundant for query performance, validated to match KB's tenantId)
type: 'text' | 'faq' | 'pdf' | 'docx'
title: string
sourceContent: text (original or extracted text)
storagePath: string | null (S3 key for PDF/DOCX — NOT linked to chat FileUpload)
status: 'pending' | 'processing' | 'indexed' | 'failed'
processingVersion: number (default: 1 — incremented on re-process, prevents stale retries)
errorMessage: string | null
chunkCount: number (default: 0)
metadata: JSONB { author?, url?, category?, tags?: string[] }
createdAt: timestamp
updatedAt: timestamp
```

Indexes:
- `tenantId` (B-tree)
- `knowledgeBaseId + status` (composite)

Constraints:
- Composite unique index: `(knowledgeBaseId, id)` — enables composite FK from chunks
- Application-layer validation: `document.tenantId` must equal `knowledgeBase.tenantId` on all writes

#### KnowledgeChunk

Embedded text chunks for vector similarity search.

```
id: UUID (PK)
documentId: UUID (FK → KnowledgeDocument, CASCADE DELETE)
tenantId: UUID (FK → Tenant — redundant for query performance, validated on insert)
content: text (the chunk text)
embedding: vector(1536) (pgvector column)
chunkIndex: number (position within document)
charCount: number (character count of content)
metadata: JSONB { headings?: string[], pageNumber?: number, section?: string }
createdAt: timestamp
```

Indexes:
- HNSW index on `embedding` with `vector_cosine_ops` (for fast approximate nearest neighbor search)
- B-tree index on `tenantId` (for scoped queries)
- Composite index on `documentId + chunkIndex`

Constraints:
- Application-layer validation: `chunk.tenantId` must equal `document.tenantId` on all inserts
- All chunk writes go through `knowledge.service.ts` which enforces this

**Why redundant `tenantId` on documents and chunks:** Performance. Vector similarity queries need `WHERE tenant_id = X` without joining through KnowledgeBase. The redundancy is validated on every write by the service layer to prevent cross-tenant contamination.

#### pgvector + TypeORM Integration Details

TypeORM 0.3.17 does not natively support the `vector` type. The exact implementation approach:

1. **Entity column**: Exclude `embedding` from the TypeORM entity definition entirely. The column is created via raw SQL in migrations and accessed only via raw SQL queries. The entity defines all other columns normally.

   ```typescript
   // KnowledgeChunk.ts — NO embedding column in entity
   @Entity('knowledge_chunks')
   export class KnowledgeChunk {
     @PrimaryGeneratedColumn('uuid')
     id: string;

     @Column('uuid')
     documentId: string;

     @Column('uuid')
     tenantId: string;

     @Column('text')
     content: string;

     // embedding NOT defined here — managed via raw SQL

     @Column('int')
     chunkIndex: number;

     @Column('int')
     charCount: number;

     @Column({ type: 'jsonb', default: {} })
     metadata: Record<string, any>;

     @CreateDateColumn()
     createdAt: Date;
   }
   ```

2. **Migration SQL**: Create the table via TypeORM entity sync (for non-vector columns), then add the vector column and index via raw SQL:
   ```sql
   -- In migration after table creation:
   ALTER TABLE knowledge_chunks ADD COLUMN embedding vector(1536);
   CREATE INDEX idx_chunks_embedding ON knowledge_chunks
     USING hnsw (embedding vector_cosine_ops);
   ```

3. **Inserts**: Use raw SQL for inserting chunks (since embedding is not in the entity):
   ```sql
   INSERT INTO knowledge_chunks (id, document_id, tenant_id, content, embedding, chunk_index, char_count, metadata, created_at)
   VALUES ($1, $2, $3, $4, $5::vector, $6, $7, $8, NOW())
   ```
   The embedding is passed as a string like `'[0.1,0.2,...]'` and cast to `vector`.

4. **Queries**: Use `DataSource.query()` (raw SQL) for vector similarity search:
   ```sql
   SELECT kc.id, kc.content, kc.metadata, kd.title,
          1 - (kc.embedding <=> $1::vector) AS similarity
   FROM knowledge_chunks kc
   JOIN knowledge_documents kd ON kd.id = kc.document_id
   WHERE kc.tenant_id = $2
     AND kd.status = 'indexed'
     AND 1 - (kc.embedding <=> $1::vector) >= $3
   ORDER BY kc.embedding <=> $1::vector
   LIMIT $4
   ```
   Parameters: `$1` = query embedding as `[0.1,0.2,...]` string, `$2` = tenantId, `$3` = minimum similarity (default 0.5), `$4` = limit (default 5).

5. **Entity registration**: Add `KnowledgeBase`, `KnowledgeDocument`, `KnowledgeChunk` to the entities array in `data-source.ts`.

6. **Test DB strategy**: The test suite uses `synchronize: true` which creates tables from entities. Since `embedding` is excluded from the entity, tests that need vector search must run the `ALTER TABLE ... ADD COLUMN embedding vector(1536)` SQL in test setup (a `beforeAll` hook). Tests that don't touch vector search work without it.

### Tenant Entity Extension

Nest AI settings inside the existing `settings` JSONB column on Tenant (replaces `settings.features.aiEnabled`):

```typescript
settings: {
  theme?: { primaryColor, logoUrl, customCss },
  features?: {
    fileUploadEnabled: boolean,
    handoffEnabled: boolean
    // aiEnabled removed — replaced by settings.ai.enabled
  },
  businessHours?: { enabled, timezone, schedule: [] },
  ai?: {
    enabled: boolean                       // replaces features.aiEnabled
    provider: 'openai' | 'anthropic'
    model: string                          // e.g. 'gpt-4o-mini', 'claude-sonnet-4-5-20250514'
    apiKey?: string                        // encrypted via AES-256-GCM — tenant BYOK, null = platform key
    brandVoice: {
      name: string                         // bot display name
      tone: 'formal' | 'casual' | 'friendly' | 'professional'
      customInstructions: string           // freeform system prompt additions
    }
    guardrails: {
      topicsToAvoid: string[]              // topics the bot must not discuss
      escalationKeywords: string[]         // keywords that trigger immediate handoff
      confidenceThreshold: number          // 0-1, default 0.7 — below this, escalate
      maxResponseLength: number            // default 500 characters
      greetingMessage: string              // sent when bot session starts
      fallbackMessage: string              // when bot can't answer or confidence is low
      offHoursMessage: string              // outside business hours (checked before RAG)
    }
  }
}
```

#### BYOK API Key Security

The `settings.ai.apiKey` field requires special handling to prevent exposure:

1. **Never returned in API responses**: `GET /api/v1/tenants/me` and `GET /api/v1/tenants/me/ai-settings` strip `apiKey` from the response. Return `hasApiKey: boolean` instead so the portal can show "API key configured" without exposing the value.
2. **Generic tenant PATCH rejects `settings.ai`**: The existing `PATCH /api/v1/tenants/me` endpoint must reject any payload containing `settings.ai`. AI settings are only modifiable via the dedicated `PATCH /api/v1/tenants/me/ai-settings` endpoint.
3. **Audit log redaction**: Any audit log entries that reference AI settings must redact the `apiKey` value.
4. **Encryption**: The `apiKey` is encrypted via AES-256-GCM before storing in the JSONB column. Decrypted only in the provider factory at LLM call time.

Migration: Move any existing `settings.features.aiEnabled = true` values to `settings.ai.enabled = true` with sensible defaults for other fields. Update all call sites that reference `settings.features.aiEnabled` (widget routes, tenant routes).

---

## Document Ingestion Pipeline

### File Upload for Knowledge Documents

The existing `FileUpload` entity is session-bound (requires `sessionId` and `participantId`). Knowledge documents use a **separate, server-side upload path**:

1. **PDF/DOCX upload endpoint**: `POST /api/v1/knowledge/documents/upload`
   - Accepts multipart file upload (using `multer` middleware, same as existing upload handling)
   - Server receives the file, validates file type (PDF/DOCX only) and size (25MB max)
   - Runs ClamAV virus scan (if enabled) **before** uploading to S3
   - Uploads to S3 under a knowledge-specific prefix: `knowledge/{tenantId}/{uuid}/{filename}`
   - Returns an **upload token** (UUID) tied to the tenant, not a raw S3 path
   - Upload tokens expire after 1 hour if not used in a document creation request
   - The `POST /api/v1/knowledge/documents` endpoint accepts the upload token, resolves it to the S3 path server-side. Raw `storagePath` values are never accepted from clients.

2. **Text/FAQ**: No file upload needed — content submitted directly in request body.

3. **Orphan cleanup**: A scheduled job (piggyback on existing GDPR cleanup scheduler) deletes S3 objects for expired upload tokens.

### Resource Limits

| Limit | Value | Rationale |
|-------|-------|-----------|
| Max file size | 25 MB | Matches existing upload limits |
| Max extracted text per document | 500,000 characters | Prevents runaway processing from huge PDFs |
| Max chunks per document | 1,000 | Caps embedding cost per document (~$0.01) |
| Max documents per tenant (free) | 50 | Tier-based limit |
| Max documents per tenant (pro) | 500 | Tier-based limit |
| Max documents per tenant (enterprise) | Unlimited | Tier-based limit |
| Empty extraction | Document → `failed` with message "No text content found" | Handles image-only PDFs |

### Processing Flow

```
Tenant uploads document (via portal or API)
    |
    v
API validates request (Zod schema)
    |
    +--> Text/FAQ: store sourceContent directly in KnowledgeDocument
    |
    +--> PDF/DOCX: server-side upload to S3 (knowledge prefix),
    |    ClamAV scan, return upload token
    |
    v
Create KnowledgeDocument (status: 'pending', processingVersion: 1)
    |
    v
Queue job on Bull queue ('knowledge-processing')
  Job ID: deterministic `kb-{documentId}-v{processingVersion}` (prevents duplicate jobs)
  Job payload: { documentId, tenantId, processingVersion }
    |
    v
Worker picks up job:
    |
    0. Version check: load document, verify processingVersion matches job payload
    |    Mismatch → discard job (stale retry)
    |
    1. Set document status → 'processing'
    |
    2. Extract text
    |    - text/faq: use sourceContent as-is
    |    - pdf: download from S3 → pdf-parse library
    |    - docx: download from S3 → mammoth library
    |    - If extracted text is empty → fail with "No text content found"
    |    - Truncate to 500,000 characters if exceeded
    |
    3. Chunk text
    |    - Recursive character splitter
    |    - Respects paragraph > sentence > word boundaries
    |    - chunkSize and chunkOverlap from KnowledgeBase config (in characters)
    |    - Cap at 1,000 chunks per document (discard remainder with warning)
    |
    4. Embed chunks in batch
    |    - OpenAI text-embedding-3-small (platform key)
    |    - Batches of 100 chunks per API call
    |
    5. Re-check processingVersion before write (prevent stale writes after long embedding)
    |    Mismatch → discard results, exit
    |
    6. Transaction: delete old chunks + bulk insert new chunks (atomic swap)
    |
    7. Update KnowledgeDocument: status → 'indexed', chunkCount set
    |
    8. Update KnowledgeBase.lastIndexedAt
    |
    v
Done
```

### Failure Handling

- If any step fails, document status → `failed`, errorMessage populated
- Bull queue retries up to 3x with exponential backoff (existing queue config)
- Worker checks `processingVersion` at start AND before writeback — prevents stale retries from overwriting newer data
- Deterministic job IDs (`kb-{documentId}-v{processingVersion}`) prevent duplicate jobs from config-change re-queuing
- After max retries, job moves to dead-letter queue
- Tenant can see failed documents in portal and retry manually (bumps processingVersion)

### Document Updates & Deletion

- **Update:** Bump `processingVersion`, set status → `pending`, re-queue with new deterministic job ID. Worker deletes old chunks in a transaction before inserting new ones (step 6).
- **Delete:** Remove KnowledgeDocument → CASCADE deletes KnowledgeChunks. Delete S3 object if `storagePath` is set.
- **Config change (chunkSize/chunkOverlap/embeddingModel):** Triggers re-processing of ALL documents in the knowledge base. Each document gets re-queued with a bumped `processingVersion`. Deterministic job IDs prevent duplicate jobs.

### Queue Integration

The `knowledge-processing` queue is registered in `message-queue.ts` alongside existing queues. The ingestion worker is registered via `registerProcessor` in the same process (not a separate worker service), matching the existing pattern for message-processing and webhook-delivery.

**When Redis is unavailable:** Ingestion jobs fail to enqueue. The document stays in `pending` status. The upload endpoint returns a 503 with a retry suggestion. This matches the existing sync-fallback behavior but does NOT attempt synchronous ingestion (embedding is too slow for request-response).

### New Dependencies

| Package | Purpose |
|---------|---------|
| `pgvector` | TypeORM pgvector type support (column type + query helpers) |
| `pdf-parse` | PDF text extraction |
| `mammoth` | DOCX to plain text conversion |
| `openai` | Embeddings API + chat completions |
| `@anthropic-ai/sdk` | Anthropic chat completions |

---

## RAG Query Flow

### Session State Machine

Canonical state transitions for AI-enabled sessions:

```
                    ┌─────────────────────────────┐
                    │                             │
                    v                             │
  [Session Created] ──AI enabled──> [bot] ──escalate──> [handoff] ──agent accepts──> [active]
                    │                  ^                                                │
                    │                  │                                                │
                    │                  └──────── return to bot ─────────────────────────┘
                    │                              (modify existing return-to-bot
                    │                               to set status='bot' instead
                    │                               of 'waiting' when AI enabled)
                    │
                    └──AI disabled──> [waiting] ──agent accepts──> [active]
                                        ^                            │
                                        └──── return to queue ───────┘
```

Key changes to existing behavior:
- **Session creation**: When AI is enabled + KB active with indexed docs → start in `bot` (not `waiting`)
- **Return to bot**: The existing handoff return route (`POST /handoffs/return`) currently sets status to `waiting`. When AI is enabled, it must set status to `bot` instead. This requires a one-line change in `handsoff.routes.ts`.
- **All other transitions**: Unchanged from existing behavior.

### Bot Participant

Each session with AI enabled gets a `Participant` record of type `bot`:
- Created when the session is created with `bot` status
- `participantType: 'bot'`, `name: settings.ai.brandVoice.name`
- All bot messages reference this participant's ID
- The existing n8n webhook service already has a pattern for creating bot/system participants — follow the same approach

### Trigger Conditions

The RAG pipeline activates when ALL of these are true:
1. Session status is `bot`
2. `tenant.settings.ai.enabled` is `true`
3. Tenant's KnowledgeBase status is `active` and has at least one indexed document
4. Message type is `text` (not image/file/system)
5. Business hours check passes (if configured):
   - Within business hours → proceed with RAG
   - Outside business hours → send `offHoursMessage`, do not call LLM

If conditions 1-4 are not met, existing behavior continues (wait for agent / n8n forwarding).

**Edge case — AI enabled but KB empty**: Session still starts as `bot`, but the first message triggers the "no indexed chunks" path → send `fallbackMessage` → trigger handoff (if enabled). This is intentional — the tenant has AI enabled but hasn't uploaded content yet; they see the fallback flow and know they need to add documents.

### Query Pipeline

```
Customer sends message
    |
    v
Message-forwarding service receives message (all paths: WebSocket, HTTP, widget)
    |
    v
Check trigger conditions (above)
    |
    v
1. Pre-check: scan message against escalationKeywords (case-insensitive substring match)
   Match found? → skip AI, trigger handoff immediately
    |
    v
2. Embed customer message
   OpenAI text-embedding-3-small → 1536-dim vector (platform key)
   Truncate message to 8,191 tokens (model limit) — use simple char estimate: 4 chars ≈ 1 token → truncate at 32,000 chars
    |
    v
3. Vector similarity search (raw SQL via DataSource.query())
   SELECT kc.id, kc.content, kc.metadata, kd.title,
          1 - (kc.embedding <=> $1::vector) AS similarity
   FROM knowledge_chunks kc
   JOIN knowledge_documents kd ON kd.id = kc.document_id
   WHERE kc.tenant_id = $2
     AND kd.status = 'indexed'
     AND 1 - (kc.embedding <=> $1::vector) >= $3
   ORDER BY kc.embedding <=> $1::vector
   LIMIT $4
    |
    v
4. Check retrieval results
   No chunks above similarity threshold?
     → Send fallbackMessage, trigger handoff
   Chunks found → continue
    |
    v
5. Assemble LLM prompt (with budget)
   Budget: reserve 500 tokens for response, 200 for system prompt, remainder for context + history
   ┌──────────────────────────────────────────────────┐
   │ SYSTEM PROMPT:                                   │
   │   You are {brandVoice.name}.                     │
   │   Tone: {brandVoice.tone}                        │
   │   {customInstructions}                           │
   │                                                  │
   │   Rules:                                         │
   │   - Only answer using the provided context        │
   │   - Never discuss: {topicsToAvoid}               │
   │   - Max response: {maxResponseLength} chars      │
   │   - If unsure, say so honestly                   │
   │                                                  │
   │   You MUST respond in this exact JSON format:    │
   │   { "response": "your answer", "confidence": N } │
   │   where confidence is 0.0-1.0                    │
   │                                                  │
   │ KNOWLEDGE CONTEXT:                               │
   │   [Source: {doc.title}] {chunk.content}          │
   │   [Source: {doc.title}] {chunk.content}          │
   │   ...up to 5 chunks (trimmed if over budget)     │
   │                                                  │
   │ CONVERSATION HISTORY:                            │
   │   [last 10 messages from session]                │
   │                                                  │
   │ USER: {customer message}                         │
   └──────────────────────────────────────────────────┘
    |
    v
6. Call LLM via provider abstraction
   Provider determined by tenant.settings.ai.provider
   API key: tenant BYOK (decrypted) → fallback to platform env key
   Response format: JSON mode (OpenAI) / JSON prefill (Anthropic)
   Timeout: 30 seconds
    |
    v
7. Parse structured response
   Extract { response, confidence } from LLM output
   If JSON parsing fails → treat as low confidence (0.0)
    |
    v
8. Evaluate confidence and act
   If confidence < tenant.settings.ai.guardrails.confidenceThreshold:
     → Send fallbackMessage via bot participant
     → Trigger handoff (see Handoff Creation below)
   If confidence >= threshold:
     → Send response text as bot message via bot participant
    |
    v
9. Send bot message via existing message creation flow
   participantId: bot participant UUID
   Emitted through WebSocket to customer via existing Socket.io rooms
```

### Handoff Creation

All RAG-triggered handoffs create a `HandoffRequest` record. The existing `HandoffRequest` entity requires:
- `requestedBy`: Set to the **bot participant's UUID** for all bot-initiated handoffs
- `reason`: Must match the existing enum. Add new reason values: `bot_confidence_low`, `bot_escalation_keyword`, `bot_no_knowledge`, `bot_error`

| Trigger | HandoffRequest.reason | fallbackMessage sent? |
|---------|----------------------|----------------------|
| Low confidence from LLM | `bot_confidence_low` | Yes |
| Escalation keyword match | `bot_escalation_keyword` | No (handoff is immediate) |
| No chunks above similarity threshold | `bot_no_knowledge` | Yes |
| Empty knowledge base | `bot_no_knowledge` | Yes |
| LLM API error/timeout | `bot_error` | Yes |
| BYOK key invalid | `bot_error` | Yes |
| LLM returns unparseable JSON | `bot_confidence_low` | Yes |

When `settings.features.handoffEnabled = false`: Send `fallbackMessage` only. Do not create HandoffRequest or transition session status. Session stays in `bot` and continues to attempt RAG on next message.

### Greeting Message

When a new session is created with `bot` status (AI enabled), the bot participant sends `settings.ai.guardrails.greetingMessage` as the first message in the session. This happens in the session creation flow, before any customer message.

### LLM Provider Abstraction

```typescript
interface LLMProvider {
  chat(messages: ChatMessage[], options: LLMOptions): Promise<LLMResponse>
}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

interface LLMOptions {
  model: string
  maxTokens: number
  temperature: number
  jsonMode: boolean    // request structured JSON output
}

interface LLMResponse {
  content: string
  usage: { promptTokens: number, completionTokens: number }
}

class OpenAIProvider implements LLMProvider {
  // Uses openai SDK
  // jsonMode → response_format: { type: 'json_object' }
}

class AnthropicProvider implements LLMProvider {
  // Uses @anthropic-ai/sdk
  // jsonMode → prefill assistant message with '{'
}
```

Provider resolution:
1. Read `tenant.settings.ai.provider`
2. Decrypt tenant API key if present, otherwise use `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` from env
3. Instantiate provider with resolved key
4. Provider instances can be cached per API key to reuse HTTP connections

### Embedding Service

Separate from LLM provider — always uses OpenAI regardless of tenant's chat LLM choice.

```typescript
class EmbeddingService {
  async embed(text: string): Promise<number[]>
  async embedBatch(texts: string[]): Promise<number[][]>
}
```

Uses platform-level `OPENAI_API_KEY` for embeddings (not tenant keys), since embedding is a platform cost. Single shared instance.

---

## API Endpoints

All under `/api/v1/knowledge/` with tenant middleware + Clerk auth.

### Knowledge Base Management

```
GET    /api/v1/knowledge/base          → Get tenant's knowledge base (auto-create if none)
PATCH  /api/v1/knowledge/base          → Update KB settings (chunkSize, chunkOverlap, status)
                                         If chunkSize or chunkOverlap changed, triggers re-processing of all documents
```

### Document Management

```
POST   /api/v1/knowledge/documents/upload     → Upload PDF/DOCX file (multipart), returns upload token
GET    /api/v1/knowledge/documents             → List documents (paginated, filterable by status/type)
POST   /api/v1/knowledge/documents             → Create document (text/faq: body content, pdf/docx: uploadToken)
GET    /api/v1/knowledge/documents/:id         → Get document details + chunk count
PUT    /api/v1/knowledge/documents/:id         → Update document (re-triggers processing, bumps processingVersion)
DELETE /api/v1/knowledge/documents/:id         → Delete document + chunks + S3 object
POST   /api/v1/knowledge/documents/:id/retry   → Retry failed document processing (bumps processingVersion)
```

### AI Settings (extends Tenant API)

```
GET    /api/v1/tenants/me/ai-settings          → Get AI config (settings.ai, apiKey stripped → hasApiKey: boolean)
PATCH  /api/v1/tenants/me/ai-settings          → Update AI config (provider, model, brand voice, guardrails)
                                                  apiKey is encrypted before storage
POST   /api/v1/tenants/me/ai-settings/test     → Test AI with a sample question
                                                  Returns: { response, confidence, chunks: [...], provider, model }
```

### Stats

```
GET    /api/v1/knowledge/stats                 → KB stats (computed: document count by status, total chunks, last indexed)
```

### Authorization

- `admin` and `super_admin` roles: full access to all knowledge + AI settings endpoints
- `supervisor` role: read-only access to knowledge base and documents
- `agent` role: no access to knowledge management (AI works transparently in chat)

---

## Module Structure

New files following existing codebase patterns:

```
api/src/
  knowledge/
    knowledge.controller.ts        # Route handlers for KB + documents + upload
    knowledge.service.ts           # KB + document CRUD, stats computation, upload token management
    knowledge.routes.ts            # Express router
    embedding.service.ts           # OpenAI embedding (embed, embedBatch)
    chunking.service.ts            # Character-based recursive splitter
    ingestion.worker.ts            # Bull queue worker (extract → chunk → embed → store)
    document-extractors/
      pdf.extractor.ts             # pdf-parse wrapper
      docx.extractor.ts            # mammoth wrapper
      text.extractor.ts            # passthrough
  llm/
    llm.types.ts                   # LLMProvider interface, ChatMessage, LLMOptions, LLMResponse
    openai.provider.ts             # OpenAI implementation (with JSON mode)
    anthropic.provider.ts          # Anthropic implementation (with JSON prefill)
    provider-factory.ts            # Resolves tenant config → provider instance (with caching)
    rag.service.ts                 # Orchestrates: embed query → retrieve → build prompt → call LLM → evaluate → handoff
  database/
    entities/
      KnowledgeBase.ts             # TypeORM entity with tenant FK
      KnowledgeDocument.ts         # TypeORM entity with processingVersion
      KnowledgeChunk.ts            # TypeORM entity (embedding excluded, raw SQL for vector ops)
    migrations/
      XXXX-add-pgvector-extension.ts      # CREATE EXTENSION IF NOT EXISTS vector
      XXXX-create-knowledge-tables.ts     # All 3 tables + vector column + indexes + HNSW (raw SQL)
      XXXX-add-ai-settings-to-tenant.ts   # Migrate settings.features.aiEnabled → settings.ai
      XXXX-add-handoff-reason-values.ts   # Add bot_confidence_low, bot_escalation_keyword, bot_no_knowledge, bot_error
  schemas/
    knowledge.schema.ts            # Zod: document create/update, KB update, file upload
    ai-settings.schema.ts          # Zod: AI settings update, test query
```

---

## Integration Points with Existing Code

### Message Forwarding Service (Primary Hook Point)

The RAG hook goes into `message-forwarding.service.ts`, which all inbound message paths flow through (WebSocket handler, widget HTTP endpoint, chat API routes). This is the single point where we check:
1. Is session status `bot`?
2. Is AI enabled?
3. If yes → call `rag.service.generateResponse()`
4. If no → continue existing n8n/webhook forwarding

This ensures RAG works regardless of how the message arrives (WebSocket, REST, widget).

### Session Creation

Modify session creation logic:
- If `tenant.settings.ai.enabled` and KnowledgeBase is active:
  - Set initial session status to `bot` (instead of `waiting`)
  - Create a `bot` type Participant for the session
  - Send `greetingMessage` as first bot message
- If AI not enabled: existing behavior (status `waiting`)

### Handoff Return Route

Modify `handsoff.routes.ts` return handler:
- When returning a session and AI is enabled → set status to `bot` (not `waiting`)
- Re-create bot participant if needed (participant may have been removed during agent session)

### S3 Upload

Knowledge file uploads use the existing S3 client (`@aws-sdk/client-s3`) directly (server-side `PutObject`, not pre-signed URLs). Dedicated S3 prefix (`knowledge/`), no `sessionId`/`participantId` required. ClamAV scanning runs server-side before S3 upload.

### Bull Queue

Add queue `knowledge-processing` to `message-queue.ts` alongside existing queues. Same Redis backend, same retry/backoff config. Register the ingestion worker via `registerProcessor` in server startup (in-process, not separate worker).

When Redis is unavailable: ingestion fails to enqueue, document stays `pending`, endpoint returns 503.

### Encryption Service

Tenant BYOK API keys encrypted/decrypted using existing `encryption.ts` AES-256-GCM service. The `PATCH /ai-settings` endpoint encrypts the key before saving; the provider factory decrypts before use.

### Generic Tenant PATCH Protection

The existing `PATCH /api/v1/tenants/me` endpoint must reject payloads containing `settings.ai`. AI settings are only modifiable via the dedicated `PATCH /api/v1/tenants/me/ai-settings` endpoint. This prevents accidental exposure or overwrite through the generic settings update path.

### Existing Call Sites to Update

- `widget.ts`: Replace `settings.features.aiEnabled` checks with `settings.ai?.enabled`
- `tenants.ts`: Update any references to `settings.features.aiEnabled`, add `settings.ai` rejection to generic PATCH
- `handsoff.routes.ts`: Return-to-bot sets `bot` status when AI enabled (currently sets `waiting`)
- `data-source.ts`: Add new entities to the entities array
- `HandoffRequest.ts`: Add new reason enum values

---

## Environment Variables

New env vars added to `config/environment.ts`:

```
# Required (platform-level keys)
OPENAI_API_KEY=sk-...              # Used for embeddings + default OpenAI chat
ANTHROPIC_API_KEY=sk-ant-...       # Default Anthropic chat (optional if no tenants use Anthropic)

# Optional tuning
RAG_DEFAULT_CHUNK_SIZE=1000        # Default chunk size in characters
RAG_DEFAULT_CHUNK_OVERLAP=200      # Default overlap in characters
RAG_MAX_CONTEXT_CHUNKS=5           # Max chunks retrieved per query
RAG_MIN_SIMILARITY=0.5             # Minimum cosine similarity threshold for retrieval
RAG_CONVERSATION_HISTORY_LIMIT=10  # Messages included as conversation context
RAG_EMBEDDING_BATCH_SIZE=100       # Chunks per embedding API call
RAG_MAX_EXTRACTED_CHARS=500000     # Max characters extracted from a single document
RAG_MAX_CHUNKS_PER_DOC=1000        # Max chunks per document
```

---

## Docker / Infrastructure Changes

### PostgreSQL

Update docker-compose to use pgvector-enabled postgres image:

```yaml
services:
  postgres:
    image: pgvector/pgvector:pg16    # was: postgres:16-alpine
    container_name: handsoff-pg
    ports:
      - "5433:5432"
    environment:
      POSTGRES_DB: chatbot_platform
      POSTGRES_USER: postgres
      POSTGRES_HOST_AUTH_METHOD: trust
    volumes:
      - handsoff_pgdata:/var/lib/postgresql/data
```

This is a drop-in replacement that includes the pgvector extension. No other infrastructure changes.

### Migration

First migration enables the extension:

```sql
CREATE EXTENSION IF NOT EXISTS vector;
```

No new services needed. No new containers. Same PostgreSQL, same Redis.

### Railway

Railway PostgreSQL supports pgvector natively — just run the `CREATE EXTENSION` migration. No image change needed for production.

---

## Error Handling & Edge Cases

| Scenario | Behavior |
|----------|----------|
| Tenant has no knowledge base | Auto-create on first access with defaults |
| Knowledge base is empty (no indexed chunks) | Bot sends `fallbackMessage`, creates HandoffRequest (reason: `bot_no_knowledge`) |
| No chunks above similarity threshold (0.5) | Bot sends `fallbackMessage`, creates HandoffRequest (reason: `bot_no_knowledge`) |
| Escalation keyword detected | Skip AI, create HandoffRequest (reason: `bot_escalation_keyword`), transition to `handoff` |
| OpenAI embedding API down | Ingestion: job retries via queue. Query: bot sends `fallbackMessage`, HandoffRequest (reason: `bot_error`) |
| LLM API down or timeout (30s) | Bot sends `fallbackMessage`, HandoffRequest (reason: `bot_error`) |
| LLM returns unparseable JSON | Treat as confidence 0.0 → `fallbackMessage` + HandoffRequest (reason: `bot_confidence_low`) |
| Tenant BYOK key is invalid/expired | LLM call fails → `fallbackMessage` + HandoffRequest (reason: `bot_error`). Error logged to audit log |
| Very long customer message | Truncate to ~32,000 chars before embedding (8,191 token model limit × ~4 chars/token) |
| Prompt exceeds model context | Trim knowledge chunks (fewest similarity first) until within budget |
| Document extraction fails (corrupt PDF) | Document status → `failed`, errorMessage set, tenant can retry |
| Document extraction yields no text | Document status → `failed`, errorMessage: "No text content found" |
| Extracted text exceeds 500K chars | Truncated to 500K with warning in document metadata |
| Document exceeds 1,000 chunks | Excess chunks discarded with warning in document metadata |
| Stale retry (processingVersion mismatch) | Worker discards the job silently |
| Version mismatch after embedding (pre-write check) | Worker discards results, exits without writing |
| Concurrent document processing | Bull queue handles concurrency (existing config: 10 concurrent jobs) |
| Duplicate jobs (config change re-queue) | Deterministic job IDs prevent duplicates |
| chunkSize/chunkOverlap changed | All documents re-queued for processing with bumped processingVersion |
| Business hours check | If business hours enabled and currently outside hours → send `offHoursMessage`, skip RAG |
| Handoff disabled for tenant | Send `fallbackMessage` only — no HandoffRequest, no status transition. Bot continues on next message |
| Redis unavailable during upload | Document stays `pending`, endpoint returns 503 |
| Tenant exceeds document limit | Endpoint returns 403 with tier upgrade message |
| Return to bot after agent | Session status → `bot` (not `waiting`) when AI enabled |
| Generic PATCH tries to set settings.ai | Rejected with 400, must use dedicated AI settings endpoint |
| GET tenant returns settings.ai | apiKey stripped, `hasApiKey: boolean` returned instead |
