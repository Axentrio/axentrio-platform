import OpenAI from 'openai';
import { DataSource } from 'typeorm';
import { embed } from '../knowledge/embedding.service';
import { getProvider } from './provider-factory';
import { ChatMessage } from './llm.types';
import { config } from '../config/environment';
import { logger } from '../utils/logger';
import { buildSystemPrompt } from './prompt-builder';
import { DEFAULT_PROVIDER, DEFAULT_MODEL } from './defaults';

interface TenantAiSettings {
  provider?: 'openai' | 'anthropic' | null;
  model?: string | null;
  apiKey?: string | null;
  supportEmail?: string | null;
  brandVoice: {
    name: string;
    tone: string;
    customInstructions: string;
  };
  guardrails: {
    topicsToAvoid: string[];
    escalationKeywords?: string[];
    confidenceThreshold: number;
    maxResponseLength: number;
    greetingMessage?: string;
    fallbackMessage: string;
    offHoursMessage?: string;
  };
}

interface RetrievedChunk {
  id: string;
  content: string;
  title: string;
  similarity: number;
  metadata: Record<string, any>;
}

export interface RagResult {
  response: string;
  confidence: number;
  shouldHandoff: boolean;
  handoffReason?: string;
  chunks: RetrievedChunk[];
}

/**
 * Rewrite a follow-up query using conversation history so the embedding
 * search can find relevant chunks even for contextual questions like
 * "what about the battery life?" (after discussing a specific product).
 */
async function rewriteQuery(
  message: string,
  history: { role: 'user' | 'assistant'; content: string }[]
): Promise<string> {
  if (history.length === 0) return message;

  try {
    const openai = new OpenAI({ apiKey: config.rag.openaiApiKey });
    const historyText = history
      .slice(-4) // last 2 exchanges max
      .map((m) => `${m.role}: ${m.content}`)
      .join('\n');

    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: 'Rewrite the user\'s latest message as a standalone search query that includes all necessary context from the conversation. Output ONLY the rewritten query, nothing else. If the message is already self-contained, return it unchanged.',
        },
        {
          role: 'user',
          content: `Conversation:\n${historyText}\n\nLatest message: ${message}`,
        },
      ],
      temperature: 0,
      max_tokens: 150,
    });

    const rewritten = response.choices[0]?.message?.content?.trim();
    if (rewritten && rewritten !== message) {
      logger.info(`[RAG] Query rewritten: "${message}" → "${rewritten}"`);
      return rewritten;
    }
    return message;
  } catch (err) {
    logger.warn('[RAG] Query rewrite failed, using original', err);
    return message;
  }
}

/**
 * Search knowledge base for relevant chunks — used by the internal RAG search endpoint.
 * Search only: no LLM call, no prompt construction, no confidence scoring.
 */
export async function searchKnowledge(
  dataSource: DataSource,
  tenantId: string,
  query: string,
  conversationHistory: { role: 'user' | 'assistant'; content: string }[],
  maxChunks: number = config.rag.maxContextChunks,
  // Multi-bot RAG scoping. `undefined` → tenant-wide (legacy behaviour);
  // a list → restrict to those KnowledgeBases; `[]` → the bot has no knowledge
  // attached, so retrieve nothing (no tenant-wide fallback — see I12).
  knowledgeBaseIds?: string[]
): Promise<{ chunks: RetrievedChunk[]; totalChunks: number }> {
  if (knowledgeBaseIds !== undefined && knowledgeBaseIds.length === 0) {
    logger.info(`[RAG Search] Bot has no attached KnowledgeBases | tenant: ${tenantId} — returning no chunks`);
    return { chunks: [], totalChunks: 0 };
  }

  const searchQuery = await rewriteQuery(query, conversationHistory);
  logger.info(`[RAG Search] Query: "${searchQuery}" | tenant: ${tenantId}`);

  const queryEmbedding = await embed(searchQuery);
  const embeddingStr = `[${queryEmbedding.join(',')}]`;

  const params: unknown[] = [embeddingStr, tenantId, config.rag.minSimilarity, maxChunks, searchQuery];
  let kbClause = '';
  if (knowledgeBaseIds !== undefined) {
    params.push(knowledgeBaseIds);
    kbClause = ` AND kd."knowledgeBaseId" = ANY($${params.length}::uuid[])`;
  }

  const chunks: RetrievedChunk[] = await dataSource.query(
    `SELECT kc.id, kc.content, kc.metadata, kd.title,
            1 - (kc.embedding <=> $1::vector) AS similarity,
            ts_rank(kc.tsv, websearch_to_tsquery('english', $5)) AS keyword_rank
     FROM knowledge_chunks kc
     JOIN knowledge_documents kd ON kd.id = kc."documentId"
     WHERE kc."tenantId" = $2
       AND kd.status = 'indexed'${kbClause}
       AND (
         1 - (kc.embedding <=> $1::vector) >= $3
         OR kc.tsv @@ websearch_to_tsquery('english', $5)
       )
     ORDER BY (1 - (kc.embedding <=> $1::vector)) + ts_rank(kc.tsv, websearch_to_tsquery('english', $5)) * 0.5 DESC
     LIMIT $4`,
    params
  );

  logger.info(`[RAG Search] Retrieved ${chunks.length} chunks${chunks.length > 0 ? `, top similarity: ${chunks[0]?.similarity}` : ''}`);

  return { chunks, totalChunks: chunks.length };
}

export async function generateResponse(
  dataSource: DataSource,
  tenantId: string,
  aiSettings: TenantAiSettings,
  customerMessage: string,
  conversationHistory: { role: 'user' | 'assistant'; content: string }[],
  // Multi-bot RAG scoping. `undefined` → tenant-wide (legacy); a list →
  // restrict to those KnowledgeBases; `[]` → no attached knowledge (I12).
  knowledgeBaseIds?: string[]
): Promise<RagResult> {
  const noKnowledge = knowledgeBaseIds !== undefined && knowledgeBaseIds.length === 0;

  // Rewrite contextual follow-ups into standalone queries
  const searchQuery = await rewriteQuery(customerMessage, conversationHistory);
  logger.info(`[RAG] Query: "${searchQuery}" | tenant: ${tenantId} | minSimilarity: ${config.rag.minSimilarity}`);
  const queryEmbedding = await embed(searchQuery);
  const embeddingStr = `[${queryEmbedding.join(',')}]`;
  logger.info(`[RAG] Embedding generated, dimensions: ${queryEmbedding.length}`);

  // Hybrid search: combine vector similarity with keyword matching
  // Vector similarity is the primary signal; keyword match boosts chunks
  // that contain exact terms the user searched for (fixes "IPX7", phone numbers, etc.)
  const params: unknown[] = [embeddingStr, tenantId, config.rag.minSimilarity, config.rag.maxContextChunks, searchQuery];
  let kbClause = '';
  if (knowledgeBaseIds !== undefined) {
    params.push(knowledgeBaseIds);
    kbClause = ` AND kd."knowledgeBaseId" = ANY($${params.length}::uuid[])`;
  }

  const chunks: RetrievedChunk[] = noKnowledge ? [] : await dataSource.query(
    `SELECT kc.id, kc.content, kc.metadata, kd.title,
            1 - (kc.embedding <=> $1::vector) AS similarity,
            ts_rank(kc.tsv, websearch_to_tsquery('english', $5)) AS keyword_rank
     FROM knowledge_chunks kc
     JOIN knowledge_documents kd ON kd.id = kc."documentId"
     WHERE kc."tenantId" = $2
       AND kd.status = 'indexed'${kbClause}
       AND (
         1 - (kc.embedding <=> $1::vector) >= $3
         OR kc.tsv @@ websearch_to_tsquery('english', $5)
       )
     ORDER BY (1 - (kc.embedding <=> $1::vector)) + ts_rank(kc.tsv, websearch_to_tsquery('english', $5)) * 0.5 DESC
     LIMIT $4`,
    params
  );

  logger.info(`[RAG] Retrieved ${chunks.length} chunks${chunks.length > 0 ? `, top similarity: ${chunks[0]?.similarity}` : ''}`);

  if (chunks.length === 0) {
    logger.warn(`[RAG] No chunks found — returning fallback`);
    return {
      response: aiSettings.guardrails.fallbackMessage,
      confidence: 0,
      shouldHandoff: true,
      handoffReason: 'bot_no_knowledge',
      chunks: [],
    };
  }

  const knowledgeContext = chunks
    .map((c) => `[Source: ${c.title}] ${c.content}`)
    .join('\n\n');

  const historyText = conversationHistory
    .slice(-config.rag.conversationHistoryLimit)
    .map((m) => `${m.role === 'user' ? 'Customer' : 'Assistant'}: ${m.content}`)
    .join('\n');

  const basePrompt = buildSystemPrompt(aiSettings as any);
  const systemPrompt = `${basePrompt}

RAG Rules (enforced by the system):
- Only answer using the provided knowledge context
- If unsure, say so honestly

You MUST respond in this exact JSON format:
{ "response": "your answer here", "confidence": 0.85 }
where confidence is 0.0-1.0

KNOWLEDGE CONTEXT:
${knowledgeContext}`;

  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
  ];

  if (historyText) {
    messages.push({ role: 'user', content: `Previous conversation:\n${historyText}` });
    messages.push({ role: 'assistant', content: 'Understood, I have the conversation context.' });
  }

  messages.push({ role: 'user', content: customerMessage });

  // Read per-tenant cap override (nullable). One indexed PK lookup; cheap.
  // If row missing or column null, the wrapper falls back to the env default
  // LLM_DAILY_LIMIT_PER_TENANT.
  const tenantOverride = await fetchTenantLimitOverride(dataSource, tenantId);
  // Multi-bot Phase 4 (#16d) — DELIBERATE: `aiSettings.apiKey` is the LLM
  // provider secret which STAYS on Tenant.settings.ai.apiKey by architectural
  // rule (see bot-config.service.ts header). Callers of generateResponse pass
  // a merged shape carrying the apiKey alongside the behavioural slice; we
  // pluck the secret from there to seed the provider. NEVER move this read
  // to bot.settings.ai.apiKey — that key is never set there.
  // Model/provider are platform-standardised — always the platform default.
  const provider = getProvider(
    DEFAULT_PROVIDER,
    aiSettings.apiKey ?? undefined,
    undefined,
    tenantId,
    tenantOverride,
  );
  // chat() will throw LlmRateLimitError → HTTP 429 if the daily cap is reached.
  const llmResponse = await provider.chat(messages, {
    model: DEFAULT_MODEL,
    maxTokens: 1000,
    temperature: 0.3,
    jsonMode: true,
  });

  let response: string;
  let confidence: number;

  try {
    const parsed = JSON.parse(llmResponse.content);
    response = parsed.response || '';
    confidence = typeof parsed.confidence === 'number' ? parsed.confidence : 0;
  } catch {
    logger.warn('Failed to parse LLM JSON response, treating as low confidence');
    response = llmResponse.content;
    confidence = 0;
  }

  const shouldHandoff = confidence < aiSettings.guardrails.confidenceThreshold;
  logger.info(`[RAG] Confidence: ${confidence}, threshold: ${aiSettings.guardrails.confidenceThreshold}, handoff: ${shouldHandoff}`);

  return {
    response: shouldHandoff ? aiSettings.guardrails.fallbackMessage : response,
    confidence,
    shouldHandoff,
    handoffReason: shouldHandoff ? 'bot_confidence_low' : undefined,
    chunks,
  };
}

/**
 * Lightweight lookup of the per-tenant LLM call cap override.
 * Returns the column value (number) or null. Never throws — falls back to
 * null on any DB error so the env default applies.
 */
async function fetchTenantLimitOverride(
  dataSource: DataSource,
  tenantId: string,
): Promise<number | null> {
  try {
    const rows: Array<{ daily_llm_call_limit: number | null }> = await dataSource.query(
      'SELECT daily_llm_call_limit FROM tenants WHERE id = $1 LIMIT 1',
      [tenantId],
    );
    return rows[0]?.daily_llm_call_limit ?? null;
  } catch (err) {
    logger.warn('[RAG] Failed to read tenant LLM limit override, using env default', err);
    return null;
  }
}
