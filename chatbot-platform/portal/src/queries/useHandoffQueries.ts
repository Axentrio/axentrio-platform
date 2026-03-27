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
import type { HandoffRequest } from '@app-types/index';

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

  const query = useQuery(handoffOptions.list(status));

  useEffect(() => {
    const handlers = registerHandlers({
      onHandoffNew: (newHandoff: HandoffRequest) => {
        if (newHandoff.status === status) {
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

  const handoffs = query.data ?? [];
  const pendingCount = handoffs.filter((h) => h.status === 'pending').length;

  return {
    ...query,
    handoffs,
    pendingCount,
  };
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

export function useAcceptHandoff() {
  const queryClient = useQueryClient();
  const { acceptHandoff: socketAcceptHandoff } = useSocket();

  return useMutation({
    mutationFn: (handoffId: string) => {
      socketAcceptHandoff(handoffId);
      return Promise.resolve();
    },
    onMutate: async (handoffId: string) => {
      // Optimistic removal from the pending list
      await queryClient.cancelQueries({ queryKey: queryKeys.handoffs.all() });

      const previousData = queryClient.getQueryData<HandoffRequest[]>(
        queryKeys.handoffs.list('pending'),
      );

      queryClient.setQueryData<HandoffRequest[]>(
        queryKeys.handoffs.list('pending'),
        (prev = []) => prev.filter((h) => h.id !== handoffId),
      );

      return { previousData };
    },
    onError: (_err, _handoffId, context) => {
      if (context?.previousData) {
        queryClient.setQueryData(queryKeys.handoffs.list('pending'), context.previousData);
      }
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.handoffs.all() });
    },
  });
}

export function useRejectHandoff() {
  const queryClient = useQueryClient();
  const { declineHandoff: socketDeclineHandoff } = useSocket();

  return useMutation({
    mutationFn: ({ handoffId, reason }: { handoffId: string; reason?: string }) => {
      socketDeclineHandoff(handoffId, reason);
      return Promise.resolve();
    },
    onMutate: async ({ handoffId }: { handoffId: string; reason?: string }) => {
      // Optimistic removal from the pending list
      await queryClient.cancelQueries({ queryKey: queryKeys.handoffs.all() });

      const previousData = queryClient.getQueryData<HandoffRequest[]>(
        queryKeys.handoffs.list('pending'),
      );

      queryClient.setQueryData<HandoffRequest[]>(
        queryKeys.handoffs.list('pending'),
        (prev = []) => prev.filter((h) => h.id !== handoffId),
      );

      return { previousData };
    },
    onError: (_err, _variables, context) => {
      if (context?.previousData) {
        queryClient.setQueryData(queryKeys.handoffs.list('pending'), context.previousData);
      }
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.handoffs.all() });
    },
  });
}
