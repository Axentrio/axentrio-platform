/**
 * Agent Service
 * API methods for agent operations
 */

import { api } from './apiClient';
import { ENDPOINTS } from '@config/api.config';
import type { Agent, AgentPerformance, AgentShift, ApiResponse, PaginationParams } from '@app-types/index';

interface GetAgentsParams extends PaginationParams {
  tenantId?: string;
  status?: Agent['status'];
  role?: Agent['role'];
}

interface CreateAgentData {
  email: string;
  firstName: string;
  lastName: string;
  role: Agent['role'];
  tenantId?: string;
  skills?: string[];
  maxConcurrentChats?: number;
}

interface UpdateAgentData {
  firstName?: string;
  lastName?: string;
  role?: Agent['role'];
  skills?: string[];
  maxConcurrentChats?: number;
  isActive?: boolean;
}

export const agentService = {
  // Get all agents
  getAgents: async (params: GetAgentsParams = { page: 1, limit: 20 }): Promise<ApiResponse<Agent[]>> => {
    const queryParams = new URLSearchParams();
    
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined && value !== null) {
        queryParams.append(key, String(value));
      }
    });
    
    return api.get(`${ENDPOINTS.agents.base}?${queryParams.toString()}`);
  },

  // Get single agent
  getAgent: async (agentId: string): Promise<ApiResponse<Agent>> => {
    return api.get(ENDPOINTS.agents.byId(agentId));
  },

  // Create agent
  createAgent: async (data: CreateAgentData): Promise<ApiResponse<Agent>> => {
    return api.post(ENDPOINTS.agents.base, data);
  },

  // Update agent
  updateAgent: async (agentId: string, data: UpdateAgentData): Promise<ApiResponse<Agent>> => {
    return api.patch(ENDPOINTS.agents.byId(agentId), data);
  },

  // Delete agent
  deleteAgent: async (agentId: string): Promise<ApiResponse<void>> => {
    return api.delete(ENDPOINTS.agents.byId(agentId));
  },

  // Update agent status
  updateStatus: async (agentId: string, status: Agent['status']): Promise<ApiResponse<Agent>> => {
    return api.patch(ENDPOINTS.agents.status(agentId), { status });
  },

  // Get agent performance
  getPerformance: async (agentId: string, timeRange?: { start: string; end: string }): Promise<ApiResponse<AgentPerformance>> => {
    const queryParams = timeRange ? `?start=${timeRange.start}&end=${timeRange.end}` : '';
    return api.get(`${ENDPOINTS.agents.performance(agentId)}${queryParams}`);
  },

  // Get agent shifts
  getShifts: async (agentId: string): Promise<ApiResponse<AgentShift[]>> => {
    return api.get(ENDPOINTS.agents.shifts(agentId));
  },

  // Create agent shift
  createShift: async (agentId: string, data: Omit<AgentShift, 'id' | 'agentId'>): Promise<ApiResponse<AgentShift>> => {
    return api.post(ENDPOINTS.agents.shifts(agentId), data);
  },

  // Update agent shift
  updateShift: async (agentId: string, shiftId: string, data: Partial<AgentShift>): Promise<ApiResponse<AgentShift>> => {
    return api.patch(`${ENDPOINTS.agents.shifts(agentId)}/${shiftId}`, data);
  },

  // Delete agent shift
  deleteShift: async (agentId: string, shiftId: string): Promise<ApiResponse<void>> => {
    return api.delete(`${ENDPOINTS.agents.shifts(agentId)}/${shiftId}`);
  },
};

export default agentService;
