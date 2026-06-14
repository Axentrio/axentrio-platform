// Thin compatibility shim over the consolidated composer.
//
// All prompt composition now lives in compose-system-prompt.ts. This file keeps
// the long-standing `buildSystemPrompt` / `substituteVariables` import surface
// stable for existing callers (rag.service, knowledge/bot-ai-settings
// controllers, message-forwarding, the agent builder).
//
// `buildSystemPrompt` composes a tenant's `brandVoice.customInstructions`
// BETWEEN a platform-controlled preamble and a platform-controlled rules block,
// so tenant text never replaces the full system prompt — preventing guardrail
// bypass via "ignore previous instructions" pasted into customInstructions.

import type { Tenant } from '../database/entities/Tenant';
import { composeSystemPrompt, substituteVariables } from './compose-system-prompt';

export { substituteVariables };

type AiSettings = NonNullable<Tenant['settings']>['ai'];

export function buildSystemPrompt(
  ai: NonNullable<AiSettings>,
  extras?: { businessName?: string }
): string {
  return composeSystemPrompt({ mode: 'base', ai, businessName: extras?.businessName });
}
