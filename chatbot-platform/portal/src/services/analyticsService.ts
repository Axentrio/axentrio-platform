/**
 * Analytics Service
 * API methods for analytics operations
 */

import apiClient, { api } from './apiClient';
import { ENDPOINTS } from '@config/api.config';
import type { 
  DashboardMetrics, 
  ChatMetrics, 
  AgentMetrics, 
  ApiResponse,
  TimeRange 
} from '@app-types/index';

interface GetChatMetricsParams extends TimeRange {
  tenantId?: string;
  agentId?: string;
  groupBy?: 'day' | 'week' | 'month';
}

interface GetAgentMetricsParams extends TimeRange {
  tenantId?: string;
}

export const analyticsService = {
  // Get dashboard metrics
  getDashboardMetrics: async (): Promise<ApiResponse<DashboardMetrics>> => {
    return api.get(ENDPOINTS.analytics.dashboard);
  },

  // Get chat metrics
  getChatMetrics: async (params: GetChatMetricsParams): Promise<ApiResponse<ChatMetrics[]>> => {
    const queryParams = new URLSearchParams();
    
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined && value !== null) {
        queryParams.append(key, String(value));
      }
    });
    
    return api.get(`${ENDPOINTS.analytics.chats}?${queryParams.toString()}`);
  },

  // Get agent metrics
  getAgentMetrics: async (params: GetAgentMetricsParams): Promise<ApiResponse<AgentMetrics[]>> => {
    const queryParams = new URLSearchParams();
    
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined && value !== null) {
        queryParams.append(key, String(value));
      }
    });
    
    return api.get(`${ENDPOINTS.analytics.agents}?${queryParams.toString()}`);
  },

  // Get tenant metrics (admin only)
  getTenantMetrics: async (timeRange: TimeRange): Promise<ApiResponse<any[]>> => {
    const queryParams = new URLSearchParams({
      start: timeRange.start,
      end: timeRange.end,
    });
    
    return api.get(`${ENDPOINTS.analytics.tenants}?${queryParams.toString()}`);
  },

  // Export analytics data
  exportData: async (
    type: 'chats' | 'agents' | 'tenants',
    format: 'csv' | 'json' | 'xlsx',
    timeRange: TimeRange
  ): Promise<Blob> => {
    const response = await apiClient.post(
      `${ENDPOINTS.analytics.export}?type=${type}&format=${format}`,
      timeRange,
      { responseType: 'blob' }
    );
    return response.data;
  },
};

export default analyticsService;
