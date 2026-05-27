/**
 * Drawer state + transcript state + send-handler for the Copilot.
 *
 * Single render site (App.tsx) so the drawer persists across
 * route navigation. Children components read state via
 * `useCopilotDrawer()`.
 *
 * State responsibilities:
 *   - Open/closed
 *   - In-flight assistant content (token-by-token append)
 *   - Tool-call badges as they arrive
 *   - Terminal-state suffix for an in-flight turn
 *   - Send / Retry / Clear handlers (drawer-close = abort)
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { toast } from 'sonner';
import {
  useSendCopilotMessageHandler,
  useClearCopilotConversation,
} from '../../queries/useCopilotQueries';
import {
  CopilotPlanGateError,
  CopilotRateLimitedError,
  CopilotApiError,
} from '../../copilot/sse-client';

export type CopilotInflightOutcome =
  | 'success'
  | 'aborted'
  | 'error'
  | 'agent_loop_exceeded';

export interface CopilotInflightAssistant {
  /** Tokens accumulated so far in the in-flight assistant turn. */
  content: string;
  /** Tool calls seen, in arrival order. */
  toolBadges: Array<{ name: string; outcome: 'success' | 'error' | 'in_flight' }>;
  /** Terminal state once the stream completes; null while streaming. */
  outcome: CopilotInflightOutcome | null;
}

export interface CopilotInflightTurn {
  /** Echo of the user message — used when no persisted row exists yet. */
  userMessage: string;
  assistant: CopilotInflightAssistant;
}

interface CopilotDrawerState {
  isOpen: boolean;
  open: () => void;
  close: () => void;
  /** True while a turn is currently streaming. */
  isStreaming: boolean;
  /** In-flight token + tool badges; null when idle. */
  inflight: CopilotInflightTurn | null;
  /** Whether the API rejected the most recent send with 402 (plan gate). */
  forcedToLockedPreview: boolean;
  /** When the most recent send hit 429 — message + retry seconds for inline UX. */
  rateLimitNotice: { message: string; retryAfterSeconds: number } | null;
  /** Submit a user message. Streams the response into `inflight`. */
  send: (message: string) => Promise<void>;
  /** Cancel the in-flight stream. */
  abort: () => void;
  /** Archive the active conversation and reset inflight state. */
  clear: () => Promise<void>;
  /** Whether `clear` is in flight. */
  isClearing: boolean;
}

const CopilotDrawerContext = createContext<CopilotDrawerState | null>(null);

export function useCopilotDrawer(): CopilotDrawerState {
  const ctx = useContext(CopilotDrawerContext);
  if (!ctx) {
    throw new Error('useCopilotDrawer must be used inside <CopilotDrawerProvider>');
  }
  return ctx;
}

const EMPTY_INFLIGHT: CopilotInflightTurn | null = null;

export function CopilotDrawerProvider({ children }: { children: ReactNode }) {
  const [isOpen, setIsOpen] = useState(false);
  const [isStreaming, setIsStreaming] = useState(false);
  const [inflight, setInflight] = useState<CopilotInflightTurn | null>(EMPTY_INFLIGHT);
  const [forcedToLockedPreview, setForcedToLockedPreview] = useState(false);
  const [rateLimitNotice, setRateLimitNotice] = useState<
    CopilotDrawerState['rateLimitNotice']
  >(null);

  const abortRef = useRef<AbortController | null>(null);
  const sendHandler = useSendCopilotMessageHandler();
  const clearMutation = useClearCopilotConversation();

  const open = useCallback(() => setIsOpen(true), []);
  const close = useCallback(() => {
    abortRef.current?.abort();
    setIsOpen(false);
  }, []);
  const abort = useCallback(() => abortRef.current?.abort(), []);

  const send = useCallback(
    async (message: string) => {
      if (!message.trim() || isStreaming) return;
      setRateLimitNotice(null);
      setIsStreaming(true);
      setInflight({
        userMessage: message,
        assistant: { content: '', toolBadges: [], outcome: null },
      });
      const ac = new AbortController();
      abortRef.current = ac;

      try {
        await sendHandler(
          { message, signal: ac.signal },
          {
            onToken: (delta) =>
              setInflight((prev) =>
                prev
                  ? {
                      ...prev,
                      assistant: {
                        ...prev.assistant,
                        content: prev.assistant.content + delta,
                      },
                    }
                  : prev,
              ),
            onToolStart: (name) =>
              setInflight((prev) =>
                prev
                  ? {
                      ...prev,
                      assistant: {
                        ...prev.assistant,
                        toolBadges: [
                          ...prev.assistant.toolBadges,
                          { name, outcome: 'in_flight' },
                        ],
                      },
                    }
                  : prev,
              ),
            onToolEnd: (name, outcome) =>
              setInflight((prev) => {
                if (!prev) return prev;
                const badges = prev.assistant.toolBadges.map((b, i, arr) =>
                  i === arr.length - 1 && b.name === name && b.outcome === 'in_flight'
                    ? { ...b, outcome }
                    : b,
                );
                return {
                  ...prev,
                  assistant: { ...prev.assistant, toolBadges: badges },
                };
              }),
            onComplete: () =>
              setInflight((prev) =>
                prev
                  ? {
                      ...prev,
                      assistant: { ...prev.assistant, outcome: 'success' },
                    }
                  : prev,
              ),
            onStreamError: (code) =>
              setInflight((prev) =>
                prev
                  ? {
                      ...prev,
                      assistant: {
                        ...prev.assistant,
                        outcome:
                          code === 'aborted'
                            ? 'aborted'
                            : code === 'agent_loop_exceeded'
                              ? 'agent_loop_exceeded'
                              : 'error',
                      },
                    }
                  : prev,
              ),
          },
        );
      } catch (err) {
        if (err instanceof CopilotPlanGateError) {
          setForcedToLockedPreview(true);
          setInflight(null);
        } else if (err instanceof CopilotRateLimitedError) {
          setRateLimitNotice({
            message: err.message,
            retryAfterSeconds: err.retryAfterSeconds,
          });
          setInflight(null);
        } else if (err instanceof CopilotApiError) {
          toast.error(err.message);
          setInflight((prev) =>
            prev
              ? {
                  ...prev,
                  assistant: { ...prev.assistant, outcome: 'error' },
                }
              : prev,
          );
        } else if ((err as Error)?.name === 'AbortError') {
          setInflight((prev) =>
            prev
              ? {
                  ...prev,
                  assistant: { ...prev.assistant, outcome: 'aborted' },
                }
              : prev,
          );
        } else {
          toast.error('Copilot request failed. Please try again.');
          setInflight((prev) =>
            prev
              ? {
                  ...prev,
                  assistant: { ...prev.assistant, outcome: 'error' },
                }
              : prev,
          );
        }
      } finally {
        setIsStreaming(false);
        abortRef.current = null;
      }
    },
    [isStreaming, sendHandler],
  );

  const clear = useCallback(async () => {
    abortRef.current?.abort();
    setInflight(null);
    setRateLimitNotice(null);
    await clearMutation.mutateAsync();
  }, [clearMutation]);

  // Drawer-close → abort the active SSE stream.
  useEffect(() => {
    if (!isOpen) {
      abortRef.current?.abort();
    }
  }, [isOpen]);

  // Escape key closes the drawer (in addition to the Close button).
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [isOpen, close]);

  const value = useMemo<CopilotDrawerState>(
    () => ({
      isOpen,
      open,
      close,
      isStreaming,
      inflight,
      forcedToLockedPreview,
      rateLimitNotice,
      send,
      abort,
      clear,
      isClearing: clearMutation.isPending,
    }),
    [
      isOpen,
      open,
      close,
      isStreaming,
      inflight,
      forcedToLockedPreview,
      rateLimitNotice,
      send,
      abort,
      clear,
      clearMutation.isPending,
    ],
  );

  return (
    <CopilotDrawerContext.Provider value={value}>{children}</CopilotDrawerContext.Provider>
  );
}
