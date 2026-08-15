// ============================================
// User & Authentication Types
// ============================================

export type UserRole = 'super_admin' | 'admin' | 'supervisor' | 'agent';

export type UserStatus = 'online' | 'away' | 'offline' | 'busy';

export interface User {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  role: UserRole;
  status: UserStatus;
  avatar?: string;
  tenantId?: string;
  createdAt: string;
  updatedAt: string;
  lastLoginAt?: string;
  preferences?: UserPreferences;
}

export interface UserPreferences {
  theme: 'light' | 'dark' | 'system';
  notifications: {
    sound: boolean;
    desktop: boolean;
    handsoffOnly: boolean;
  };
  language: string;
}

export interface LoginCredentials {
  email: string;
  password: string;
}

export interface TwoFactorPayload {
  code: string;
  tempToken: string;
}

export interface AuthResponse {
  user: User;
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

// ============================================
// Tenant Types
// ============================================

export interface Tenant {
  id: string;
  name: string;
  slug: string;
  logo?: string;
  favicon?: string;
  primaryColor: string;
  secondaryColor: string;
  webhookUrl?: string;
  apiKey?: string;
  settings: TenantSettings;
  createdAt: string;
  updatedAt: string;
  isActive: boolean;
  maxAgents: number;
  currentAgents: number;
}

export interface TenantSettings {
  theme?: {
    primaryColor?: string;
    logoUrl?: string;
    customCss?: string;
  };
  businessHours: BusinessHours;
  autoHandoff: boolean;
  handoffTriggers: HandoffTriggers;
  responseTimeSLA: number; // in minutes
  csatEnabled: boolean;
}

export interface BusinessHours {
  timezone: string;
  schedule: DaySchedule[];
}

export interface DaySchedule {
  day: string;
  isOpen: boolean;
  openTime: string;
  closeTime: string;
}

export interface HandoffTriggers {
  sentimentThreshold: number;
  consecutiveFailures: number;
  explicitRequest: boolean;
  timeoutSeconds: number;
}

// ============================================
// Chat & Message Types
// ============================================

export type ChatStatus = 'bot' | 'handsoff' | 'human' | 'closed' | 'pending';

export type MessageType = 'text' | 'image' | 'file' | 'audio' | 'video' | 'system';

export type MessageSender = 'user' | 'bot' | 'agent' | 'system';

export interface Chat {
  id: string;
  sessionId: string;
  tenantId: string;
  tenantName?: string;
  userId: string;
  userName?: string;
  userEmail?: string;
  status: ChatStatus;
  // Guardrail state: false = AI auto-reply paused by a guardrail (status stays
  // 'bot'); guardrailStatus is the reason category (spam/scam/phishing/bot_loop).
  aiAutoReplyEnabled?: boolean;
  guardrailStatus?: string;
  assignedAgentId?: string | null;
  assignedAgentName?: string | null;
  messages: Message[];
  metadata: ChatMetadata;
  createdAt: string;
  updatedAt: string;
  lastMessageAt?: string;
  lastActivityAt?: string;
  closedAt?: string;
  csatScore?: number;
  // ── Live-inbox summary fields (B-PR3a conversation:upsert / REST list row) ──
  /** Last-message preview (server truncates to 80 chars). */
  lastMessage?: string | null;
  lastMessageSender?: string | null;
  messageCount?: number;
  ownership?: string;
  ownershipVersion?: number;
  channel?: string;
  botId?: string;
}

export interface ChatMetadata {
  userAgent?: string;
  ipAddress?: string;
  source: string;
  pageUrl?: string;
  referrer?: string;
  customData?: Record<string, unknown>;
}

export interface Message {
  id: string;
  chatId: string;
  type: MessageType;
  content: string;
  sender: MessageSender;
  senderId?: string;
  senderName?: string;
  fileUrl?: string;
  fileName?: string;
  fileSize?: number;
  fileType?: string;
  isRead: boolean;
  createdAt: string;
  updatedAt?: string;
  /** Client-generated idempotency id for operator replies (B-PR3b composer). */
  clientMessageId?: string;
  /**
   * Composer delivery state. 'pending' = optimistic, POST in flight;
   * 'failed' = the POST failed or the server reports message.status='failed'
   * (retryable with the SAME clientMessageId); absent/'sent' = delivered.
   */
  deliveryState?: 'pending' | 'sent' | 'failed';
}

// ============================================
// Realtime conversation events (B-PR3a wire contract)
// ============================================

/**
 * `conversation:upsert` summary payload — the SAME serializer as the REST
 * GET /chats/sessions row (api/src/realtime/conversation-serializer.ts).
 * `status` is the BACKEND vocabulary ('active'|'closed'|'waiting'|'handoff'|'bot').
 * `assignedAgentName` is OMITTED (not null) when the agent relation was not
 * loaded server-side — merge defined fields only, never clobber with undefined.
 */
export interface ConversationSummaryPayload {
  id: string;
  sessionId: string;
  status: string;
  aiAutoReplyEnabled?: boolean;
  guardrailStatus?: string;
  userName?: string;
  assignedAgent?: { id: string } | null;
  assignedAgentName?: string | null;
  messageCount?: number;
  lastMessage?: string | null;
  lastMessageSender?: string | null;
  lastMessageAt?: string | null;
  lastActivityAt?: string;
  source?: string;
  createdAt?: string;
  tenantId?: string;
  botId?: string;
  ownership?: string;
  ownershipVersion?: number;
  assignedAgentId?: string | null;
  channel?: string;
}

export interface ConversationUpsertEvent {
  conversation: ConversationSummaryPayload;
  /** Emit-time epoch-ms clock; the client drops a strictly LOWER revision. */
  revision: number;
}

/** `message:created` message payload (api serializeMessage). */
export interface MessageCreatedPayload {
  id: string;
  sessionId: string;
  type: string;
  content: string;
  senderType: string;
  sender: string;
  status: string;
  createdAt: string;
  timestamp: string;
  metadata?: Record<string, unknown>;
}

export interface MessageCreatedEvent {
  sessionId: string;
  message: MessageCreatedPayload;
  conversationRevision: number;
}

/**
 * The `conversation` object the POST /chats/:sessionId/{takeover,release,
 * cancel,close,messages} command responses carry (a REDUCED summary from the
 * command service — no userName/lastMessage/lastActivityAt).
 */
export interface CommandConversationSummary {
  sessionId: string;
  tenantId: string;
  status: string;
  ownership: string;
  ownershipVersion: number;
  assignedAgentId: string | null;
  humanControlMode?: 'timed' | 'indefinite' | null;
  openHandoffId?: string | null;
}

export interface TypingIndicator {
  chatId: string;
  userId: string;
  userName: string;
  isTyping: boolean;
  timestamp: string;
}

// ============================================
// Handoff Request Types
// ============================================

export type HandoffPriority = 'low' | 'medium' | 'high' | 'urgent';

export type HandoffReason = 
  | 'user_request' 
  | 'sentiment_drop' 
  | 'bot_failure' 
  | 'timeout' 
  | 'complex_query';

export interface HandoffRequest {
  id: string;
  chatId: string;
  tenantId: string;
  tenantName?: string;
  userId: string;
  userName?: string;
  priority: HandoffPriority;
  reason: HandoffReason;
  reasonDetails?: string;
  status: 'pending' | 'assigned' | 'resolved' | 'cancelled';
  assignedAgentId?: string;
  assignedAgentName?: string;
  requestedAt: string;
  assignedAt?: string;
  resolvedAt?: string;
  waitTime: number; // in seconds
  messageCount: number;
}

// ============================================
// Agent & Team Types
// ============================================

export interface Agent {
  id: string;
  userId: string;
  email: string;
  firstName: string;
  lastName: string;
  avatar?: string;
  role: UserRole;
  status: UserStatus;
  tenantId?: string;
  skills: string[];
  maxConcurrentChats: number;
  currentChats: number;
  isActive: boolean;
  createdAt: string;
  performance?: AgentPerformance;
  shift?: AgentShift;
}

export interface AgentPerformance {
  totalChats: number;
  avgResponseTime: number; // in seconds
  avgResolutionTime: number; // in minutes
  csatScore: number;
  handoffAcceptanceRate: number;
  onlineHours: number;
}

export interface AgentShift {
  id: string;
  agentId: string;
  dayOfWeek: number;
  startTime: string;
  endTime: string;
  timezone: string;
}

// ============================================
// Analytics Types
// ============================================

export interface DashboardMetrics {
  activeChats: number;
  pendingHandoffs: number;
  avgWaitTime: number;
  avgResponseTime: number;
  onlineAgents: number;
  totalAgents: number;
  csatScore: number;
  botResolutionRate: number;
}

export interface ChatMetrics {
  date: string;
  totalChats: number;
  botChats: number;
  humanChats: number;
  handoffs: number;
  avgResponseTime: number;
  csatScore: number;
}

export interface AgentMetrics {
  agentId: string;
  agentName: string;
  totalChats: number;
  avgResponseTime: number;
  avgResolutionTime: number;
  csatScore: number;
  onlineHours: number;
}

export interface TimeRange {
  start: string;
  end: string;
}

// ============================================
// Notification Types
// ============================================

export type NotificationType = 'handoff' | 'message' | 'system' | 'alert';

export interface Notification {
  id: string;
  type: NotificationType;
  title: string;
  message: string;
  data?: Record<string, unknown>;
  isRead: boolean;
  createdAt: string;
}

// ============================================
// WebSocket Event Types
// ============================================

export interface WebSocketEvents {
  // Client -> Server
  'agent:join': { agentId: string };
  'agent:leave': { agentId: string };
  'agent:status': { agentId: string; status: UserStatus };
  'chat:join': { chatId: string; agentId: string };
  'chat:leave': { chatId: string; agentId: string };
  'chat:message': { chatId: string; message: Partial<Message> };
  'chat:typing': { chatId: string; isTyping: boolean };
  'handoff:accept': { handoffId: string; agentId: string };
  'handoff:decline': { handoffId: string; agentId: string; reason?: string };
  
  // Server -> Client
  'chat:new': Chat;
  'chat:update': Chat;
  'chat:message:received': Message;
  'chat:typing:update': TypingIndicator;
  'handoff:new': HandoffRequest;
  'handoff:update': HandoffRequest;
  'agent:update': Agent;
  'notification': Notification;
  'metrics:update': DashboardMetrics;
}

// ============================================
// API Response Types
// ============================================

export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: ApiError;
  meta?: ApiMeta;
}

export interface ApiError {
  code: string;
  message: string;
  details?: Record<string, string[]>;
}

export interface ApiMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

// ============================================
// Filter & Pagination Types
// ============================================

export interface ChatFilters {
  tenantId?: string;
  status?: ChatStatus;
  assignedAgentId?: string;
  search?: string;
  dateFrom?: string;
  dateTo?: string;
}

export interface PaginationParams {
  page: number;
  limit: number;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
}

// ============================================
// File Types
// ============================================

export interface FileUpload {
  file: File;
  preview?: string;
  progress: number;
  status: 'pending' | 'uploading' | 'completed' | 'error';
  error?: string;
}

