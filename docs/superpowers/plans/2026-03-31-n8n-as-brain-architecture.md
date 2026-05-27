# n8n-as-Brain Architecture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restructure the AI pipeline so n8n orchestrates all AI sessions, with native RAG exposed as an internal search API.

**Architecture:** All `bot` session messages forward to n8n (single shared workflow). n8n calls the platform's RAG search endpoint when knowledge base content is needed. If n8n is down, the platform falls back to native RAG for text messages. Brand voice, guardrails, and KB metadata are passed in the outbound payload — n8n never hardcodes tenant config.

**Tech Stack:** Express, TypeORM, pgvector, n8n (workflow JSON), Zod, OpenAI embeddings

**Spec:** `docs/superpowers/specs/2026-03-31-n8n-as-brain-architecture-design.md`

---

## File Structure

### New files:
- `api/src/n8n/rag-search.routes.ts` — Internal RAG search endpoint (Express router)
- `docs/n8n-workflows/chatbot-platform-v2-brain.json` — Updated n8n workflow with KB fetch node

### Modified files:
- `api/src/llm/rag.service.ts` — Extract `searchKnowledge()` from existing `generateResponse()`
- `api/src/n8n/types/message.types.ts` — Add `tenantConfig` and `knowledgeBase` to `OutboundMessage`
- `api/src/n8n/schemas/outbound-message.schema.ts` — Add `tenantConfig` and `knowledgeBase` to JSON schema (required: `additionalProperties: false` blocks unknown fields)
- `api/src/services/message-forwarding.service.ts` — Remove RAG-first block, add RAG fallback on n8n failure, include conversation history in payload
- `api/src/config/environment.ts` — Add `RAG_INTERNAL_SECRET`, `N8N_DEFAULT_WEBHOOK_URL`, `N8N_INBOUND_SECRET` env vars
- `api/src/knowledge/knowledge.controller.ts` — Auto-set webhookUrl + webhookSecret when AI is enabled
- `api/src/server.ts` — Mount RAG search router (outside webhook try block)

---

### Task 1: Add Environment Config for RAG Internal Secret and Default Webhook URL

**Files:**
- Modify: `api/src/config/environment.ts:97-100`

- [ ] **Step 1: Add new env vars to the Zod schema**

In `api/src/config/environment.ts`, add after the `N8N_WEBHOOK_URL` line (line 99):

```typescript
  N8N_DEFAULT_WEBHOOK_URL: z.string().optional(),
  RAG_INTERNAL_SECRET: z.string().optional(),
  N8N_INBOUND_SECRET: z.string().optional(),
```

- [ ] **Step 2: Add to the config export object**

In the `n8n` section of the config export (lines 323-326), replace:

```typescript
  n8n: {
    webhookUrl: env.WEBHOOK_URL || env.N8N_WEBHOOK_URL,
    enabled: !!(env.WEBHOOK_URL || env.N8N_WEBHOOK_URL),
  },
```

with:

```typescript
  n8n: {
    webhookUrl: env.WEBHOOK_URL || env.N8N_WEBHOOK_URL,
    defaultWebhookUrl: env.N8N_DEFAULT_WEBHOOK_URL || env.WEBHOOK_URL || env.N8N_WEBHOOK_URL,
    enabled: !!(env.WEBHOOK_URL || env.N8N_WEBHOOK_URL || env.N8N_DEFAULT_WEBHOOK_URL),
    ragInternalSecret: env.RAG_INTERNAL_SECRET,
    inboundSecret: env.N8N_INBOUND_SECRET,
  },
```

- [ ] **Step 3: Add env vars to `.env.example`**

Add to the `# Webhook / N8N` section:

```
N8N_DEFAULT_WEBHOOK_URL=http://localhost:5678/webhook/chatbot-platform
RAG_INTERNAL_SECRET=change-me-in-production
N8N_INBOUND_SECRET=change-me-in-production
```

Also update `api/.env.railway.example` with the same vars in the N8N section.

- [ ] **Step 4: Commit**

```bash
git add api/src/config/environment.ts api/.env.example api/.env.railway.example
git commit -m "feat: add RAG_INTERNAL_SECRET, N8N_DEFAULT_WEBHOOK_URL, N8N_INBOUND_SECRET env vars"
```

---

### Task 2: Extract `searchKnowledge()` from RAG Service

**Files:**
- Modify: `api/src/llm/rag.service.ts`

- [ ] **Step 1: Add the `searchKnowledge` function**

Add this new exported function after the `rewriteQuery` function (after line 86) in `api/src/llm/rag.service.ts`:

```typescript
/**
 * Search knowledge base for relevant chunks — used by the internal RAG search endpoint.
 * Search only: no LLM call, no prompt construction, no confidence scoring.
 */
export async function searchKnowledge(
  dataSource: DataSource,
  tenantId: string,
  query: string,
  conversationHistory: { role: 'user' | 'assistant'; content: string }[],
  maxChunks: number = config.rag.maxContextChunks
): Promise<{ chunks: RetrievedChunk[]; totalChunks: number }> {
  const searchQuery = await rewriteQuery(query, conversationHistory);
  logger.info(`[RAG Search] Query: "${searchQuery}" | tenant: ${tenantId}`);

  const queryEmbedding = await embed(searchQuery);
  const embeddingStr = `[${queryEmbedding.join(',')}]`;

  const chunks: RetrievedChunk[] = await dataSource.query(
    `SELECT kc.id, kc.content, kc.metadata, kd.title,
            1 - (kc.embedding <=> $1::vector) AS similarity,
            ts_rank(kc.tsv, websearch_to_tsquery('english', $5)) AS keyword_rank
     FROM knowledge_chunks kc
     JOIN knowledge_documents kd ON kd.id = kc."documentId"
     WHERE kc."tenantId" = $2
       AND kd.status = 'indexed'
       AND (
         1 - (kc.embedding <=> $1::vector) >= $3
         OR kc.tsv @@ websearch_to_tsquery('english', $5)
       )
     ORDER BY (1 - (kc.embedding <=> $1::vector)) + ts_rank(kc.tsv, websearch_to_tsquery('english', $5)) * 0.5 DESC
     LIMIT $4`,
    [embeddingStr, tenantId, config.rag.minSimilarity, maxChunks, searchQuery]
  );

  logger.info(`[RAG Search] Retrieved ${chunks.length} chunks${chunks.length > 0 ? `, top similarity: ${chunks[0]?.similarity}` : ''}`);

  return { chunks, totalChunks: chunks.length };
}
```

- [ ] **Step 2: Verify existing `generateResponse` still works**

The existing `generateResponse` function is unchanged — it continues to use its inline query for the fallback path. No refactor needed.

- [ ] **Step 3: Commit**

```bash
git add api/src/llm/rag.service.ts
git commit -m "feat: extract searchKnowledge() for internal RAG search endpoint"
```

---

### Task 3: Create Internal RAG Search Endpoint

**Files:**
- Create: `api/src/n8n/rag-search.routes.ts`
- Modify: `api/src/server.ts:232`

- [ ] **Step 1: Create the RAG search router**

Create `api/src/n8n/rag-search.routes.ts`:

```typescript
/**
 * Internal RAG Search Endpoint
 * Called by n8n to search tenant knowledge bases.
 * Auth: Bearer token using RAG_INTERNAL_SECRET (platform-level, not per-tenant).
 */

import { Router, Request, Response } from 'express';
import { body, validationResult } from 'express-validator';
import { config } from '../config/environment';
import { logger } from '../utils/logger';
import { AppDataSource } from '../database/data-source';
import { searchKnowledge } from '../llm/rag.service';

const router = Router();

function verifyInternalAuth(req: Request, res: Response, next: Function): void {
  const secret = config.n8n.ragInternalSecret;
  if (!secret) {
    logger.warn('[RAG Search] RAG_INTERNAL_SECRET not configured — endpoint disabled');
    res.status(503).json({ error: 'RAG search endpoint not configured' });
    return;
  }

  const authHeader = req.headers.authorization;
  if (!authHeader || authHeader !== `Bearer ${secret}`) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  next();
}

router.post(
  '/search',
  verifyInternalAuth,
  [
    body('tenantId').isUUID().withMessage('tenantId must be a valid UUID'),
    body('query').isString().notEmpty().withMessage('query is required'),
    body('maxChunks').optional().isInt({ min: 1, max: 20 }).withMessage('maxChunks must be 1-20'),
    body('conversationHistory').optional().isArray().withMessage('conversationHistory must be an array'),
  ],
  async (req: Request, res: Response): Promise<void> => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({ error: 'Validation failed', details: errors.array() });
      return;
    }

    const { tenantId, query, maxChunks, conversationHistory } = req.body;

    try {
      const result = await searchKnowledge(
        AppDataSource,
        tenantId,
        query,
        conversationHistory || [],
        maxChunks || 5
      );

      res.json(result);
    } catch (error) {
      logger.error('[RAG Search] Search failed', error);
      res.status(500).json({ error: 'Search failed' });
    }
  }
);

export default router;
```

- [ ] **Step 2: Mount the router in server.ts**

In `api/src/server.ts`, add the import after the existing n8n imports (around line 46):

```typescript
import ragSearchRoutes from './n8n/rag-search.routes';
```

Then mount it inside the `try` block where the webhook module is initialized (after line 232 `apiRouter.use('/webhooks', webhookModule.router);`), add:

```typescript
      // Internal RAG search endpoint for n8n
      apiRouter.use('/internal/rag', ragSearchRoutes);
```

- [ ] **Step 3: Test manually with curl**

```bash
curl -X POST http://localhost:3000/api/v1/internal/rag/search \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer change-me-in-production" \
  -d '{"tenantId":"<some-tenant-uuid>","query":"test query"}'
```

Expected: 200 with `{ "chunks": [...], "totalChunks": N }` or empty chunks if no KB.

- [ ] **Step 4: Commit**

```bash
git add api/src/n8n/rag-search.routes.ts api/src/server.ts
git commit -m "feat: add internal RAG search endpoint for n8n"
```

---

### Task 4: Extend OutboundMessage Types with Tenant Config and KB Metadata

**Files:**
- Modify: `api/src/n8n/types/message.types.ts:100-108`

- [ ] **Step 1: Add new interfaces**

In `api/src/n8n/types/message.types.ts`, add before the `OutboundMessage` interface (before line 100):

```typescript
export interface TenantAiConfig {
  brandName: string;
  brandTone: string;
  systemPrompt: string;
  guardrails: {
    topicsToAvoid: string[];
    confidenceThreshold: number;
    maxResponseLength: number;
    escalationKeywords: string[];
  };
}

export interface KnowledgeBaseMetadata {
  enabled: boolean;
  documentCount: number;
}
```

- [ ] **Step 2: Add fields to OutboundMessage**

Update the `OutboundMessage` interface (lines 100-108) to:

```typescript
export interface OutboundMessage {
  event: MessageEvent;
  tenantId: string;
  sessionId: string;
  timestamp: string;
  payload: MessagePayload;
  user?: UserContext;
  context?: ChatContext;
  tenantConfig?: TenantAiConfig;
  knowledgeBase?: KnowledgeBaseMetadata;
}
```

- [ ] **Step 3: Update the outbound message JSON schema**

The outbound schema at `api/src/n8n/schemas/outbound-message.schema.ts` uses `additionalProperties: false` (line 15). Adding new fields to the TypeScript type without updating this schema will cause `sendToWebhook()` validation to silently strip them. Add after the `context` property (before the closing `},` on line 206):

```typescript
    tenantConfig: {
      type: 'object',
      additionalProperties: true,
      properties: {
        brandName: { type: 'string' },
        brandTone: { type: 'string' },
        systemPrompt: { type: 'string' },
        guardrails: {
          type: 'object',
          additionalProperties: true,
          properties: {
            topicsToAvoid: { type: 'array', items: { type: 'string' } },
            confidenceThreshold: { type: 'number' },
            maxResponseLength: { type: 'number' },
            escalationKeywords: { type: 'array', items: { type: 'string' } },
          },
        },
      },
    },
    knowledgeBase: {
      type: 'object',
      additionalProperties: false,
      properties: {
        enabled: { type: 'boolean' },
        documentCount: { type: 'number' },
      },
    },
```

- [ ] **Step 4: Commit**

```bash
git add api/src/n8n/types/message.types.ts api/src/n8n/schemas/outbound-message.schema.ts
git commit -m "feat: add tenantConfig and knowledgeBase to OutboundMessage type and schema"
```

---

### Task 5: Enrich Outbound Payload with Tenant AI Config and KB Metadata

**Files:**
- Modify: `api/src/services/message-forwarding.service.ts:51-66`
- Modify: `api/src/n8n/outbound.service.ts:290-314`

- [ ] **Step 1: Add helper functions for tenant AI config and KB metadata**

Note: `buildWebhookConfig` already sets `timeout: 30000` and `sendToWebhook()` already respects `webhookConfig.timeout`. No timeout change needed.

In `api/src/services/message-forwarding.service.ts`, add this import at the top:

```typescript
import { TenantAiConfig, KnowledgeBaseMetadata } from '../n8n/types/message.types';
```

Then add these helper functions after `buildWebhookConfig` (after line 66):

```typescript
function buildTenantAiConfig(tenant: Tenant): TenantAiConfig | undefined {
  const ai = tenant.settings?.ai;
  if (!ai?.enabled) return undefined;

  return {
    brandName: ai.brandVoice?.name || tenant.name,
    brandTone: ai.brandVoice?.tone || 'professional',
    systemPrompt: ai.brandVoice?.customInstructions || '',
    guardrails: {
      topicsToAvoid: ai.guardrails?.topicsToAvoid || [],
      confidenceThreshold: ai.guardrails?.confidenceThreshold ?? 0.7,
      maxResponseLength: ai.guardrails?.maxResponseLength ?? 500,
      escalationKeywords: ai.guardrails?.escalationKeywords || [],
    },
  };
}

async function buildKnowledgeBaseMetadata(tenantId: string): Promise<KnowledgeBaseMetadata> {
  try {
    const result = await AppDataSource.query(
      `SELECT COUNT(*)::int AS count FROM knowledge_documents WHERE "tenantId" = $1 AND status = 'indexed'`,
      [tenantId]
    );
    const docCount = result[0]?.count || 0;
    return { enabled: docCount > 0, documentCount: docCount };
  } catch {
    return { enabled: false, documentCount: 0 };
  }
}
```

- [ ] **Step 3: Update outbound.service.ts `buildOutboundMessage` to accept new fields**

In `api/src/n8n/outbound.service.ts`, update `buildOutboundMessage` (lines 290-314) to pass through new fields:

```typescript
  public async buildOutboundMessage(
    context: PayloadBuilderContext,
    event: string = 'message.received'
  ): Promise<OutboundMessage> {
    const { sessionId, tenantId, userId, message, req, customContext } = context;

    const userContext = this.buildUserContext(userId, req);
    const chatContext = await this.buildChatContext(sessionId, customContext, req);

    const outboundMessage: OutboundMessage = {
      event: event as OutboundMessage['event'],
      tenantId,
      sessionId,
      timestamp: new Date().toISOString(),
      payload: message,
      user: userContext,
      context: chatContext,
    };

    return outboundMessage;
  }
```

This stays the same — the `tenantConfig` and `knowledgeBase` fields will be added to the message in `message-forwarding.service.ts` before calling `sendToWebhook`, since that's where we have the tenant object loaded. See Task 6.

- [ ] **Step 4: Commit**

```bash
git add api/src/services/message-forwarding.service.ts api/src/n8n/outbound.service.ts api/src/n8n/types/message.types.ts
git commit -m "feat: enrich outbound payload with tenant AI config and KB metadata"
```

---

### Task 6: Rewrite message-forwarding.service.ts — n8n-First with RAG Fallback

**Files:**
- Modify: `api/src/services/message-forwarding.service.ts`

This is the core change. Replace the RAG-first block with n8n-first, keep business hours + escalation keyword checks, add RAG fallback on n8n failure.

- [ ] **Step 1: Add config import**

Add at top of `api/src/services/message-forwarding.service.ts`:

```typescript
import { config } from '../config/environment';
```

- [ ] **Step 2: Replace the `forwardMessageToN8n` function**

Replace the entire `forwardMessageToN8n` function (lines 74-271) with:

```typescript
export async function forwardMessageToN8n(
  session: ChatSession,
  savedMessage: Message
): Promise<boolean> {
  // Only forward visitor messages when session is in bot or waiting status
  if (session.status !== 'bot' && session.status !== 'waiting') {
    return false;
  }

  if (!outboundService) {
    logger.warn('Message forwarding not initialized — outboundService is null');
    return false;
  }

  const tenant = await tenantRepository.findOne({ where: { id: session.tenantId } });
  if (!tenant) {
    logger.warn(`Tenant not found for session ${session.id}`);
    return false;
  }

  // Use tenant's webhookUrl, or global default ONLY for AI-enabled tenants
  const webhookUrl = tenant.webhookUrl || (aiSettings?.enabled ? config.n8n.defaultWebhookUrl : undefined);
  if (!webhookUrl) {
    // No webhook configured and AI not enabled — session stays waiting, agent picks up
    return false;
  }

  // ── Pre-forwarding checks (cheap, local) ──────────────────────────────
  const aiSettings = tenant.settings?.ai;

  if (session.status === 'bot' && savedMessage.type === 'text' && aiSettings?.enabled) {
    // Business hours check
    const bh = tenant.settings?.businessHours;
    if (bh?.enabled && bh.schedule?.length) {
      const now = new Date();
      const tz = bh.timezone || 'UTC';
      const dayFormatter = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'long' });
      const dayName = dayFormatter.format(now).toLowerCase();
      const timeFormatter = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false });
      const parts = timeFormatter.formatToParts(now);
      const hour = parts.find(p => p.type === 'hour')!.value;
      const minute = parts.find(p => p.type === 'minute')!.value;
      const timeStr = `${hour}:${minute}`;
      const daySchedule = bh.schedule.find((s: any) => s.day.toLowerCase() === dayName);

      const isOutsideHours = !daySchedule || daySchedule.closed ||
        timeStr < daySchedule.open || timeStr >= daySchedule.close;

      if (isOutsideHours) {
        const botParticipant = await ensureBotParticipant(session, aiSettings);
        await sendBotMessage(
          session,
          botParticipant.id,
          aiSettings.guardrails?.offHoursMessage || "We're currently outside business hours. We'll get back to you soon."
        );
        return true;
      }
    }

    // Escalation keyword check — decrypt first if needed
    const escalationKeywords = aiSettings.guardrails?.escalationKeywords || [];
    const plainContent = savedMessage.contentEncrypted
      ? decrypt(savedMessage.content)
      : savedMessage.content;
    const lowerContent = plainContent.toLowerCase();
    const matchedKeyword = escalationKeywords.find((kw: string) =>
      lowerContent.includes(kw.toLowerCase())
    );

    if (matchedKeyword) {
      logger.info(`Escalation keyword "${matchedKeyword}" detected in session ${session.id}`);
      const botParticipant = await ensureBotParticipant(session, aiSettings);
      await sendBotMessage(
        session,
        botParticipant.id,
        aiSettings.guardrails?.fallbackMessage || "I'm connecting you to a human agent."
      );
      await handleBotHandoff(session, botParticipant.id, 'bot_escalation_keyword');
      return true;
    }
  }

  // ── Build enriched outbound payload ────────────────────────────────────
  const webhookConfig = buildWebhookConfig(tenant);
  // Override URL with resolved webhook URL (may be global default)
  webhookConfig.url = webhookUrl;

  const outboundPayload: OutboundMessage = {
    event: 'message.received',
    tenantId: session.tenantId,
    sessionId: session.id,
    timestamp: new Date().toISOString(),
    payload: {
      type: (savedMessage.type as MessagePayload['type']) || 'text',
      content: savedMessage.contentEncrypted
        ? decrypt(savedMessage.content)
        : savedMessage.content,
      metadata: savedMessage.metadata || undefined,
    },
    tenantConfig: buildTenantAiConfig(tenant),
    knowledgeBase: await buildKnowledgeBaseMetadata(session.tenantId),
    context: {
      previousMessages: await getConversationHistoryForPayload(session.id),
    },
  };

  // ── Forward to n8n ─────────────────────────────────────────────────────
  // NOTE: sendToWebhook() swallows HTTP errors and returns { success: false }
  // instead of throwing. Must check result.success, not rely on catch.
  const result = await outboundService.sendToWebhook(webhookConfig, outboundPayload);

  if (result.success) {
    // Transition waiting → bot atomically on first forwarded message
    if (session.status === 'waiting') {
      await sessionRepository
        .createQueryBuilder()
        .update(ChatSession)
        .set({ status: 'bot' })
        .where('id = :id AND status = :status', { id: session.id, status: 'waiting' })
        .execute();
    }

    return true;
  }

  // ── n8n forwarding failed ──────────────────────────────────────────────
  logger.error(`n8n forwarding failed for session ${session.id}`, { error: result.error });

    // ── RAG fallback (text messages only, when tenant has KB) ──────────
    if (
      session.status === 'bot' &&
      savedMessage.type === 'text' &&
      aiSettings?.enabled &&
      outboundPayload.knowledgeBase?.enabled
    ) {
      try {
        logger.info(`[Fallback] Attempting native RAG for session ${session.id}`);
        const history = await getConversationHistory(session.id);
        const messageContent = savedMessage.contentEncrypted
          ? decrypt(savedMessage.content)
          : savedMessage.content;
        const ragResult = await generateResponse(
          AppDataSource,
          session.tenantId,
          aiSettings as Parameters<typeof generateResponse>[2],
          messageContent,
          history
        );

        const botParticipant = await ensureBotParticipant(session, aiSettings);
        await sendBotMessage(session, botParticipant.id, ragResult.response);

        if (ragResult.shouldHandoff && ragResult.handoffReason) {
          await handleBotHandoff(session, botParticipant.id, ragResult.handoffReason as HandoffRequest['reason']);
        }

        logger.info(`[Fallback] Native RAG succeeded for session ${session.id}`);
        return true;
      } catch (ragError) {
        logger.error(`[Fallback] Native RAG also failed for session ${session.id}`, ragError);
      }
    }

    // ── Final fallback: bot message + proper handoff ────────────────────
    // Use sendBotMessage (routes through outbound-router for multi-channel support)
    // and handleBotHandoff (creates HandoffRequest record + notifies agents)
    try {
      const botParticipant = await ensureBotParticipant(session, aiSettings || {});
      const fallbackContent = aiSettings?.guardrails?.fallbackMessage ||
        "We're connecting you to an agent. Please hold on.";
      await sendBotMessage(session, botParticipant.id, fallbackContent);
      await handleBotHandoff(session, botParticipant.id, 'bot_error');
    } catch (innerError) {
      logger.error(`Failed to handle n8n failure gracefully for session ${session.id}`, innerError);
    }

    return true;
}
```

- [ ] **Step 3: Update imports**

Update the imports at the top of `message-forwarding.service.ts`. Keep `WebhookConfig` (still used by `buildWebhookConfig`), add the new types:

```typescript
import { OutboundMessage, WebhookConfig, MessagePayload } from '../n8n/types';
import { config } from '../config/environment';
```

- [ ] **Step 4: Add `getConversationHistoryForPayload` helper**

Add after the existing `getConversationHistory` function. This version returns the format expected by the outbound payload (with timestamps):

```typescript
async function getConversationHistoryForPayload(
  sessionId: string
): Promise<{ role: 'user' | 'assistant' | 'system'; content: string; timestamp: string }[]> {
  const messages = await messageRepository
    .createQueryBuilder('message')
    .leftJoinAndSelect('message.participant', 'participant')
    .where('message.sessionId = :sessionId', { sessionId })
    .andWhere('message.isDeleted = false')
    .andWhere('message.type = :type', { type: 'text' })
    .orderBy('message.createdAt', 'DESC')
    .take(10)
    .getMany();

  return messages.reverse().map((msg) => ({
    role: msg.participant?.type === 'bot' ? 'assistant' as const : 'user' as const,
    content: msg.content,
    timestamp: msg.createdAt?.toISOString() || new Date().toISOString(),
  }));
}
```

- [ ] **Step 5: Verify existing helper functions are intact**

The following functions at the bottom of the file should remain unchanged:
- `ensureBotParticipant` (lines 278-298)
- `getConversationHistory` (lines 303-321) — kept for RAG fallback path
- `sendBotMessage` (lines 326-358)
- `handleBotHandoff` (lines 364-405)

- [ ] **Step 5: Commit**

```bash
git add api/src/services/message-forwarding.service.ts
git commit -m "feat: rewrite message forwarding — n8n-first with RAG fallback"
```

---

### Task 7: Auto-Set webhookUrl When Tenant Enables AI

**Files:**
- Modify: `api/src/knowledge/knowledge.controller.ts:185-208`

- [ ] **Step 1: Update the `updateAiSettings` handler**

In `api/src/knowledge/knowledge.controller.ts`, `config` (line 7) and `logger` (line 9) are already imported. Update the `updateAiSettings` function. After `tenant.settings = { ...tenant.settings, ai: updatedAi };` (line 203), add the auto-provisioning logic before the save:

```typescript
  // Auto-provision webhook URL + secret when AI is enabled and no custom URL is set
  if (updatedAi.enabled && !tenant.webhookUrl && config.n8n.defaultWebhookUrl) {
    tenant.webhookUrl = config.n8n.defaultWebhookUrl;
    // Set webhookSecret to the shared inbound secret so the default n8n workflow
    // can authenticate callbacks. Per-tenant secrets are only for custom workflows.
    if (!tenant.webhookSecret && config.n8n.inboundSecret) {
      tenant.webhookSecret = config.n8n.inboundSecret;
    }
    logger.info(`Auto-provisioned webhook URL for tenant ${tenantId}`);
  }
```

This goes immediately before the existing `await tenantRepo.save(tenant);` line.

- [ ] **Step 3: Commit**

```bash
git add api/src/knowledge/knowledge.controller.ts
git commit -m "feat: auto-provision webhook URL when tenant enables AI"
```

---

### Task 8: Update Default n8n Workflow with KB Fetch Node

**Files:**
- Create: `docs/n8n-workflows/chatbot-platform-v2-brain.json`

- [ ] **Step 1: Create the updated workflow JSON**

Create `chatbot-platform/docs/n8n-workflows/chatbot-platform-v2-brain.json`. This is based on the existing `chatbot-platform-integration.json` but with these changes:

1. **Removed** Window Buffer Memory node
2. **Added** "Has Knowledge Base?" IF node after Send Typing Start
3. **Added** "Fetch KB Chunks" HTTP node that calls `/api/v1/internal/rag/search`
4. **Added** "Build System Prompt" Code node that assembles brand voice + guardrails + KB chunks from payload
5. **Updated** AI Agent node to use dynamic system prompt from payload instead of hardcoded
6. **Updated** conversation history from payload instead of memory node
7. **Updated** all callback HTTP nodes to use `$env.N8N_INBOUND_SECRET` in `X-Webhook-Secret` header instead of hardcoded secret

The key new nodes to add:

**"Has Knowledge Base?" node** (IF node after Send Typing Start):
```json
{
  "parameters": {
    "conditions": {
      "options": { "caseSensitive": true, "leftValue": "", "typeValidation": "strict", "version": 2 },
      "conditions": [{
        "id": "kb-check",
        "leftValue": "={{ $('Extract Message').item.json.knowledgeBase?.enabled }}",
        "rightValue": true,
        "operator": { "type": "boolean", "operation": "equals", "name": "filter.operator.equals" }
      }],
      "combinator": "and"
    }
  },
  "id": "wp-kb-check",
  "name": "Has Knowledge Base?",
  "type": "n8n-nodes-base.if",
  "typeVersion": 2.2,
  "position": [1100, 300]
}
```

**"Fetch KB Chunks" node** (HTTP Request on the "yes" branch):
```json
{
  "parameters": {
    "method": "POST",
    "url": "={{ $env.API_URL || 'http://localhost:3000' }}/api/v1/internal/rag/search",
    "sendHeaders": true,
    "headerParameters": {
      "parameters": [
        { "name": "Content-Type", "value": "application/json" },
        { "name": "Authorization", "value": "={{ 'Bearer ' + $env.RAG_INTERNAL_SECRET }}" }
      ]
    },
    "sendBody": true,
    "specifyBody": "json",
    "jsonBody": "={\n  \"tenantId\": \"{{ $('Extract Message').item.json.tenantId }}\",\n  \"query\": {{ JSON.stringify($('Extract Message').item.json.chatInput) }},\n  \"conversationHistory\": {{ JSON.stringify(($('Extract Message').item.json.previousMessages || []).map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content }))) }},\n  \"maxChunks\": 5\n}",
    "options": { "timeout": 10000 }
  },
  "id": "wp-fetch-kb",
  "name": "Fetch KB Chunks",
  "type": "n8n-nodes-base.httpRequest",
  "typeVersion": 4.2,
  "position": [1320, 200],
  "onError": "continueRegularOutput"
}
```

**"Build System Prompt" node** (Code node that merges KB chunks + brand voice from payload):
```json
{
  "parameters": {
    "jsCode": "const data = $('Extract Message').item.json;\nconst tc = data.tenantConfig || {};\nconst guardrails = tc.guardrails || {};\n\n// Get KB chunks if they were fetched\nlet kbContext = '';\ntry {\n  const kbResult = $('Fetch KB Chunks').item?.json;\n  if (kbResult?.chunks?.length > 0) {\n    kbContext = '\\n\\nKNOWLEDGE BASE CONTEXT:\\n' + kbResult.chunks.map(c => `[Source: ${c.title}] ${c.content}`).join('\\n\\n');\n  }\n} catch (e) {\n  // KB fetch was skipped or failed — no chunks available\n}\n\n// Build conversation history from payload\nconst history = (data.previousMessages || []).map(m => `${m.role === 'user' ? 'Customer' : 'Assistant'}: ${m.content}`).join('\\n');\n\nconst topicsToAvoid = (guardrails.topicsToAvoid || []).join(', ') || 'N/A';\nconst maxLen = guardrails.maxResponseLength || 500;\n\nconst systemPrompt = `You are ${tc.brandName || 'a helpful assistant'}.\nTone: ${tc.brandTone || 'professional'}\n${tc.systemPrompt || ''}\n\nRules:\n- If you have knowledge context below, use it to answer. If not, use your general knowledge.\n- Never discuss: ${topicsToAvoid}\n- Max response: ${maxLen} characters\n- If unsure, say so honestly\n- Match the customer's language\n\nESCALATION RULES:\nIf any of these are true, prefix your response with [HANDOFF:reason]:\n- The customer explicitly asks for a human agent\n- You cannot answer their question with confidence\n- The customer is frustrated and needs personal attention\n- The topic involves billing, refunds, or account security\n\nStill provide a helpful message after the [HANDOFF:reason] tag.${kbContext}`;\n\nreturn [{ json: { systemPrompt, chatInput: data.chatInput, sessionId: data.sessionId, tenantId: data.tenantId, history } }];"
  },
  "id": "wp-build-prompt",
  "name": "Build System Prompt",
  "type": "n8n-nodes-base.code",
  "typeVersion": 2,
  "position": [1540, 300]
}
```

**Updated AI Agent node** — uses `Build System Prompt` output:
```json
{
  "parameters": {
    "promptType": "define",
    "text": "={{ $('Build System Prompt').item.json.chatInput }}",
    "options": {
      "systemMessage": "={{ $('Build System Prompt').item.json.systemPrompt }}",
      "maxIterations": 10
    }
  },
  "id": "wp-ai-agent",
  "name": "AI Agent",
  "type": "@n8n/n8n-nodes-langchain.agent",
  "typeVersion": 1.7,
  "position": [1760, 300]
}
```

**Updated Extract Message node** — also parse new payload fields (add to the end of the existing jsCode):
```javascript
// Parse new n8n-as-brain fields
const tenantConfig = body.tenantConfig || null;
const knowledgeBase = body.knowledgeBase || { enabled: false, documentCount: 0 };
const previousMessages = context.previousMessages || [];

// ... in the return object, add:
// tenantConfig,
// knowledgeBase,
// previousMessages,
```

**Connections update:**
- Send Typing Start → Has Knowledge Base?
- Has Knowledge Base? (yes) → Fetch KB Chunks → Build System Prompt
- Has Knowledge Base? (no) → Build System Prompt
- Build System Prompt → AI Agent
- Remove: Window Buffer Memory → AI Agent connection
- Remove: Window Buffer Memory node entirely

- [ ] **Step 2: Commit**

```bash
git add chatbot-platform/docs/n8n-workflows/chatbot-platform-v2-brain.json
git commit -m "feat: add v2 n8n workflow with KB fetch and dynamic brand voice"
```

---

### Task 9: Mount RAG Search Route Outside Webhook Try Block

**Files:**
- Modify: `api/src/server.ts`

The current plan (Task 3) mounts `/internal/rag` inside the webhook module's `try` block. If webhook module initialization fails, the RAG endpoint disappears even though it's independent. Move it outside.

- [ ] **Step 1: Move the RAG route mount**

In `api/src/server.ts`, move the RAG search route mount from inside the webhook `try` block to after it (around line 241, after the webhook try/catch closes):

```typescript
    // Internal RAG search endpoint for n8n (independent of webhook module)
    apiRouter.use('/internal/rag', ragSearchRoutes);
```

- [ ] **Step 2: Commit**

```bash
git add api/src/server.ts
git commit -m "fix: mount RAG search route independently of webhook module"
```

---

### Task 10: End-to-End Smoke Test

- [ ] **Step 1: Set environment variables**

Add to your `.env`:

```
N8N_DEFAULT_WEBHOOK_URL=http://localhost:5678/webhook/chatbot-platform
RAG_INTERNAL_SECRET=test-secret-for-dev
```

- [ ] **Step 2: Import the v2 workflow into n8n**

1. Open n8n at `http://localhost:5678`
2. Go to Workflows → Import
3. Upload `docs/n8n-workflows/chatbot-platform-v2-brain.json`
4. Set environment variables in n8n: `API_URL=http://host.docker.internal:3000`, `RAG_INTERNAL_SECRET=test-secret-for-dev`
5. Activate the workflow

- [ ] **Step 3: Test the happy path — KB question**

1. Open the chat widget for a tenant with AI enabled and documents uploaded
2. Ask a question that matches KB content (e.g., "What is your return policy?")
3. **Expected:** Bot responds with answer from KB, sourced through n8n → RAG search → AI agent

- [ ] **Step 4: Test the happy path — general question (no KB match)**

1. Ask something unrelated to KB (e.g., "Tell me a joke")
2. **Expected:** Bot responds with general AI answer (n8n AI agent handles it without KB chunks)

- [ ] **Step 5: Test escalation**

1. Type "I want to speak to a human"
2. **Expected:** Escalation keyword caught by platform pre-check → handoff triggered, never reaches n8n

- [ ] **Step 6: Test n8n down — RAG fallback**

1. Deactivate the n8n workflow (or stop n8n)
2. Send a KB-related question
3. **Expected:** Platform detects n8n failure → falls back to native RAG → responds from KB
4. Re-activate the n8n workflow

- [ ] **Step 7: Test n8n down — no KB fallback**

1. Deactivate n8n
2. Send a message to a tenant with NO documents uploaded
3. **Expected:** Fallback message + handoff to human

- [ ] **Step 8: Test auto-provisioning**

1. Create a tenant with no `webhookUrl` configured
2. Enable AI via the dashboard (PATCH `/api/v1/tenants/me/ai-settings` with `{ "enabled": true }`)
3. **Expected:** Tenant's `webhookUrl` is automatically set to `N8N_DEFAULT_WEBHOOK_URL`

- [ ] **Step 9: Commit any test fixes**

If any issues are found during smoke testing, fix and commit each one separately.

---

## Summary

| Task | Description | Additive? |
|------|-------------|-----------|
| 1 | Env config (RAG_INTERNAL_SECRET, N8N_DEFAULT_WEBHOOK_URL, N8N_INBOUND_SECRET) | Yes |
| 2 | Extract `searchKnowledge()` from rag.service.ts | Yes |
| 3 | Create RAG search endpoint + mount in server.ts | Yes |
| 4 | Extend OutboundMessage types + JSON schema | Yes |
| 5 | Enrich outbound payload with tenant config + KB metadata helpers | Yes |
| 6 | **Rewrite message-forwarding (core change)** | Breaking |
| 7 | Auto-set webhookUrl + webhookSecret when AI enabled | Yes |
| 8 | Updated n8n workflow JSON (KB fetch, dynamic brand voice, shared secret) | Yes |
| 9 | Mount RAG route independently of webhook module | Yes |
| 10 | End-to-end smoke test | N/A |

Tasks 1-5 and 7-9 are additive (no breaking changes). Task 6 is the cutover — deploy it alongside the updated n8n workflow (Task 8).

**Note:** The n8n inbound webhook path is `/api/v1/webhooks/inbound` (mounted via `apiRouter.use('/webhooks', webhookModule.router)` in server.ts:232), not `/api/v1/n8n/webhook/inbound`.
