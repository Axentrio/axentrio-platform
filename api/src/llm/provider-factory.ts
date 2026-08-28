import crypto from 'crypto';
import { LLMProvider, ChatMessage, LLMOptions, LLMResponse } from './llm.types';
import { OpenAIProvider } from './openai.provider';
import { AnthropicProvider } from './anthropic.provider';
import { config } from '../config/environment';
import { decrypt } from '../utils/encryption';
import { checkAndIncrement } from './llm-rate-limit';
import { DEFAULT_PROVIDER } from './defaults';
import { recordLlmUsage } from './usage-recorder';
import type { LlmCallPath } from './pricing';

const providerCache = new Map<string, LLMProvider>();

export function getProvider(opts: {
  provider?: 'openai' | 'anthropic';
  encryptedApiKey?: string;
  rawApiKey?: string;
  /** Tenant the spend is attributed to. Omit only for platform work with no tenant. */
  tenantId?: string;
  /** Apply the per-tenant daily LLM CALL cap. Requires tenantId. */
  enforceDailyCap?: boolean;
  dailyCapOverride?: number | null;
  path: LlmCallPath;
}): LLMProvider {
  const provider = opts.provider ?? DEFAULT_PROVIDER;
  const base = getBaseProvider(provider, opts.encryptedApiKey, opts.rawApiKey);
  return {
    async chat(messages: ChatMessage[], options: LLMOptions): Promise<LLMResponse> {
      if (opts.enforceDailyCap && opts.tenantId) {
        await checkAndIncrement(opts.tenantId, opts.dailyCapOverride);
      }
      const res = await base.chat(messages, options);
      await recordLlmUsage({
        tenantId: opts.tenantId,
        path: opts.path,
        model: options.model,
        usage: res.usage,
      });
      return res;
    },
  };
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
