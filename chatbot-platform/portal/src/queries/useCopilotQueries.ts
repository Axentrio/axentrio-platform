/**
 * React Query SDK for the Copilot endpoints.
 *
 * Three hooks:
 *
 *   - useCopilotConversation()
 *       GET /copilot/conversation — returns the active transcript.
 *       Cached for 30s; refetched on window focus.
 *
 *   - useClearCopilotConversation()
 *       POST /copilot/conversation/clear. Invalidates the transcript
 *       query so the drawer rerenders an empty state immediately.
 *
 *   - useSendCopilotMessageHandler()
 *       NOT a useMutation — message sends use the SSE generator
 *       directly so the consumer can render tokens as they arrive.
 *       This factory returns a function that runs one streamed turn,
 *       wires the events to React state callbacks, and (on success)
 *       invalidates the transcript query so the persisted pair shows
 *       up on the next mount.
 */
import { useCallback } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@clerk/clerk-react';
import { api } from '../services/apiClient';
import { queryKeys } from './queryKeys';
import { streamCopilotMessages, type CopilotSseEvent } from '../copilot/sse-client';

export type CopilotMessageRole = 'user' | 'assistant';

export interface CopilotToolBadge {
  name: string;
  outcome: 'success' | 'error';
}

export interface CopilotUserMessage {
  id: string;
  turn: number;
  role: 'user';
  content: string;
  createdAt: string;
}

export interface CopilotAssistantMessage {
  id: string;
  turn: number;
  role: 'assistant';
  content: string;
  toolsCalled: CopilotToolBadge[];
  outcome: 'pending' | 'success' | 'aborted' | 'error' | 'agent_loop_exceeded' | null;
  tokensIn: number | null;
  tokensOut: number | null;
  latencyMs: number | null;
  createdAt: string;
}

export type CopilotConversationMessage = CopilotUserMessage | CopilotAssistantMessage;

export interface CopilotConversationResponse {
  conversationId: string | null;
  messages: CopilotConversationMessage[];
  nextCursor: number | null;
}

interface ApiEnvelope<T> {
  success: true;
  data: T;
}

const THIRTY_SECONDS_MS = 30 * 1000;

export function useCopilotConversation() {
  return useQuery({
    queryKey: queryKeys.copilot.conversation(),
    queryFn: async () => {
      const env = await api.get<ApiEnvelope<CopilotConversationResponse>>(
        '/copilot/conversation',
      );
      return env.data;
    },
    staleTime: THIRTY_SECONDS_MS,
  });
}

export function useClearCopilotConversation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const env = await api.post<ApiEnvelope<{ cleared: true }>>(
        '/copilot/conversation/clear',
      );
      return env.data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.copilot.conversation() });
    },
  });
}

export interface SendMessageCallbacks {
  /** Each `token` event arrives as a delta — append to the in-flight assistant content. */
  onToken: (delta: string) => void;
  /** A tool call started. */
  onToolStart: (name: string) => void;
  /** A tool call ended. */
  onToolEnd: (name: string, outcome: 'success' | 'error') => void;
  /** Terminal `complete` event with usage stats. */
  onComplete: (data: {
    turnId: string;
    conversationId: string;
    tokensIn: number;
    tokensOut: number;
    latencyMs: number;
  }) => void;
  /** Terminal `error` event from the stream itself. */
  onStreamError: (code: 'llm_provider_rate_limit' | 'llm_error' | 'agent_loop_exceeded' | 'aborted') => void;
}

/**
 * Returns a function that sends one user message and consumes the
 * resulting SSE stream. Caller wires the typed callbacks to React
 * state.
 *
 * Aborts via the provided AbortSignal — drawer-close binds this to
 * an AbortController in the provider.
 */
export function useSendCopilotMessageHandler() {
  const qc = useQueryClient();
  const { getToken } = useAuth();

  return useCallback(
    async (
      args: {
        message: string;
        locale?: 'en' | 'nl' | 'fr';
        signal: AbortSignal;
      },
      cb: SendMessageCallbacks,
    ): Promise<void> => {
      try {
        for await (const event of streamCopilotMessages({
          ...args,
          getToken: () => getToken(),
        })) {
          if (args.signal.aborted) return;
          switch (event.event) {
            case 'token':
              cb.onToken(event.data.text);
              break;
            case 'tool_call_start':
              cb.onToolStart(event.data.name);
              break;
            case 'tool_call_end':
              cb.onToolEnd(event.data.name, event.data.outcome);
              break;
            case 'heartbeat':
              break;
            case 'error':
              cb.onStreamError(event.data.code);
              break;
            case 'complete':
              cb.onComplete(event.data);
              break;
            default:
              break;
          }
        }
      } finally {
        // Refresh the persisted transcript so the canonical row (with
        // toolsCalled, outcome, tokens, latency) shows up on next mount.
        qc.invalidateQueries({ queryKey: queryKeys.copilot.conversation() });
      }
    },
    [qc, getToken],
  );
}

// Re-export the event type so consumers don't need to import from
// the sse-client module directly.
export type { CopilotSseEvent };
