import OpenAI from 'openai';
import { DataSource } from 'typeorm';
import { embed } from '../knowledge/embedding.service';
import { getProvider } from './provider-factory';
import { ChatMessage } from './llm.types';
import { config } from '../config/environment';
import { logger } from '../utils/logger';

interface TenantAiSettings {
  provider: 'openai' | 'anthropic';
  model: string;
  apiKey?: string;
  brandVoice: {
    name: string;
    tone: string;
    customInstructions: string;
  };
  guardrails: {
    topicsToAvoid: string[];
    confidenceThreshold: number;
    maxResponseLength: number;
    fallbackMessage: string;
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

export async function generateResponse(
  dataSource: DataSource,
  tenantId: string,
  aiSettings: TenantAiSettings,
  customerMessage: string,
  conversationHistory: { role: 'user' | 'assistant'; content: string }[]
): Promise<RagResult> {
  // Rewrite contextual follow-ups into standalone queries
  const searchQuery = await rewriteQuery(customerMessage, conversationHistory);
  logger.info(`[RAG] Query: "${searchQuery}" | tenant: ${tenantId} | minSimilarity: ${config.rag.minSimilarity}`);
  const queryEmbedding = await embed(searchQuery);
  const embeddingStr = `[${queryEmbedding.join(',')}]`;
  logger.info(`[RAG] Embedding generated, dimensions: ${queryEmbedding.length}`);

  // Hybrid search: combine vector similarity with keyword matching
  // Vector similarity is the primary signal; keyword match boosts chunks
  // that contain exact terms the user searched for (fixes "IPX7", phone numbers, etc.)
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
    [embeddingStr, tenantId, config.rag.minSimilarity, config.rag.maxContextChunks, searchQuery]
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

  const systemPrompt = `You are ${aiSettings.brandVoice.name}.
Tone: ${aiSettings.brandVoice.tone}
${aiSettings.brandVoice.customInstructions}

Rules:
- Only answer using the provided knowledge context
- Never discuss: ${aiSettings.guardrails.topicsToAvoid.join(', ') || 'N/A'}
- Max response: ${aiSettings.guardrails.maxResponseLength} characters
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

  const provider = getProvider(aiSettings.provider, aiSettings.apiKey);
  const llmResponse = await provider.chat(messages, {
    model: aiSettings.model,
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
