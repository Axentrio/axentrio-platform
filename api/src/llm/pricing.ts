import { logger } from '../utils/logger';

export const LLM_CALL_PATHS = [
  'agent_reply',
  'rag_generate',
  'rag_query_rewrite',
  'embed_query',
  'embed_ingest',
  'kb_preprocess',
  'doc_ocr',
  'localize',
  'insights_judge',
  'insights_topic_merge',
  'insights_gap_recommendation',
  'insights_digest',
  'lead_extract',
  'memory_extract',
  'copilot',
  'test_chat',
  'admin_template_preview',
  'health_probe',
] as const;

export type LlmCallPath = (typeof LLM_CALL_PATHS)[number];

interface ModelPrice {
  inputPerMillion: number;
  outputPerMillion: number;
}

/** Snapshot of OpenAI list prices, USD per 1M tokens, Aug 2026. Batch halves and Fast doubles every rate. */
export const MODEL_PRICES: Record<string, ModelPrice> = {
  'gpt-5.6-luna': { inputPerMillion: 0.2, outputPerMillion: 1.2 },
  'gpt-5.6-terra': { inputPerMillion: 2.0, outputPerMillion: 12.0 },
  'gpt-5.6-sol': { inputPerMillion: 5.0, outputPerMillion: 30.0 },
  'gpt-4o-mini': { inputPerMillion: 0.15, outputPerMillion: 0.6 },
  'gpt-4.1-mini': { inputPerMillion: 0.4, outputPerMillion: 1.6 },
  'text-embedding-3-large': { inputPerMillion: 0.13, outputPerMillion: 0 },
  'text-embedding-3-small': { inputPerMillion: 0.02, outputPerMillion: 0 },
};

const warnedUnknownModels = new Set<string>();

/** USD for one call. Unknown model → 0 plus one warn; cost telemetry must never throw on a live reply. */
export function costUsd(
  model: string,
  usage: { promptTokens: number; completionTokens: number },
): number {
  const price = MODEL_PRICES[model];
  if (!price) {
    if (!warnedUnknownModels.has(model)) {
      warnedUnknownModels.add(model);
      logger.warn('llm_cost_unknown_model', { model });
    }
    return 0;
  }
  const raw =
    (usage.promptTokens / 1_000_000) * price.inputPerMillion +
    (usage.completionTokens / 1_000_000) * price.outputPerMillion;
  return Math.round(raw * 1e6) / 1e6;
}
