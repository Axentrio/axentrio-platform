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
  
  // Chat Events — names must match backend socket.handler.ts
  CHAT_NEW: 'chat:new',
  CHAT_UPDATE: 'chat:update',
  CHAT_JOIN: 'session:join',
  CHAT_LEAVE: 'session:leave',
  CHAT_MESSAGE: 'message:send',
  CHAT_MESSAGE_RECEIVED: 'message:receive',
  CHAT_TYPING: 'typing:indicator',
  CHAT_TYPING_UPDATE: 'typing:indicator',
  
  // Handoff Events
  HANDOFF_NEW: 'handoff:requested',
  HANDOFF_UPDATE: 'handoff:update',
  HANDOFF_ACCEPT: 'handoff:accept',
  HANDOFF_DECLINE: 'handoff:decline',
  
  // Notification Events
  NOTIFICATION: 'notification',
  
  // Metrics Events
  METRICS_UPDATE: 'metrics:update',
} as const;
