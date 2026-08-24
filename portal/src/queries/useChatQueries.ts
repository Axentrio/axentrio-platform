/**
 * useChatQueries
 * React Query hooks for the chat list and the chat detail (B-PR3b).
 *
 * Strategy:
 *  - React Query owns server state (initial fetch, background refetch, cache).
 *  - The live feed (conversation:upsert / message:created) is folded into the
 *    cache by useLiveConversationSync (see ./conversationLive), which the
 *    Inbox mounts ONCE — the hooks here register no list/message socket
 *    handlers of their own anymore.
 *  - Everything entering the cache is normalized to the PORTAL status
 *    vocabulary (normalizeChatStatus); requests are remapped to the backend
 *    vocabulary by buildChatListParams. One vocabulary per side, everywhere.
 *  - Operator replies go over the acknowledged REST command
 *    POST /chats/:sessionId/messages (auto-claims + dedupes on
 *    clientMessageId) with an optimistic pending bubble — the socket
 *    `message:send` fire-and-forget emit is gone.
 */

import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { useQuery, useQueryClient, queryOptions } from "@tanstack/react-query";
import axios from "axios";
import { api, handleApiError } from "../services/apiClient";
import { queryKeys } from "./queryKeys";
import { useSocket } from "@websocket/SocketContext";
import {
  applyCommandConversation,
  mergeDefined,
  newUuid,
  normalizeChatStatus,
  seedChatDetail,
  type ChatDetailCacheEntry,
} from "./conversationLive";
import { LIVE_QUERY_REFETCH_MS } from "./queryConfig";
import type {
  Chat,
  ChatStatus,
  Message,
  MessageSender,
  MessageType,
  TypingIndicator,
  ChatFilters,
  ChatThreadResponse,
  CommandConversationSummary,
  ThreadBoundary,
  ThreadDuplicateEntry,
  ThreadMessagePayload,
} from "@app-types/index";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

interface ChatListResponse {
  data: Chat[];
  meta?: { total: number; totalPages: number };
  pagination?: { total: number; totalPages: number };
}

type ChatDetailResponse = ChatDetailCacheEntry;

interface UseChatsQueryOptions {
  filters?: ChatFilters & { page?: number; limit?: number };
}

interface UseChatsQueryReturn {
  chats: Chat[];
  totalCount: number;
  isLoading: boolean;
  isFetching: boolean;
  error: Error | null;
  refetch: () => void;
  pagination: {
    page: number;
    totalPages: number;
    hasMore: boolean;
  };
}

/** Composer send outcome — drives the ChatWindow state machine. */
export interface SendMessageResult {
  status: "sent" | "conflict" | "failed";
  /** 409 code: 'conversation_already_claimed' | 'conversation_closed' | ... */
  code?: string;
  message?: string;
}

interface UseChatDetailReturn {
  chat: Chat | null;
  messages: Message[];
  isTyping: boolean;
  typingUsers: string[];
  isLoading: boolean;
  isFetching: boolean;
  error: Error | null;
  sendMessage: (content: string) => Promise<SendMessageResult>;
  retryMessage: (clientMessageId: string) => Promise<SendMessageResult>;
  sendTyping: (typing: boolean) => void;
  refetch: () => void;
}

/** POST /chats/:sessionId/messages response (after envelope unwrap). */
interface SendReplyResponse {
  outcome: "sent" | "duplicate";
  autoClaimed: boolean;
  message: { id: string; createdAt: string };
  conversation?: CommandConversationSummary;
}

// ---------------------------------------------------------------------------
// Normalization of REST payloads into the cache (portal status vocabulary)
// ---------------------------------------------------------------------------

function normalizeChatRow(row: Chat): Chat {
  return { ...row, status: normalizeChatStatus(row.status as string) };
}

/** Normalize a GET /chats/:id payload: status vocabulary + per-message
 *  delivery state (server message.status 'failed' → retryable FAILED). */
export function normalizeChatDetail<
  T extends { status?: string; messages?: Any[] },
>(raw: T): T {
  return {
    ...raw,
    status: normalizeChatStatus(raw.status),
    ...(raw.messages
      ? {
          messages: raw.messages.map((m: Any) => ({
            ...m,
            chatId: m.chatId ?? m.sessionId,
            ...(m.status === "failed"
              ? { deliveryState: "failed" as const }
              : {}),
          })),
        }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// Query option factories
// ---------------------------------------------------------------------------

/**
 * Builds the request params from ChatFilters + pagination so the query key
 * changes whenever any filter changes (React Query will refetch).
 *
 * The status REMAP is the single portal→backend vocabulary crossing: the
 * portal filter values 'handsoff'/'human' become the backend column values
 * 'handoff'/'active'. The resulting params ARE the query key, which is what
 * lets the live upsert admission (conversationLive.matchesVariant) compare
 * backend-vocabulary payloads directly against each cached variant's params.
 */
export function buildChatListParams(
  filters?: ChatFilters & { page?: number; limit?: number },
): Record<string, string> {
  const params: Record<string, string> = {};
  if (!filters) return params;
  if (filters.tenantId) params.tenantId = filters.tenantId;
  if (filters.status) {
    const statusMap: Record<string, string> = {
      handsoff: "handoff",
      human: "active",
    };
    params.status = statusMap[filters.status] || filters.status;
  }
  if (filters.assignedAgentId) params.assignedAgentId = filters.assignedAgentId;
  if (filters.search) params.search = filters.search;
  if (filters.dateFrom) params.dateFrom = filters.dateFrom;
  if (filters.dateTo) params.dateTo = filters.dateTo;
  if (filters.page != null) params.page = String(filters.page);
  if (filters.limit != null) params.limit = String(filters.limit);
  return params;
}

export const chatOptions = {
  /**
   * Chat list query — accepts the full filters + pagination bag so that the
   * React Query cache key is tightly coupled to what was actually fetched.
   */
  list: (filters?: ChatFilters & { page?: number; limit?: number }) => {
    const params = buildChatListParams(filters);
    return queryOptions({
      queryKey: queryKeys.chats.list(params as Record<string, unknown>),
      queryFn: async () => {
        const res = (await api.get<Any>("/chats/sessions", {
          params,
        })) as ChatListResponse;
        return { ...res, data: (res?.data ?? []).map(normalizeChatRow) };
      },
      refetchIntervalInBackground: false,
    });
  },

  /** Single chat with embedded messages — longer staleTime since socket events keep it fresh */
  detail: (chatId: string) =>
    queryOptions({
      queryKey: queryKeys.chats.detail(chatId),
      queryFn: async () => {
        const raw = (await api.get<Any>(
          `/chats/${chatId}`,
        )) as ChatDetailResponse;
        return normalizeChatDetail(raw) as ChatDetailResponse;
      },
      enabled: !!chatId,
      staleTime: 5 * 60 * 1000,
    }),

  /**
   * B-PR4b read-only customer-thread history. Deliberately a SEPARATE cache
   * entry from `detail` - the live detail cache (conversationLive) stays the
   * ONE authoritative, composable thread for the CURRENT session; this query
   * only supplies prior closed sessions + the possible-duplicates audit.
   * Fetched on selection only (never per list row - no N+1).
   */
  thread: (chatId: string) =>
    queryOptions({
      queryKey: queryKeys.chats.thread(chatId),
      queryFn: async () =>
        (await api.get<Any>(`/chats/${chatId}/thread`)) as ChatThreadResponse,
      enabled: !!chatId,
      staleTime: 60 * 1000,
    }),
};

// ---------------------------------------------------------------------------
// Chat list hook
// ---------------------------------------------------------------------------

/**
 * useChatsQuery
 *
 * React Query for the list; the live cache patches come from
 * useLiveConversationSync (mounted once by the Inbox), which patches EVERY
 * cached list variant — so this hook needs no socket wiring of its own.
 */
export function useChatsQuery(
  options: UseChatsQueryOptions = {},
): UseChatsQueryReturn {
  const { filters } = options;

  const opts = chatOptions.list(filters);
  const { data, isLoading, isFetching, error, refetch } = useQuery({
    ...opts,
    // Sockets patch the list for instant updates, but polling ALWAYS runs as
    // the safety net: a socket can be connected-but-deaf (room/adapter issues),
    // which used to freeze the list until a tab change or reload.
    refetchInterval: LIVE_QUERY_REFETCH_MS,
  });

  const rawData = data as ChatListResponse | undefined;
  const chats: Chat[] = rawData?.data ?? [];
  const total = rawData?.meta?.total ?? rawData?.pagination?.total ?? 0;
  const totalPages =
    rawData?.meta?.totalPages ??
    rawData?.pagination?.totalPages ??
    (filters?.limit ? Math.ceil(total / filters.limit) : 1) ??
    1;
  const page = filters?.page ?? 1;

  return {
    chats,
    totalCount: total,
    isLoading,
    isFetching,
    error,
    refetch,
    pagination: {
      page,
      totalPages,
      hasMore: page < totalPages,
    },
  };
}

// ---------------------------------------------------------------------------
// Customer thread hook (B-PR4b)
// ---------------------------------------------------------------------------

/** Map a thread message (detail-GET shape) to the portal Message. */
export function threadMessageToMessage(m: ThreadMessagePayload): Message {
  return {
    id: m.id,
    chatId: m.sessionId,
    type: (m.type || "text") as MessageType,
    content: m.content,
    sender: (m.sender || "user") as MessageSender,
    ...(m.senderName ? { senderName: m.senderName } : {}),
    isRead: true,
    createdAt: m.createdAt,
  };
}

/** One prior (non-current) session, portal-shaped for read-only rendering. */
export interface EarlierThreadSession {
  id: string;
  boundary: ThreadBoundary;
  /** Portal status vocabulary (normalizeChatStatus of boundary.status). */
  status: ChatStatus;
  messages: Message[];
}

export interface UseChatThreadReturn {
  thread: ChatThreadResponse | null;
  /** Sessions OTHER than the selected one, oldest→newest. */
  earlierSessions: EarlierThreadSession[];
  /** TRUE count of earlier conversations (pre-cap) - drives the list badge. */
  earlierCount: number;
  /** True when the cap cut older sessions out of `earlierSessions`. */
  truncated: boolean;
  possibleDuplicates: ThreadDuplicateEntry[];
  isLoading: boolean;
  error: Error | null;
}

/**
 * useChatThread - the read-only whole-customer thread for a selected session.
 *
 * Separate from useChatDetail on purpose: the current session's live messages
 * and composer stay owned by the detail cache + conversationLive (B-PR3b);
 * this hook only contributes the labelled history ABOVE it and the
 * possible-duplicates audit. Runs only when a chat is selected.
 */
export function useChatThread(chatId: string | undefined): UseChatThreadReturn {
  const { data, isLoading, error } = useQuery(chatOptions.thread(chatId ?? ""));
  const thread = (data as ChatThreadResponse | undefined) ?? null;

  const earlierSessions = useMemo<EarlierThreadSession[]>(() => {
    const result: EarlierThreadSession[] = [];
    for (const s of thread?.sessions ?? []) {
      if (s.isCurrent) continue;
      result.push({
        id: s.summary.sessionId ?? s.summary.id,
        boundary: s.boundary,
        status: normalizeChatStatus(s.boundary.status),
        messages: s.messages.map(threadMessageToMessage),
      });
    }
    return result;
  }, [thread]);

  return {
    thread,
    earlierSessions,
    earlierCount: Math.max(
      earlierSessions.length,
      (thread?.totalSessions ?? 1) - 1,
    ),
    truncated: thread?.truncated ?? false,
    possibleDuplicates: thread?.possibleDuplicates ?? [],
    isLoading,
    error,
  };
}

// ---------------------------------------------------------------------------
// Chat detail hook
// ---------------------------------------------------------------------------

/** Read a command-conflict code from an error, if it is one.
 *  409s are the ownership/closed cases; 403s (`operator_not_in_tenant`,
 *  `not_conversation_owner`) must keep the draft the same way. */
function conflictCodeOf(err: unknown): string | undefined {
  if (!axios.isAxiosError(err) || !err.response) return undefined;
  const status = err.response.status;
  if (status !== 409 && status !== 403) return undefined;
  const data = err.response.data as
    | { error?: { code?: string } | string }
    | undefined;
  if (
    data?.error &&
    typeof data.error === "object" &&
    typeof data.error.code === "string"
  ) {
    return data.error.code;
  }
  return status === 409 ? "conflict" : undefined;
}

/**
 * useChatDetail
 *
 * Manages a single open chat conversation.
 * - React Query fetches the chat + messages; message appends and summary
 *   patches arrive via the shared live sync (conversationLive).
 * - On mount the agent joins the socket room; on unmount they leave.
 * - Typing indicators are tracked in local state (ephemeral, not cached).
 * - `sendMessage` posts to the acknowledged command route with an optimistic
 *   pending bubble; `retryMessage` re-sends a FAILED bubble with the SAME
 *   clientMessageId (server-side idempotent).
 */
/** PATCH /chats/:id { userName } — optimistic list + detail via mergeDefined. */
export function useRenameConversation() {
  const queryClient = useQueryClient();
  return useCallback(
    async (chatId: string, userName: string) => {
      const patch = { userName };
      const previous = queryClient.getQueriesData({
        queryKey: queryKeys.chats.all(),
      });
      queryClient.setQueriesData<{ data?: Chat[] }>(
        { queryKey: queryKeys.chats.all() },
        (old) => {
          if (!old) return old;
          if (Array.isArray(old.data)) {
            return {
              ...old,
              data: old.data.map((row) =>
                row.id === chatId ? mergeDefined(row, patch) : row,
              ),
            };
          }
          return old;
        },
      );
      queryClient.setQueryData<ChatDetailCacheEntry>(
        queryKeys.chats.detail(chatId),
        (old) => (old ? mergeDefined(old, patch) : old),
      );
      try {
        await api.patch(`/chats/${chatId}`, { userName });
      } catch (err) {
        for (const [key, data] of previous) {
          queryClient.setQueryData(key, data);
        }
        throw err;
      }
    },
    [queryClient],
  );
}

export function useChatDetail(chatId: string): UseChatDetailReturn {
  const queryClient = useQueryClient();
  const {
    registerHandlers,
    unregisterHandlers,
    joinChat,
    leaveChat,
    sendTyping: socketSendTyping,
  } = useSocket();

  // Local ephemeral state for typing indicators
  const [typingUsers, setTypingUsers] = useState<string[]>([]);
  const [isTyping, setIsTyping] = useState(false);
  const typingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // React Query for the chat detail
  const {
    data: detailData,
    isLoading: detailIsLoading,
    isFetching: detailIsFetching,
    error: detailError,
    refetch: detailRefetch,
  } = useQuery(chatOptions.detail(chatId));
  const raw = detailData as ChatDetailResponse | undefined;
  const chat: Chat | null = raw ? (raw as unknown as Chat) : null;
  const messages: Message[] = raw?.messages ?? [];

  // Join / leave socket room when chatId changes
  useEffect(() => {
    if (!chatId) return;
    joinChat(chatId);
    return () => {
      leaveChat(chatId);
    };
  }, [chatId, joinChat, leaveChat]);

  // Typing indicator events (messages/summaries arrive via the shared sync)
  useEffect(() => {
    if (!chatId) return;

    const handlerId = registerHandlers({
      onTypingUpdate: (typing: TypingIndicator) => {
        if (typing.chatId !== chatId) return;
        setTypingUsers((prev) => {
          if (typing.isTyping) {
            return prev.includes(typing.userName)
              ? prev
              : [...prev, typing.userName];
          }
          return prev.filter((name) => name !== typing.userName);
        });
      },
    });

    return () => {
      unregisterHandlers(handlerId);
    };
  }, [chatId, registerHandlers, unregisterHandlers]);

  // Cleanup typing timeout on unmount
  useEffect(() => {
    return () => {
      if (typingTimeoutRef.current) {
        clearTimeout(typingTimeoutRef.current);
      }
    };
  }, []);

  const patchMessages = useCallback(
    (updater: (messages: Message[]) => Message[]) => {
      queryClient.setQueryData<ChatDetailResponse>(
        queryKeys.chats.detail(chatId),
        (old) => {
          const messages = updater(old?.messages ?? []);
          if (!old) return seedChatDetail(chatId, { messages });
          return { ...old, messages };
        },
      );
    },
    [chatId, queryClient],
  );

  /**
   * POST the reply and reconcile the optimistic bubble.
   *
   * Composer state machine (per clientMessageId):
   *   pending  → sent      201: bubble takes the server id (or is dropped if
   *                        the socket copy already brought it); draft cleared
   *                        by the caller. Auto-claim ownership is folded in
   *                        from the response conversation.
   *   pending  → (removed) 409 on a FIRST send: the message was NOT persisted
   *                        — the bubble is removed and the caller KEEPS the
   *                        draft (the text still sits in the composer).
   *   failed   → failed    409 on a RETRY (keepBubbleOnConflict): the draft
   *                        was already cleared, so the bubble is KEPT in its
   *                        retryable failed state — the text is never lost.
   *   pending  → failed    network/5xx: bubble flips to FAILED with a retry
   *                        that re-sends the SAME clientMessageId. A bubble
   *                        the socket already confirmed ('sent') is NEVER
   *                        downgraded by a late rejection.
   *   failed   → pending   retryMessage(): same id, same content.
   */
  const postReply = useCallback(
    async (
      clientMessageId: string,
      content: string,
      opts: { keepBubbleOnConflict?: boolean } = {},
    ): Promise<SendMessageResult> => {
      try {
        const res = await api.post<SendReplyResponse>(
          `/chats/${chatId}/messages`,
          {
            clientMessageId,
            content,
          },
        );
        const serverId = res.message.id;
        patchMessages((msgs) => {
          if (msgs.some((m) => m.id === serverId)) {
            // The socket copy arrived first (it reconciled the bubble or
            // appended) — drop any leftover optimistic duplicate. Single pass:
            // drop-or-map in one reduce instead of filter().map().
            const next: Message[] = [];
            for (const m of msgs) {
              if (m.clientMessageId === clientMessageId && m.id !== serverId)
                continue;
              next.push(
                m.id === serverId
                  ? { ...m, clientMessageId, deliveryState: "sent" as const }
                  : m,
              );
            }
            return next;
          }
          const idx = msgs.findIndex(
            (m) => m.clientMessageId === clientMessageId,
          );
          if (idx === -1) return msgs; // cache was replaced (refetch) — REST copy owns it
          const next = [...msgs];
          next[idx] = {
            ...next[idx],
            id: serverId,
            createdAt: res.message.createdAt ?? next[idx].createdAt,
            deliveryState: "sent",
          };
          return next;
        });
        // The auto-claim means ownership flipped to this operator — fold the
        // response summary into the list + detail caches (no follow-up GET).
        applyCommandConversation(queryClient, res.conversation);
        return { status: "sent" };
      } catch (err) {
        const code = conflictCodeOf(err);
        if (code) {
          if (opts.keepBubbleOnConflict) {
            // 409 on a retry: the composer draft is long gone, so the bubble
            // is the ONLY copy of the text — keep it retryable, never remove.
            patchMessages((msgs) =>
              msgs.map((m) =>
                m.clientMessageId === clientMessageId &&
                m.deliveryState === "pending"
                  ? { ...m, deliveryState: "failed" as const }
                  : m,
              ),
            );
          } else {
            // 409 on a first send: not persisted; the caller keeps the draft.
            // A bubble the socket already confirmed is never removed.
            patchMessages((msgs) =>
              msgs.filter(
                (m) =>
                  !(
                    m.clientMessageId === clientMessageId &&
                    m.deliveryState !== "sent"
                  ),
              ),
            );
          }
          return { status: "conflict", code, message: handleApiError(err) };
        }
        // Only a still-pending bubble may become FAILED — a socket-confirmed
        // ('sent') bubble is never downgraded by a late rejection.
        patchMessages((msgs) =>
          msgs.map((m) =>
            m.clientMessageId === clientMessageId &&
            m.deliveryState === "pending"
              ? { ...m, deliveryState: "failed" as const }
              : m,
          ),
        );
        return { status: "failed", message: handleApiError(err) };
      }
    },
    [chatId, patchMessages, queryClient],
  );

  const sendMessage = useCallback(
    async (content: string): Promise<SendMessageResult> => {
      const trimmed = content.trim();
      if (!chatId || !trimmed)
        return { status: "failed", message: "Empty message" };
      const clientMessageId = newUuid();
      const optimistic: Message = {
        id: clientMessageId,
        clientMessageId,
        chatId,
        type: "text",
        content: trimmed,
        sender: "agent",
        isRead: true,
        createdAt: new Date().toISOString(),
        deliveryState: "pending",
      };
      patchMessages((msgs) => [...msgs, optimistic]);
      return postReply(clientMessageId, trimmed, {
        keepBubbleOnConflict: false,
      });
    },
    [chatId, patchMessages, postReply],
  );

  const retryMessage = useCallback(
    async (clientMessageId: string): Promise<SendMessageResult> => {
      const entry = queryClient.getQueryData<ChatDetailResponse>(
        queryKeys.chats.detail(chatId),
      );
      const target = (entry?.messages ?? []).find(
        (m) =>
          m.clientMessageId === clientMessageId && m.deliveryState === "failed",
      );
      if (!target) return { status: "failed", message: "Nothing to retry" };
      patchMessages((msgs) =>
        msgs.map((m) =>
          m.clientMessageId === clientMessageId
            ? { ...m, deliveryState: "pending" as const }
            : m,
        ),
      );
      return postReply(clientMessageId, target.content, {
        keepBubbleOnConflict: true,
      });
    },
    [chatId, patchMessages, postReply, queryClient],
  );

  // Send typing indicator with 3 s auto-clear
  const sendTyping = useCallback(
    (typing: boolean) => {
      if (!chatId) return;

      if (typingTimeoutRef.current) {
        clearTimeout(typingTimeoutRef.current);
      }

      socketSendTyping(chatId, typing);
      setIsTyping(typing);

      if (typing) {
        typingTimeoutRef.current = setTimeout(() => {
          socketSendTyping(chatId, false);
          setIsTyping(false);
        }, 3000);
      }
    },
    [chatId, socketSendTyping],
  );


  return {
    chat,
    messages,
    isTyping,
    typingUsers,
    isLoading: detailIsLoading,
    isFetching: detailIsFetching,
    error: detailError,
    sendMessage,
    retryMessage,
    sendTyping,
    refetch: detailRefetch,
  };
}
