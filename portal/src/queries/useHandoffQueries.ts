/**
 * useHandoffQueries
 * Hybrid Socket.IO + React Query hooks for handoff request management.
 * - useQuery provides initial data fetch and background refetch
 * - useEffect wires Socket.IO events to update the React Query cache in real-time
 */

import { useEffect } from 'react';
import { useQuery, useMutation, useQueryClient, queryOptions } from '@tanstack/react-query';
import { useSocket } from '@websocket/SocketContext';
import { useNotificationSound } from '@websocket/notificationSound';
import { api } from '../services/apiClient';
import { queryKeys } from './queryKeys';
import { applyCommandConversation, newUuid } from './conversationLive';
import type { HandoffRequest, CommandConversationSummary } from '@app-types/index';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

// ---------------------------------------------------------------------------
// Query options factory
// ---------------------------------------------------------------------------

export const handoffOptions = {
  list: (status?: string) =>
    queryOptions({
      queryKey: queryKeys.handoffs.list(status),
      queryFn: async () => {
        const res = await api.get<Any>('/handoffs/pending');
        // Handle both { data: { pendingRequests }, meta } and bare { pendingRequests } shapes
        const inner = res?.data ?? res;
        return (inner?.pendingRequests ?? inner ?? []) as HandoffRequest[];
      },
    }),
};

// ---------------------------------------------------------------------------
// Hybrid hook — query + real-time socket updates
// ---------------------------------------------------------------------------

export function useHandoffsQuery(status: 'pending' | 'assigned' | 'resolved' | 'cancelled' = 'pending') {
  const queryClient = useQueryClient();
  const { registerHandlers, unregisterHandlers } = useSocket();
  const { playHandoff } = useNotificationSound();

  const { data, ...query } = useQuery(handoffOptions.list(status));

  useEffect(() => {
    const handlers = registerHandlers({
      onHandoffNew: (newHandoff: HandoffRequest) => {
        const incomingStatus = newHandoff.status ?? 'pending';
        if (incomingStatus === status) {
          queryClient.setQueryData<HandoffRequest[]>(
            queryKeys.handoffs.list(status),
            (prev = []) => {
              if (prev.some((h) => h.id === newHandoff.id)) return prev;
              return [newHandoff, ...prev];
            },
          );
          playHandoff();
        }
      },
      onHandoffUpdate: (updatedHandoff: HandoffRequest) => {
        queryClient.setQueryData<HandoffRequest[]>(
          queryKeys.handoffs.list(status),
          (prev = []) => {
            const index = prev.findIndex((h) => h.id === updatedHandoff.id);

            // If status changed away from the current filter, remove from list
            if (updatedHandoff.status !== status) {
              return prev.filter((h) => h.id !== updatedHandoff.id);
            }

            if (index === -1) {
              return [updatedHandoff, ...prev];
            }

            const next = [...prev];
            next[index] = updatedHandoff;
            return next;
          },
        );
      },
    });

    return () => {
      unregisterHandlers(handlers);
    };
  }, [queryClient, registerHandlers, unregisterHandlers, status, playHandoff]);

  const handoffs = data ?? [];
  const pendingCount = handoffs.filter((h) => h.status === 'pending').length;

  return {
    ...query,
    data,
    handoffs,
    pendingCount,
  };
}

// ---------------------------------------------------------------------------
// Mutations — acknowledged REST commands (B-PR3b)
//
// Accept = POST /chats/:sessionId/takeover; Decline = POST /chats/:sessionId/
// cancel. No fire-and-forget socket emit and NO optimistic removal before the
// ack anymore: the command either commits (the resulting conversation:upsert /
// handoff events + the onSettled refetch reconcile the queue) or it fails and
// the card stays. Each mutation carries an idempotencyKey.
// ---------------------------------------------------------------------------

/** POST command response body (after envelope unwrap). */
interface CommandResponse {
  outcome: string;
  conversation?: CommandConversationSummary;
}

export function useAcceptHandoff() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ chatId }: { chatId: string }) =>
      api.post<CommandResponse>(`/chats/${chatId}/takeover`, { idempotencyKey: newUuid() }),
    onSuccess: (res) => {
      // The response carries the committed ownership — fold it into the chat
      // caches immediately (no follow-up GET needed).
      applyCommandConversation(queryClient, res?.conversation);
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.handoffs.all() });
    },
  });
}

export function useRejectHandoff() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ chatId, reason }: { chatId: string; reason?: string }) =>
      api.post<CommandResponse>(`/chats/${chatId}/cancel`, {
        idempotencyKey: newUuid(),
        reason,
      }),
    onSuccess: (res) => {
      applyCommandConversation(queryClient, res?.conversation);
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.handoffs.all() });
    },
  });
}
