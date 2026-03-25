/**
 * Chat Service
 * API methods for chat operations
 */

import { api } from './apiClient';
import { ENDPOINTS } from '@config/api.config';
import type { Chat, Message, ChatFilters, PaginationParams, ApiResponse } from '@app-types/index';

interface GetChatsParams extends ChatFilters, PaginationParams {}

export const chatService = {
  // Get all chats with filters
  getChats: async (params: GetChatsParams = { page: 1, limit: 20 }): Promise<ApiResponse<Chat[]>> => {
    const queryParams = new URLSearchParams();
    
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined && value !== null) {
        queryParams.append(key, String(value));
      }
    });
    
    return api.get(`${ENDPOINTS.chats.base}?${queryParams.toString()}`);
  },

  // Get single chat
  getChat: async (chatId: string): Promise<ApiResponse<Chat>> => {
    return api.get(ENDPOINTS.chats.byId(chatId));
  },

  // Get chat messages
  getMessages: async (chatId: string, params?: PaginationParams): Promise<ApiResponse<Message[]>> => {
    const queryParams = new URLSearchParams();
    
    if (params) {
      Object.entries(params).forEach(([key, value]) => {
        if (value !== undefined) {
          queryParams.append(key, String(value));
        }
      });
    }
    
    return api.get(`${ENDPOINTS.chats.messages(chatId)}?${queryParams.toString()}`);
  },

  // Send message
  sendMessage: async (chatId: string, content: string, type: Message['type'] = 'text'): Promise<ApiResponse<Message>> => {
    return api.post(ENDPOINTS.chats.messages(chatId), {
      content,
      type,
    });
  },

  // Takeover chat
  takeoverChat: async (chatId: string): Promise<ApiResponse<Chat>> => {
    return api.post(ENDPOINTS.chats.takeover(chatId));
  },

  // Transfer chat to another agent
  transferChat: async (chatId: string, agentId: string): Promise<ApiResponse<Chat>> => {
    return api.post(ENDPOINTS.chats.transfer(chatId), { agentId });
  },

  // Close chat
  closeChat: async (chatId: string): Promise<ApiResponse<Chat>> => {
    return api.post(ENDPOINTS.chats.close(chatId));
  },

  // Get chat history
  getChatHistory: async (chatId: string): Promise<ApiResponse<Message[]>> => {
    return api.get(ENDPOINTS.chats.history(chatId));
  },

  // Mark messages as read
  markAsRead: async (chatId: string, messageIds?: string[]): Promise<ApiResponse<void>> => {
    return api.post(`${ENDPOINTS.chats.byId(chatId)}/read`, { messageIds });
  },
};

export default chatService;
