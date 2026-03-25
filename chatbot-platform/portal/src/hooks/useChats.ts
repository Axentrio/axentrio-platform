/**
 * useChats Hook
 * Manages list of chats with filtering and pagination
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { useSocket } from '@websocket/SocketContext';
import { useNotificationSound } from '@websocket/notificationSound';
import type { Chat, ChatFilters } from '@app-types/index';
import { REFRESH_INTERVALS } from '@config/constants';
import { api } from '@services/apiClient';

interface UseChatsOptions {
  filters?: ChatFilters;
  autoRefresh?: boolean;
  refreshInterval?: number;
  page?: number;
  limit?: number;
}

interface UseChatsReturn {
  chats: Chat[];
  totalCount: number;
  isLoading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  updateFilters: (filters: Partial<ChatFilters>) => void;
  takeoverChat: (chatId: string) => Promise<void>;
  closeChat: (chatId: string) => Promise<void>;
  pagination: {
    page: number;
    totalPages: number;
    hasMore: boolean;
  };
}

export const useChats = (options: UseChatsOptions = {}): UseChatsReturn => {
  const { 
    filters = {}, 
    autoRefresh = true, 
    refreshInterval = REFRESH_INTERVALS.CHAT_LIST,
    page: requestedPage = 1,
    limit = 20,
  } = options;
  
  const { registerHandlers, unregisterHandlers } = useSocket();
  const { playHandoff } = useNotificationSound();
  
  const [chats, setChats] = useState<Chat[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [currentFilters, setCurrentFilters] = useState<ChatFilters>(filters);
  
  const [currentPage, setCurrentPage] = useState(requestedPage);
  const [totalPages, setTotalPages] = useState(1);
  const refreshIntervalRef = useRef<NodeJS.Timeout | null>(null);

  // Fetch chats
  const fetchChats = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    
    try {
      // Build query params
      const params = new URLSearchParams();
      if (currentFilters.tenantId) params.append('tenantId', currentFilters.tenantId);
      if (currentFilters.status) params.append('status', currentFilters.status);
      if (currentFilters.assignedAgentId) params.append('assignedAgentId', currentFilters.assignedAgentId);
      if (currentFilters.search) params.append('search', currentFilters.search);
      if (currentFilters.dateFrom) params.append('dateFrom', currentFilters.dateFrom);
      if (currentFilters.dateTo) params.append('dateTo', currentFilters.dateTo);
      if (currentPage) params.append('page', String(currentPage));
      if (limit) params.append('limit', String(limit));
      
      const data = await api.get<any>(`/chats/sessions?${params.toString()}`);
      setChats(data.data || []);
      const total = data.meta?.total || data.pagination?.total || 0;
      setTotalCount(total);
      setTotalPages(data.meta?.totalPages || data.pagination?.totalPages || Math.ceil(total / limit) || 1);
    } catch (err: any) {
      setError(err.message || 'Failed to load chats');
    } finally {
      setIsLoading(false);
    }
  }, [currentFilters, currentPage, limit]);

  // Sync page from caller
  useEffect(() => {
    setCurrentPage(requestedPage);
  }, [requestedPage]);

  // Initial fetch and auto-refresh
  useEffect(() => {
    fetchChats();
    
    if (autoRefresh) {
      refreshIntervalRef.current = setInterval(fetchChats, refreshInterval);
    }
    
    return () => {
      if (refreshIntervalRef.current) {
        clearInterval(refreshIntervalRef.current);
      }
    };
  }, [fetchChats, autoRefresh, refreshInterval]);

  // Register socket handlers
  useEffect(() => {
    const handlers = registerHandlers({
      onChatNew: (newChat: Chat) => {
        setChats((prev) => {
          // Check if chat matches current filters
          if (currentFilters.status && newChat.status !== currentFilters.status) {
            return prev;
          }
          if (currentFilters.tenantId && newChat.tenantId !== currentFilters.tenantId) {
            return prev;
          }
          
          // Avoid duplicates
          if (prev.some((c) => c.id === newChat.id)) return prev;
          
          // Play sound for new handoff requests
          if (newChat.status === 'handsoff') {
            playHandoff();
          }
          
          return [newChat, ...prev];
        });
        setTotalCount((prev) => prev + 1);
      },
      onChatUpdate: (updatedChat: Chat) => {
        setChats((prev) => {
          const index = prev.findIndex((c) => c.id === updatedChat.id);
          if (index === -1) {
            // Chat not in list, check if it should be added
            if (currentFilters.status && updatedChat.status !== currentFilters.status) {
              return prev;
            }
            if (currentFilters.tenantId && updatedChat.tenantId !== currentFilters.tenantId) {
              return prev;
            }
            return [updatedChat, ...prev];
          }
          
          // Update existing chat
          const newChats = [...prev];
          newChats[index] = updatedChat;
          
          // Sort by last message time
          return newChats.sort((a, b) => {
            const timeA = a.lastMessageAt ? new Date(a.lastMessageAt).getTime() : 0;
            const timeB = b.lastMessageAt ? new Date(b.lastMessageAt).getTime() : 0;
            return timeB - timeA;
          });
        });
      },
    });

    return () => {
      unregisterHandlers(handlers);
    };
  }, [registerHandlers, unregisterHandlers, currentFilters, playHandoff]);

  // Update filters
  const updateFilters = useCallback((newFilters: Partial<ChatFilters>) => {
    setCurrentFilters((prev) => ({ ...prev, ...newFilters }));
  }, []);

  // Takeover chat
  const takeoverChat = useCallback(async (chatId: string) => {
    try {
      await api.post(`/chats/${chatId}/takeover`);
      
      // Refresh chat list
      await fetchChats();
    } catch (err: any) {
      setError(err.message || 'Failed to takeover chat');
      throw err;
    }
  }, [fetchChats]);

  // Close chat
  const closeChat = useCallback(async (chatId: string) => {
    try {
      await api.post(`/chats/${chatId}/close`);
      
      // Update local state
      setChats((prev) => prev.filter((c) => c.id !== chatId));
      setTotalCount((prev) => prev - 1);
    } catch (err: any) {
      setError(err.message || 'Failed to close chat');
      throw err;
    }
  }, []);

  return {
    chats,
    totalCount,
    isLoading,
    error,
    refresh: fetchChats,
    updateFilters,
    takeoverChat,
    closeChat,
    pagination: {
      page: currentPage,
      totalPages,
      hasMore: currentPage < totalPages,
    },
  };
};

export default useChats;
