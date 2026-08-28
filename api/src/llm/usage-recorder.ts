import { AppDataSource } from '../database/data-source';
import { PLATFORM_TENANT_SENTINEL } from '../database/entities/LlmUsageDaily';
import { logger } from '../utils/logger';
import { costUsd, type LlmCallPath } from './pricing';

export async function recordLlmUsage(input: {
  tenantId?: string;
  path: LlmCallPath;
  model: string;
  usage: { promptTokens: number; completionTokens: number };
}): Promise<void> {
  try {
    const tenantId = input.tenantId || PLATFORM_TENANT_SENTINEL;
    const usd = costUsd(input.model, input.usage);
    // pi-lens-ignore: ast-grep:no-sql-in-code
    await AppDataSource.query(
      `INSERT INTO llm_usage_daily
         (day, tenant_id, path, model, calls, prompt_tokens, completion_tokens, cost_usd)
       VALUES
         (CURRENT_DATE, $1, $2, $3, 1, $4, $5, $6)
       ON CONFLICT (day, tenant_id, path, model) DO UPDATE SET
         calls = llm_usage_daily.calls + 1,
         prompt_tokens = llm_usage_daily.prompt_tokens + EXCLUDED.prompt_tokens,
         completion_tokens = llm_usage_daily.completion_tokens + EXCLUDED.completion_tokens,
         cost_usd = llm_usage_daily.cost_usd + EXCLUDED.cost_usd`,
      [
        tenantId,
        input.path,
        input.model,
        input.usage.promptTokens,
        input.usage.completionTokens,
        usd,
      ],
    );
  } catch (error) {
    logger.warn('Failed to record LLM usage', {
      tenantId: input.tenantId,
      path: input.path,
      model: input.model,
      error,
    });
  }
}
