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

export async function generateResponse(
  dataSource: DataSource,
  tenantId: string,
  aiSettings: TenantAiSettings,
  customerMessage: string,
  conversationHistory: { role: 'user' | 'assistant'; content: string }[]
): Promise<RagResult> {
  logger.info(`[RAG] Query: "${customerMessage}" | tenant: ${tenantId} | minSimilarity: ${config.rag.minSimilarity}`);
  const queryEmbedding = await embed(customerMessage);
  const embeddingStr = `[${queryEmbedding.join(',')}]`;
  logger.info(`[RAG] Embedding generated, dimensions: ${queryEmbedding.length}`);

  const chunks: RetrievedChunk[] = await dataSource.query(
    `SELECT kc.id, kc.content, kc.metadata, kd.title,
            1 - (kc.embedding <=> $1::vector) AS similarity
     FROM knowledge_chunks kc
     JOIN knowledge_documents kd ON kd.id = kc."documentId"
     WHERE kc."tenantId" = $2
       AND kd.status = 'indexed'
       AND 1 - (kc.embedding <=> $1::vector) >= $3
     ORDER BY kc.embedding <=> $1::vector
     LIMIT $4`,
    [embeddingStr, tenantId, config.rag.minSimilarity, config.rag.maxContextChunks]
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
