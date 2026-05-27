/**
 * Tenant Service
 * API methods for tenant operations
 */

import { api } from './apiClient';
import { ENDPOINTS } from '@config/api.config';
import type { Tenant, TenantSettings, ApiResponse, PaginationParams } from '@app-types/index';

interface GetTenantsParams extends PaginationParams {
  search?: string;
  isActive?: boolean;
}

interface CreateTenantData {
  name: string;
  slug: string;
  primaryColor?: string;
  secondaryColor?: string;
  webhookUrl?: string;
  settings?: Partial<TenantSettings>;
  maxAgents?: number;
}

interface UpdateTenantData {
  name?: string;
  logo?: string;
  favicon?: string;
  primaryColor?: string;
  secondaryColor?: string;
  webhookUrl?: string;
  settings?: Partial<TenantSettings>;
  maxAgents?: number;
  isActive?: boolean;
}

export const tenantService = {
  // Get all tenants
  getTenants: async (params: GetTenantsParams = { page: 1, limit: 20 }): Promise<ApiResponse<Tenant[]>> => {
    const queryParams = new URLSearchParams();
    
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined && value !== null) {
        queryParams.append(key, String(value));
      }
    });
    
    return api.get(`${ENDPOINTS.tenants.base}?${queryParams.toString()}`);
  },

  // Get single tenant
  getTenant: async (tenantId: string): Promise<ApiResponse<Tenant>> => {
    return api.get(ENDPOINTS.tenants.byId(tenantId));
  },

  // Create tenant
  createTenant: async (data: CreateTenantData): Promise<ApiResponse<Tenant>> => {
    return api.post(ENDPOINTS.tenants.base, data);
  },

  // Update tenant
  updateTenant: async (tenantId: string, data: UpdateTenantData): Promise<ApiResponse<Tenant>> => {
    return api.patch(ENDPOINTS.tenants.byId(tenantId), data);
  },

  // Delete tenant
  deleteTenant: async (tenantId: string): Promise<ApiResponse<void>> => {
    return api.delete(ENDPOINTS.tenants.byId(tenantId));
  },

  // Update tenant settings
  updateSettings: async (tenantId: string, settings: Partial<TenantSettings>): Promise<ApiResponse<Tenant>> => {
    return api.patch(ENDPOINTS.tenants.settings(tenantId), settings);
  },

  // Update webhook URL
  updateWebhook: async (tenantId: string, webhookUrl: string): Promise<ApiResponse<Tenant>> => {
    return api.patch(ENDPOINTS.tenants.webhook(tenantId), { webhookUrl });
  },

  // Regenerate API key
  regenerateApiKey: async (tenantId: string): Promise<ApiResponse<{ apiKey: string }>> => {
    return api.post(ENDPOINTS.tenants.regenerateKey(tenantId));
  },

  // Upload logo
  uploadLogo: async (tenantId: string, file: File): Promise<ApiResponse<{ logo: string }>> => {
    const formData = new FormData();
    formData.append('logo', file);
    
    return api.post(`${ENDPOINTS.tenants.byId(tenantId)}/logo`, formData, {
      headers: {
        'Content-Type': 'multipart/form-data',
      },
    });
  },
};

export default tenantService;
