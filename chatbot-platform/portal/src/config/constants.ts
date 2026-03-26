/**
 * Application Constants
 */

// Session & Storage
export const STORAGE_KEYS = {
  ACCESS_TOKEN: 'handsoff_access_token',
  REFRESH_TOKEN: 'handsoff_refresh_token',
  USER: 'handsoff_user',
  PREFERENCES: 'handsoff_preferences',
  THEME: 'handsoff_theme',
} as const;

// Timeouts (in milliseconds)
export const TIMEOUTS = {
  TYPING_INDICATOR: 3000,
  MESSAGE_REFRESH: 5000,
  NOTIFICATION_DISPLAY: 5000,
  SESSION_WARNING: 300000, // 5 minutes before expiry
  AUTO_LOGOUT: 1800000, // 30 minutes of inactivity
} as const;

// Limits
export const LIMITS = {
  MAX_FILE_SIZE: 10 * 1024 * 1024, // 10MB
  MAX_MESSAGE_LENGTH: 2000,
  MAX_CONCURRENT_CHATS: 5,
  TYPING_DEBOUNCE: 500,
} as const;

// File Types
export const ALLOWED_FILE_TYPES = {
  images: ['image/jpeg', 'image/png', 'image/gif', 'image/webp'],
  documents: ['application/pdf', 'text/plain', 'application/msword'],
  videos: ['video/mp4', 'video/webm'],
  audio: ['audio/mpeg', 'audio/wav', 'audio/ogg'],
} as const;

// Sound Notifications
export const SOUND_URLS = {
  handoff: '/sounds/handoff.mp3',
  message: '/sounds/message.mp3',
  notification: '/sounds/notification.mp3',
} as const;

// Dashboard Refresh Intervals (in milliseconds)
export const REFRESH_INTERVALS = {
  METRICS: 60000, // 60s — WebSocket handles real-time, polling is fallback
  CHAT_LIST: 30000, // 30s
  QUEUE: 30000, // 30s
  AGENTS: 30000, // 30s
} as const;

// SLA Thresholds (in minutes)
export const SLA_THRESHOLDS = {
  FIRST_RESPONSE: 2,
  RESOLUTION: 30,
  HANDOFF_ACCEPT: 1,
} as const;

// Date Formats
export const DATE_FORMATS = {
  DISPLAY: 'MMM dd, yyyy HH:mm',
  DISPLAY_SHORT: 'MMM dd, HH:mm',
  TIME: 'HH:mm',
  DATE: 'yyyy-MM-dd',
  ISO: "yyyy-MM-dd'T'HH:mm:ss.SSS'Z'",
} as const;

// Roles & Permissions
export const ROLE_PERMISSIONS = {
  super_admin: [
    'view:all_chats',
    'manage:agents',
    'manage:tenants',
    'manage:settings',
    'view:analytics',
    'takeover:any_chat',
    'manage:team',
    'admin:tenants',
    'admin:users',
    'admin:analytics',
  ],
  admin: [
    'view:all_chats',
    'manage:agents',
    'manage:tenants',
    'manage:settings',
    'view:analytics',
    'takeover:any_chat',
    'manage:team',
  ],
  supervisor: [
    'view:tenant_chats',
    'view:agents',
    'view:analytics',
    'takeover:tenant_chat',
    'assign:chats',
    'manage:shifts',
  ],
  agent: [
    'view:assigned_chats',
    'takeover:assigned_chat',
    'send:messages',
    'view:own_analytics',
  ],
} as const;

// Chat Status Transitions
export const CHAT_STATUS_TRANSITIONS = {
  bot: ['handsoff', 'closed'],
  handsoff: ['human', 'closed', 'bot'],
  human: ['closed', 'bot'],
  closed: [],
  pending: ['bot', 'human', 'closed'],
} as const;

// WebSocket Events
export const WS_EVENTS = {
  // Connection
  CONNECT: 'connect',
  DISCONNECT: 'disconnect',
  CONNECT_ERROR: 'connect_error',
  
  // Agent Events
  AGENT_JOIN: 'agent:join',
  AGENT_LEAVE: 'agent:leave',
  AGENT_STATUS: 'agent:status',
  AGENT_UPDATE: 'agent:update',
  
  // Chat Events
  CHAT_NEW: 'chat:new',
  CHAT_UPDATE: 'chat:update',
  CHAT_JOIN: 'chat:join',
  CHAT_LEAVE: 'chat:leave',
  CHAT_MESSAGE: 'chat:message',
  CHAT_MESSAGE_RECEIVED: 'chat:message:received',
  CHAT_TYPING: 'chat:typing',
  CHAT_TYPING_UPDATE: 'chat:typing:update',
  
  // Handoff Events
  HANDOFF_NEW: 'handoff:new',
  HANDOFF_UPDATE: 'handoff:update',
  HANDOFF_ACCEPT: 'handoff:accept',
  HANDOFF_DECLINE: 'handoff:decline',
  
  // Notification Events
  NOTIFICATION: 'notification',
  
  // Metrics Events
  METRICS_UPDATE: 'metrics:update',
} as const;
