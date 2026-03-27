import { LLMProvider } from './llm.types';
import { OpenAIProvider } from './openai.provider';
import { AnthropicProvider } from './anthropic.provider';
import { config } from '../config/environment';
import { decrypt } from '../utils/encryption';

const providerCache = new Map<string, LLMProvider>();

export function getProvider(
  provider: 'openai' | 'anthropic',
  encryptedApiKey?: string
): LLMProvider {
  let apiKey: string;

  if (encryptedApiKey) {
    apiKey = decrypt(encryptedApiKey);
  } else if (provider === 'openai') {
    if (!config.rag.openaiApiKey) throw new Error('OPENAI_API_KEY not configured');
    apiKey = config.rag.openaiApiKey;
  } else {
    if (!config.rag.anthropicApiKey) throw new Error('ANTHROPIC_API_KEY not configured');
    apiKey = config.rag.anthropicApiKey;
  }

  const cacheKey = `${provider}:${apiKey.slice(-8)}`;
  const cached = providerCache.get(cacheKey);
  if (cached) return cached;

  const instance = provider === 'openai'
    ? new OpenAIProvider(apiKey)
    : new AnthropicProvider(apiKey);

  providerCache.set(cacheKey, instance);
  return instance;
}
