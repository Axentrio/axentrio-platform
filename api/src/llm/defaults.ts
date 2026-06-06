// Platform-wide LLM model/provider — the SINGLE source of truth.
//
// The platform standardises the AI model across all tenants/bots: provider and
// model are NOT tenant- or bot-configurable. Runtime LLM call sites always use
// these values (see agent.service, rag.service, the test-chat controllers).
// Change the model for the whole platform via PLATFORM_LLM_PROVIDER /
// PLATFORM_LLM_MODEL — the defaults preserve the prior behaviour.

const envProvider = (process.env.PLATFORM_LLM_PROVIDER || '').toLowerCase();
export const DEFAULT_PROVIDER: 'openai' | 'anthropic' =
  envProvider === 'anthropic' || envProvider === 'openai' ? envProvider : 'openai';

export const DEFAULT_MODEL = process.env.PLATFORM_LLM_MODEL || 'gpt-4o-mini';
