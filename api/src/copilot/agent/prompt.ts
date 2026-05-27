/**
 * Build the LLM message array for a single Copilot turn.
 *
 *  - System prompt: who Copilot is, hard rules, tool roster (names +
 *    return shapes), retrieved Snippet context block, failure-mode
 *    instruction, locale awareness.
 *  - Persisted history: last N messages from `chatbot_copilot_messages`,
 *    truncated head-first when total tokens exceed ~8000.
 *  - The user's new turn is NOT appended here — the agent loop adds it
 *    AFTER atomically persisting the user+assistant pair (the pair
 *    insert happens before the LLM call begins; the loop then assembles
 *    `[system, ...history, user]` for the first LLM iteration).
 *
 * Tenant-summary preload decision (round 1 #15): the system prompt
 * DOES NOT include the result of `getTenantSummary`. It mentions the
 * tool exists and what it returns; the LLM decides when to call it.
 * Keeps the system prompt small and lets each turn pay only for the
 * tool calls it actually needs.
 *
 * Round 2 token estimation: 4 chars ≈ 1 token. This is a hot-path
 * estimate, not a billing number — the actual count comes from the
 * LLM provider's `usage.promptTokens` after the call.
 */
import type { CopilotMessage } from '../../database/entities/CopilotMessage';
import type { CopilotTool } from '../tools/types';
import type { Snippet, Locale } from '../knowledge/types';
import type { CopilotLlmMessage } from './llm-stream';

const MAX_PROMPT_TOKENS = 8_000;
const CHARS_PER_TOKEN = 4;

export interface BuildPromptArgs {
  /** Past turns from `chatbot_copilot_messages`, ascending by turn. */
  history: CopilotMessage[];
  /** Retrieved snippets to ground the answer. May be empty. */
  snippets: Snippet[];
  /** All registered Copilot tools — roster goes into the system prompt. */
  tools: CopilotTool<any, any>[];
  /** The user's new turn text (will become the trailing `user` message). */
  newUserText: string;
  /** Locale the user wrote in; affects fallback-language disclosure. */
  requestedLocale: Locale;
}

export function buildCopilotPrompt(args: BuildPromptArgs): CopilotLlmMessage[] {
  const systemContent = renderSystemPrompt(args);

  const messages: CopilotLlmMessage[] = [{ role: 'system', content: systemContent }];

  // Replay history: each persisted row is either a user or an assistant.
  // We do NOT replay the assistant's tool_calls metadata — the LLM uses
  // tool_calls only within a single in-flight turn; previous turns'
  // tool calls are not relevant to the current decision.
  for (const m of args.history) {
    if (m.role === 'user') {
      messages.push({ role: 'user', content: m.content });
    } else {
      // Assistant rows whose `outcome` is `pending` / `aborted` /
      // `error` / `agent_loop_exceeded` may have incomplete content —
      // we still include whatever was streamed so the LLM sees the
      // conversation shape. Empty assistant content becomes a
      // placeholder string so the OpenAI API doesn't reject it.
      messages.push({
        role: 'assistant',
        content: m.content || '[no reply]',
      });
    }
  }

  messages.push({ role: 'user', content: args.newUserText });

  // Token budget: 4-char heuristic. If we're over budget, drop oldest
  // history entries (we leave the system prompt + the trailing user
  // turn untouched).
  return truncateToTokenBudget(messages, MAX_PROMPT_TOKENS);
}

export function renderSystemPrompt(args: BuildPromptArgs): string {
  const localeNote =
    args.snippets.length > 0 && args.snippets[0].locale !== args.requestedLocale
      ? `\n\nThe user wrote in '${args.requestedLocale}', but the platform documentation we found is in '${args.snippets[0].locale}'. ` +
        `Reply in '${args.requestedLocale}' if you can; if you must quote our documentation verbatim, you may keep that phrase in its original language and translate the surrounding answer.`
      : '';

  const snippetBlock =
    args.snippets.length === 0
      ? '\n\n(No platform documentation matched this query. Lean on your tool roster — call a read-state tool if it would answer the question — and otherwise tell the user you do not know.)'
      : '\n\nPlatform documentation snippets (most relevant first):\n' +
        args.snippets
          .map(
            (s, i) =>
              `[${i + 1}] ${s.title} (slug=${s.slug}, locale=${s.locale}):\n${s.excerpt}`,
          )
          .join('\n\n');

  const toolRoster =
    args.tools.length === 0
      ? '\n\n(No tools registered.)'
      : '\n\nAvailable tools (call one when the question is about THIS tenant\'s state, not platform documentation):\n' +
        args.tools.map((t) => `- ${t.name}: ${t.description}`).join('\n');

  return (
    'You are Copilot, the in-portal AI assistant for the Axentrio chatbot platform. ' +
    'You answer questions from tenant administrators about HOW the platform works (configuration, features, billing, troubleshooting) and about THEIR OWN tenant state via read-only tools.\n\n' +
    'Hard rules:\n' +
    '- You are READ-ONLY. You CANNOT change settings, connect integrations, modify billing, or take any action on the user\'s behalf. When asked to do something, explain how the user can do it themselves.\n' +
    '- You only see and discuss the CALLING tenant. Refuse questions about other tenants.\n' +
    '- You never reveal API keys, webhook secrets, OAuth tokens, Stripe customer or subscription IDs, payment instruments, or any visitor PII (names, emails, phones, raw transcripts).\n' +
    '- The tool roster returns aggregates only — never quote raw rows or PII from a tool result, only the aggregate facts.\n' +
    '- If neither the platform documentation snippets nor the tool results contain the answer, say so plainly. Do NOT invent.\n' +
    '- If `getKnownGapTopics` returns `sourceAvailable: false`, tell the user "I can\'t access Gap data on this account."\n' +
    '- Keep replies brief — admins are usually doing something else; one to three sentences plus a concrete next step beats a long essay.' +
    localeNote +
    snippetBlock +
    toolRoster
  );
}

function approxTokens(message: CopilotLlmMessage): number {
  // Approx by character length; covers role+content overhead by adding
  // a flat 4-token frame per message (OpenAI's documented baseline).
  const contentLen = 'content' in message && typeof message.content === 'string'
    ? message.content.length
    : 0;
  return Math.ceil(contentLen / CHARS_PER_TOKEN) + 4;
}

export function truncateToTokenBudget(
  messages: CopilotLlmMessage[],
  budget: number,
): CopilotLlmMessage[] {
  // Always keep system + final user message; trim from the middle
  // (oldest first) until we fit.
  if (messages.length <= 2) return messages;

  const system = messages[0];
  const finalUser = messages[messages.length - 1];
  const middle = messages.slice(1, -1);

  let total = approxTokens(system) + approxTokens(finalUser);
  total += middle.reduce((acc, m) => acc + approxTokens(m), 0);
  if (total <= budget) return messages;

  // Drop oldest middle messages one by one until we fit. We trim in
  // PAIRS where possible (a user followed by its assistant) so the
  // LLM never sees a stranded user-with-no-reply or vice versa.
  const trimmed = [...middle];
  while (trimmed.length > 0 && total > budget) {
    const dropped = trimmed.shift()!;
    total -= approxTokens(dropped);
    // If the next-oldest is the paired assistant for the user we just
    // dropped, drop it too — preserves conversational shape.
    if (
      dropped.role === 'user' &&
      trimmed.length > 0 &&
      trimmed[0].role === 'assistant' &&
      total > budget * 0.9
    ) {
      const pair = trimmed.shift()!;
      total -= approxTokens(pair);
    }
  }
  return [system, ...trimmed, finalUser];
}
