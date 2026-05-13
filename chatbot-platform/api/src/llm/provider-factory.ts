import crypto from 'crypto';
import { LLMProvider, ChatMessage, LLMOptions, LLMResponse } from './llm.types';
import { OpenAIProvider } from './openai.provider';
import { AnthropicProvider } from './anthropic.provider';
import { config } from '../config/environment';
import { decrypt } from '../utils/encryption';
import { checkAndIncrement } from './llm-rate-limit';

const providerCache = new Map<string, LLMProvider>();

/**
 * Returns an LLMProvider for the given provider key.
 *
 * When `tenantId` is supplied, the returned provider is wrapped so that
 * every `chat()` call first consults the per-tenant daily LLM rate limit
 * (see ./llm-rate-limit.ts). On limit reached the wrapper throws an
 * LlmRateLimitError, which the global error handler serializes as HTTP 429.
 *
 * Callers without a tenant context (e.g. internal utility calls) may omit
 * tenantId — those calls bypass the per-tenant cap. Future passes should
 * thread tenantId through agent.service.ts and knowledge.controller's
 * testChat path so the cap covers every LLM exit point.
 */
export function getProvider(
  provider: 'openai' | 'anthropic',
  encryptedApiKey?: string,
  rawApiKey?: string,
  tenantId?: string,
  tenantLimitOverride?: number | null,
): LLMProvider {
  const base = getBaseProvider(provider, encryptedApiKey, rawApiKey);
  if (!tenantId) return base;
  return wrapWithRateLimit(base, tenantId, tenantLimitOverride);
}

function getBaseProvider(
  provider: 'openai' | 'anthropic',
  encryptedApiKey?: string,
  rawApiKey?: string,
): LLMProvider {
  let apiKey: string;

  if (rawApiKey) {
    apiKey = rawApiKey;
  } else if (encryptedApiKey) {
    apiKey = decrypt(encryptedApiKey);
  } else if (provider === 'openai') {
    if (!config.rag.openaiApiKey) throw new Error('OPENAI_API_KEY not configured');
    apiKey = config.rag.openaiApiKey;
  } else {
    if (!config.rag.anthropicApiKey) throw new Error('ANTHROPIC_API_KEY not configured');
    apiKey = config.rag.anthropicApiKey;
  }

  const keyHash = crypto.createHash('sha256').update(apiKey).digest('hex').slice(0, 16);
  const cacheKey = `${provider}:${keyHash}`;
  const cached = providerCache.get(cacheKey);
  if (cached) return cached;

  const instance = provider === 'openai'
    ? new OpenAIProvider(apiKey)
    : new AnthropicProvider(apiKey);

  providerCache.set(cacheKey, instance);
  return instance;
}

/**
 * Decorate an LLMProvider so chat() checks the per-tenant daily cap first.
 * The wrapper is intentionally NOT cached — the tenantId differs per request
 * and the underlying base provider IS cached, so this is cheap.
 */
function wrapWithRateLimit(
  base: LLMProvider,
  tenantId: string,
  tenantLimitOverride?: number | null,
): LLMProvider {
  return {
    async chat(messages: ChatMessage[], options: LLMOptions): Promise<LLMResponse> {
      // Throws LlmRateLimitError on cap reached; fails open on Redis errors.
      await checkAndIncrement(tenantId, tenantLimitOverride);
      return base.chat(messages, options);
    },
  };
}
