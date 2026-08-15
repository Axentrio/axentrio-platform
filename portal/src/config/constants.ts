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
  DESKTOP_NOTIFICATIONS: 'handsoff_desktop_notifications',
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
  CHAT_JOIN: 'session:join',
  CHAT_LEAVE: 'session:leave',
  CHAT_TYPING: 'typing:indicator',
  CHAT_TYPING_UPDATE: 'typing:indicator',

  // Normalized conversation events (B-PR3a contract) — the ONLY events the
  // Inbox list/detail consume. The legacy chat:new/chat:update names were
  // NEVER emitted by the backend; message:receive still is (adapter) but the
  // portal listens to message:created only to avoid double-handling.
  CONVERSATION_UPSERT: 'conversation:upsert',
  MESSAGE_CREATED: 'message:created',

  // Handoff Events (inbound only — accept/decline go over REST commands now)
  HANDOFF_NEW: 'handoff:requested',
  HANDOFF_UPDATE: 'handoff:update',
  
  // Notification Events
  NOTIFICATION: 'notification',
  
  // Metrics Events
  METRICS_UPDATE: 'metrics:update',
} as const;
