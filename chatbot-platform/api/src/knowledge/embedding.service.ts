import OpenAI from 'openai';
import { config } from '../config/environment';
import { logger } from '../utils/logger';

const EMBEDDING_MODEL = 'text-embedding-3-large';
const EMBEDDING_DIMENSIONS = 1536; // Reduced from 3072 for pgvector HNSW index compatibility
const MAX_INPUT_CHARS = 32000;

let openaiClient: OpenAI | null = null;

function getClient(): OpenAI {
  if (!openaiClient) {
    if (!config.rag.openaiApiKey) {
      throw new Error('OPENAI_API_KEY is required for embeddings');
    }
    openaiClient = new OpenAI({ apiKey: config.rag.openaiApiKey });
  }
  return openaiClient;
}

export async function embed(text: string): Promise<number[]> {
  const truncated = text.slice(0, MAX_INPUT_CHARS);
  const client = getClient();
  const response = await client.embeddings.create({
    model: EMBEDDING_MODEL,
    input: truncated,
    dimensions: EMBEDDING_DIMENSIONS,
  });
  return response.data[0].embedding;
}

export async function embedBatch(texts: string[]): Promise<number[][]> {
  const client = getClient();
  const batchSize = config.rag.embeddingBatchSize;
  const results: number[][] = [];

  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize).map((t) => t.slice(0, MAX_INPUT_CHARS));
    const response = await client.embeddings.create({
      model: EMBEDDING_MODEL,
      input: batch,
      dimensions: EMBEDDING_DIMENSIONS,
    });
    for (const item of response.data) {
      results.push(item.embedding);
    }
    logger.debug(`Embedded batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(texts.length / batchSize)}`);
  }

  return results;
}
