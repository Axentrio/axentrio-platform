/**
 * useHandoffs Hook
 * Manages handoff request queue
 */

import { useState, useEffect, useCallback } from 'react';
import { useSocket } from '@websocket/SocketContext';
import { useNotificationSound } from '@websocket/notificationSound';
import type { HandoffRequest } from '@app-types/index';
import { REFRESH_INTERVALS } from '@config/constants';
import { api } from '@services/apiClient';

interface UseHandoffsOptions {
  autoRefresh?: boolean;
  refreshInterval?: number;
  status?: 'pending' | 'assigned' | 'resolved' | 'cancelled';
}

interface UseHandoffsReturn {
  handoffs: HandoffRequest[];
  pendingCount: number;
  isLoading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  acceptHandoff: (handoffId: string) => Promise<void>;
  declineHandoff: (handoffId: string, reason?: string) => Promise<void>;
}

export const useHandoffs = (options: UseHandoffsOptions = {}): UseHandoffsReturn => {
  const { 
    autoRefresh = true, 
    refreshInterval = REFRESH_INTERVALS.QUEUE,
    status = 'pending'
  } = options;
  
  const { registerHandlers, unregisterHandlers, acceptHandoff: socketAcceptHandoff, declineHandoff: socketDeclineHandoff } = useSocket();
  const { playHandoff } = useNotificationSound();
  
  const [handoffs, setHandoffs] = useState<HandoffRequest[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Fetch handoffs
  const fetchHandoffs = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    
    try {
      const data = await api.get<any>('/v1/handoffs/pending');
      setHandoffs(data.data || []);
    } catch (err: any) {
      setError(err.message || 'Failed to load handoffs');
    } finally {
      setIsLoading(false);
    }
  }, [status]);

  // Initial fetch and auto-refresh
  useEffect(() => {
    fetchHandoffs();
    
    if (autoRefresh) {
      const interval = setInterval(fetchHandoffs, refreshInterval);
      return () => clearInterval(interval);
    }
  }, [fetchHandoffs, autoRefresh, refreshInterval]);

  // Register socket handlers
  useEffect(() => {
    const handlers = registerHandlers({
      onHandoffNew: (newHandoff: HandoffRequest) => {
        if (newHandoff.status === status) {
          setHandoffs((prev) => {
            if (prev.some((h) => h.id === newHandoff.id)) return prev;
            return [newHandoff, ...prev];
          });
          playHandoff();
        }
      },
      onHandoffUpdate: (updatedHandoff: HandoffRequest) => {
        setHandoffs((prev) => {
          const index = prev.findIndex((h) => h.id === updatedHandoff.id);
          
          // If status changed, remove from current list
          if (updatedHandoff.status !== status) {
            return prev.filter((h) => h.id !== updatedHandoff.id);
          }
          
          if (index === -1) {
            return [updatedHandoff, ...prev];
          }
          
          const newHandoffs = [...prev];
          newHandoffs[index] = updatedHandoff;
          return newHandoffs;
        });
      },
    });

    return () => {
      unregisterHandlers(handlers);
    };
  }, [registerHandlers, unregisterHandlers, status, playHandoff]);

  // Accept handoff
  const acceptHandoff = useCallback(async (handoffId: string) => {
    try {
      socketAcceptHandoff(handoffId);
      
      // Optimistic update
      setHandoffs((prev) => prev.filter((h) => h.id !== handoffId));
    } catch (err: any) {
      setError(err.message || 'Failed to accept handoff');
      throw err;
    }
  }, [socketAcceptHandoff]);

  // Decline handoff
  const declineHandoff = useCallback(async (handoffId: string, reason?: string) => {
    try {
      socketDeclineHandoff(handoffId, reason);
      
      // Optimistic update
      setHandoffs((prev) => prev.filter((h) => h.id !== handoffId));
    } catch (err: any) {
      setError(err.message || 'Failed to decline handoff');
      throw err;
    }
  }, [socketDeclineHandoff]);

  const pendingCount = handoffs.filter((h) => h.status === 'pending').length;

  return {
    handoffs,
    pendingCount,
    isLoading,
    error,
    refresh: fetchHandoffs,
    acceptHandoff,
    declineHandoff,
  };
};

export default useHandoffs;
