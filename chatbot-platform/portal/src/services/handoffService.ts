/**
 * Handoff Service
 * API methods for handoff operations
 */

import { api } from './apiClient';
import { ENDPOINTS } from '@config/api.config';
import type { HandoffRequest, ApiResponse, PaginationParams } from '@app-types/index';

interface GetHandoffsParams extends PaginationParams {
  status?: 'pending' | 'assigned' | 'resolved' | 'cancelled';
  tenantId?: string;
}

export const handoffService = {
  // Get all handoffs
  getHandoffs: async (params: GetHandoffsParams = { page: 1, limit: 20 }): Promise<ApiResponse<HandoffRequest[]>> => {
    const queryParams = new URLSearchParams();
    
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined && value !== null) {
        queryParams.append(key, String(value));
      }
    });
    
    return api.get(`${ENDPOINTS.handoffs.base}?${queryParams.toString()}`);
  },

  // Get handoff queue (pending only)
  getQueue: async (): Promise<ApiResponse<HandoffRequest[]>> => {
    return api.get(ENDPOINTS.handoffs.queue);
  },

  // Get single handoff
  getHandoff: async (handoffId: string): Promise<ApiResponse<HandoffRequest>> => {
    return api.get(ENDPOINTS.handoffs.byId(handoffId));
  },

  // Accept handoff
  acceptHandoff: async (handoffId: string): Promise<ApiResponse<HandoffRequest>> => {
    return api.post(ENDPOINTS.handoffs.accept(handoffId));
  },

  // Decline handoff
  declineHandoff: async (handoffId: string, reason?: string): Promise<ApiResponse<HandoffRequest>> => {
    return api.post(ENDPOINTS.handoffs.decline(handoffId), { reason });
  },

  // Create handoff (for testing/admin)
  createHandoff: async (data: {
    chatId: string;
    priority: HandoffRequest['priority'];
    reason: HandoffRequest['reason'];
    reasonDetails?: string;
  }): Promise<ApiResponse<HandoffRequest>> => {
    return api.post(ENDPOINTS.handoffs.base, data);
  },
};

export default handoffService;
