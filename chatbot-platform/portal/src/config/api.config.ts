/**
 * API Configuration
 * Centralized configuration for all API endpoints and settings
 */

const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:5000/api/v1';
const WS_BASE_URL = import.meta.env.VITE_WS_URL || 'http://localhost:5000';

export const API_CONFIG = {
  baseURL: API_BASE_URL,
  timeout: 30000,
  headers: {
    'Content-Type': 'application/json',
  },
} as const;

export const WS_CONFIG = {
  url: WS_BASE_URL,
  options: {
    transports: ['websocket', 'polling'] as string[],
    reconnection: true,
    reconnectionAttempts: 5,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000,
    randomizationFactor: 0.5,
  },
} as const;

export const ENDPOINTS = {
  // Auth
  auth: {
    login: '/auth/login',
    logout: '/auth/logout',
    refresh: '/auth/refresh',
    verify2FA: '/auth/2fa/verify',
    setup2FA: '/auth/2fa/setup',
    disable2FA: '/auth/2fa/disable',
    me: '/auth/me',
  },
  
  // Users
  users: {
    base: '/users',
    byId: (id: string) => `/users/${id}`,
    profile: '/users/profile',
    preferences: '/users/preferences',
    password: '/users/password',
  },
  
  // Chats
  chats: {
    base: '/chats',
    byId: (id: string) => `/chats/${id}`,
    messages: (id: string) => `/chats/${id}/messages`,
    takeover: (id: string) => `/chats/${id}/takeover`,
    transfer: (id: string) => `/chats/${id}/transfer`,
    close: (id: string) => `/chats/${id}/close`,
    history: (id: string) => `/chats/${id}/history`,
  },
  
  // Handoffs
  handoffs: {
    base: '/handoffs',
    byId: (id: string) => `/handoffs/${id}`,
    accept: (id: string) => `/handoffs/${id}/accept`,
    decline: (id: string) => `/handoffs/${id}/decline`,
    queue: '/handoffs/queue',
  },
  
  // Agents
  agents: {
    base: '/agents',
    byId: (id: string) => `/agents/${id}`,
    status: (id: string) => `/agents/${id}/status`,
    performance: (id: string) => `/agents/${id}/performance`,
    shifts: (id: string) => `/agents/${id}/shifts`,
  },
  
  // Tenants
  tenants: {
    base: '/tenants',
    byId: (id: string) => `/tenants/${id}`,
    settings: (id: string) => `/tenants/${id}/settings`,
    webhook: (id: string) => `/tenants/${id}/webhook`,
    regenerateKey: (id: string) => `/tenants/${id}/regenerate-key`,
  },
  
  // Analytics
  analytics: {
    dashboard: '/analytics/dashboard',
    chats: '/analytics/chats',
    agents: '/analytics/agents',
    tenants: '/analytics/tenants',
    export: '/analytics/export',
  },
  
  // Files
  files: {
    upload: '/files/upload',
    preview: (id: string) => `/files/${id}/preview`,
    download: (id: string) => `/files/${id}/download`,
  },
  
  // Notifications
  notifications: {
    base: '/notifications',
    markRead: (id: string) => `/notifications/${id}/read`,
    markAllRead: '/notifications/read-all',
  },
} as const;

export const PAGINATION = {
  defaultPage: 1,
  defaultLimit: 20,
  maxLimit: 100,
} as const;

export const CHAT_STATUS_COLORS = {
  bot: 'bg-chat-bot',
  human: 'bg-chat-human',
  handsoff: 'bg-chat-handsoff',
  closed: 'bg-chat-closed',
  pending: 'bg-text-muted',
} as const;

export const USER_STATUS_COLORS = {
  online: 'bg-status-online',
  away: 'bg-status-away',
  offline: 'bg-status-offline',
  busy: 'bg-status-busy',
} as const;

export const PRIORITY_COLORS = {
  low: 'bg-primary-600/20 text-primary-300',
  medium: 'bg-accent-500/20 text-accent-300',
  high: 'bg-orange-500/20 text-orange-300',
  urgent: 'bg-red-500/20 text-red-300',
} as const;
