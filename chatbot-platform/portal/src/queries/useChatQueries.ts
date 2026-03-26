/**
 * useChatQueries
 * Hybrid Socket.IO + React Query hooks for chat list and chat detail.
 *
 * Strategy:
 *  - React Query owns server state (initial fetch, background refetch, cache).
 *  - Socket events patch the cache directly via queryClient.setQueryData so
 *    the UI stays in sync between polls without an extra network round-trip.
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import {
  useQuery,
  useMutation,
  useQueryClient,
  queryOptions,
} from '@tanstack/react-query';
import { api } from '../services/apiClient';
import { queryKeys } from './queryKeys';
import { useSocket } from '@websocket/SocketContext';
import { useNotificationSound } from '@websocket/notificationSound';
import type { Chat, Message, TypingIndicator, ChatFilters } from '@app-types/index';

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

interface ChatDetailResponse extends Omit<Chat, 'messages'> {
  messages?: Message[];
}

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

interface UseChatDetailReturn {
  chat: Chat | null;
  messages: Message[];
  isTyping: boolean;
  typingUsers: string[];
  isLoading: boolean;
  isFetching: boolean;
  error: Error | null;
  sendMessage: (content: string, type?: Message['type']) => void;
  sendTyping: (typing: boolean) => void;
  refetch: () => void;
  markAsRead: () => void;
}

// ---------------------------------------------------------------------------
// Query option factories
// ---------------------------------------------------------------------------

/**
 * Builds a URLSearchParams string from ChatFilters + pagination so the
 * query key changes whenever any filter changes (React Query will refetch).
 */
function buildChatListParams(
  filters?: ChatFilters & { page?: number; limit?: number },
): Record<string, string> {
  const params: Record<string, string> = {};
  if (!filters) return params;
  if (filters.tenantId) params.tenantId = filters.tenantId;
  if (filters.status) params.status = filters.status === 'handsoff' ? 'handoff' : filters.status;
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
      queryFn: () =>
        api.get<Any>('/chats/sessions', {
          params,
        }) as Promise<ChatListResponse>,
    });
  },

  /** Single chat with embedded messages */
  detail: (chatId: string) =>
    queryOptions({
      queryKey: queryKeys.chats.detail(chatId),
      queryFn: () =>
        api.get<Any>(`/chats/${chatId}`) as Promise<ChatDetailResponse>,
      enabled: !!chatId,
    }),
};

// ---------------------------------------------------------------------------
// Mutation hooks
// ---------------------------------------------------------------------------

export function useTakeoverChat() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (chatId: string) => api.post(`/chats/${chatId}/takeover`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.chats.all() });
    },
  });
}

export function useCloseChat() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (chatId: string) => api.post(`/chats/${chatId}/close`),
    onSuccess: (_data, chatId) => {
      // Remove the closed chat from every list cache entry
      queryClient.setQueriesData<ChatListResponse>(
        { queryKey: queryKeys.chats.all() },
        (old) => {
          if (!old) return old;
          return {
            ...old,
            data: (old.data ?? []).filter((c) => c.id !== chatId),
          };
        },
      );
      // Remove detail cache
      queryClient.removeQueries({ queryKey: queryKeys.chats.detail(chatId) });
    },
  });
}

// ---------------------------------------------------------------------------
// Hybrid chat list hook
// ---------------------------------------------------------------------------

/**
 * useChatsQuery
 *
 * Combines React Query for server state with Socket.IO for live updates.
 * - Initial data + background refetch handled by React Query.
 * - `onChatNew` / `onChatUpdate` socket events patch the cache so consumers
 *   see live updates without waiting for the next poll.
 * - Filter matching mirrors the original `useChats` hook exactly.
 * - Notification sound is played for new `handsoff` chats (matches original).
 */
export function useChatsQuery(options: UseChatsQueryOptions = {}): UseChatsQueryReturn {
  const { filters } = options;
  const queryClient = useQueryClient();
  const { registerHandlers, unregisterHandlers } = useSocket();
  const { playHandoff } = useNotificationSound();

  const opts = chatOptions.list(filters);
  const query = useQuery(opts);

  const rawData = query.data as ChatListResponse | undefined;
  const chats: Chat[] = rawData?.data ?? [];
  const total = rawData?.meta?.total ?? rawData?.pagination?.total ?? 0;
  const totalPages =
    rawData?.meta?.totalPages ??
    rawData?.pagination?.totalPages ??
    (filters?.limit ? Math.ceil(total / filters.limit) : 1) ??
    1;
  const page = filters?.page ?? 1;

  // Keep a stable ref to filters so the socket handler closure always sees the
  // latest value without needing to be re-registered on every filter change.
  const filtersRef = useRef(filters);
  useEffect(() => {
    filtersRef.current = filters;
  }, [filters]);

  // Socket-driven cache patches
  useEffect(() => {
    const handlerId = registerHandlers({
      onChatNew: (newChat: Chat) => {
        const currentFilters = filtersRef.current;

        // Apply same filter guards as the original hook
        if (currentFilters?.status && newChat.status !== currentFilters.status) return;
        if (currentFilters?.tenantId && newChat.tenantId !== currentFilters.tenantId) return;

        // Play sound for new handoff requests
        if (newChat.status === 'handsoff') {
          playHandoff();
        }

        queryClient.setQueryData<ChatListResponse>(opts.queryKey, (old) => {
          if (!old) return old;
          const existing = old.data ?? [];
          // Avoid duplicates
          if (existing.some((c) => c.id === newChat.id)) return old;
          return {
            ...old,
            data: [newChat, ...existing],
          };
        });
      },

      onChatUpdate: (updatedChat: Chat) => {
        const currentFilters = filtersRef.current;

        queryClient.setQueryData<ChatListResponse>(opts.queryKey, (old) => {
          if (!old) return old;
          const existing = old.data ?? [];
          const index = existing.findIndex((c) => c.id === updatedChat.id);

          if (index === -1) {
            // Chat not in list — check if it passes current filters before adding
            if (currentFilters?.status && updatedChat.status !== currentFilters.status) return old;
            if (currentFilters?.tenantId && updatedChat.tenantId !== currentFilters.tenantId) return old;
            return { ...old, data: [updatedChat, ...existing] };
          }

          // Update existing entry and re-sort by lastMessageAt (newest first)
          const updated = [...existing];
          updated[index] = updatedChat;
          updated.sort((a, b) => {
            const timeA = a.lastMessageAt ? new Date(a.lastMessageAt).getTime() : 0;
            const timeB = b.lastMessageAt ? new Date(b.lastMessageAt).getTime() : 0;
            return timeB - timeA;
          });

          return { ...old, data: updated };
        });

        // Also patch the detail cache if it's loaded
        queryClient.setQueryData<ChatDetailResponse>(
          queryKeys.chats.detail(updatedChat.id),
          (old) => {
            if (!old) return old;
            return { ...old, ...updatedChat };
          },
        );
      },
    });

    return () => {
      unregisterHandlers(handlerId);
    };
    // opts.queryKey is intentionally excluded — the handler only patches
    // whichever cache entry is currently active, re-registered on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queryClient, registerHandlers, unregisterHandlers, playHandoff]);

  return {
    chats,
    totalCount: total,
    isLoading: query.isLoading,
    isFetching: query.isFetching,
    error: query.error,
    refetch: query.refetch,
    pagination: {
      page,
      totalPages,
      hasMore: page < totalPages,
    },
  };
}

// ---------------------------------------------------------------------------
// Hybrid chat detail hook
// ---------------------------------------------------------------------------

/**
 * useChatDetail
 *
 * Manages a single open chat conversation.
 * - React Query fetches the chat + messages.
 * - On mount the agent joins the socket room; on unmount they leave.
 * - Incoming messages are deduped and appended to the React Query cache.
 * - Typing indicators are tracked in local state (ephemeral, not cached).
 * - `sendMessage` fires over the socket (same as original hook).
 * - `sendTyping` includes auto-clear after 3 s (same as original hook).
 */
export function useChatDetail(
  chatId: string,
  options: { enableSound?: boolean } = {},
): UseChatDetailReturn {
  const { enableSound = true } = options;
  const queryClient = useQueryClient();
  const {
    registerHandlers,
    unregisterHandlers,
    joinChat,
    leaveChat,
    sendMessage: socketSendMessage,
    sendTyping: socketSendTyping,
  } = useSocket();
  const { playMessage } = useNotificationSound();

  // Local ephemeral state for typing indicators
  const [typingUsers, setTypingUsers] = useState<string[]>([]);
  const [isTyping, setIsTyping] = useState(false);
  const typingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // React Query for the chat detail
  const detailQuery = useQuery(chatOptions.detail(chatId));
  const raw = detailQuery.data as ChatDetailResponse | undefined;
  const chat: Chat | null = raw ? (raw as Chat) : null;
  const messages: Message[] = raw?.messages ?? [];

  // Join / leave socket room when chatId changes
  useEffect(() => {
    if (!chatId) return;
    joinChat(chatId);
    return () => {
      leaveChat(chatId);
    };
  }, [chatId, joinChat, leaveChat]);

  // Socket event handlers
  useEffect(() => {
    if (!chatId) return;

    const handlerId = registerHandlers({
      onChatUpdate: (updatedChat: Chat) => {
        if (updatedChat.id !== chatId) return;
        queryClient.setQueryData<ChatDetailResponse>(
          queryKeys.chats.detail(chatId),
          (old) => {
            if (!old) return old;
            return { ...old, ...updatedChat };
          },
        );
      },

      onMessageReceived: (message: Message) => {
        if (message.chatId !== chatId) return;

        queryClient.setQueryData<ChatDetailResponse>(
          queryKeys.chats.detail(chatId),
          (old) => {
            if (!old) return old;
            const existing = old.messages ?? [];
            // Avoid duplicates
            if (existing.some((m) => m.id === message.id)) return old;
            return { ...old, messages: [...existing, message] };
          },
        );

        // Play sound for messages from user or bot
        if (enableSound && (message.sender === 'user' || message.sender === 'bot')) {
          playMessage();
        }
      },

      onTypingUpdate: (typing: TypingIndicator) => {
        if (typing.chatId !== chatId) return;
        setTypingUsers((prev) => {
          if (typing.isTyping) {
            return prev.includes(typing.userName) ? prev : [...prev, typing.userName];
          }
          return prev.filter((name) => name !== typing.userName);
        });
      },
    });

    return () => {
      unregisterHandlers(handlerId);
    };
  }, [
    chatId,
    queryClient,
    registerHandlers,
    unregisterHandlers,
    enableSound,
    playMessage,
  ]);

  // Cleanup typing timeout on unmount
  useEffect(() => {
    return () => {
      if (typingTimeoutRef.current) {
        clearTimeout(typingTimeoutRef.current);
      }
    };
  }, []);

  // Send a message over the socket
  const sendMessage = useCallback(
    (content: string, type: Message['type'] = 'text') => {
      if (!chatId || !content.trim()) return;
      const message: Partial<Message> = {
        content: content.trim(),
        type,
        sender: 'agent',
      };
      socketSendMessage(chatId, message);
    },
    [chatId, socketSendMessage],
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

  // Mark messages as read (placeholder — same as original)
  const markAsRead = useCallback(() => {
    // TODO: implement mark-as-read API call
  }, []);

  return {
    chat,
    messages,
    isTyping,
    typingUsers,
    isLoading: detailQuery.isLoading,
    isFetching: detailQuery.isFetching,
    error: detailQuery.error,
    sendMessage,
    sendTyping,
    refetch: detailQuery.refetch,
    markAsRead,
  };
}
