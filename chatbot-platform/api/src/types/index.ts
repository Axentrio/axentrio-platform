/**
 * Core Type Definitions for Chatbot Platform
 * All TypeScript interfaces and types are defined here
 */

// ============================================================================
// Express Request Extension Types
// ============================================================================

export interface RequestUser {
  id: string;
  email: string;
  role: UserRole;
  tenantId: string;
  clerkUserId?: string;
  type: 'agent' | 'widget';
}

export interface RequestTenant {
  id: string;
  name: string;
  slug: string;
  apiKey: string;
  tier: TenantTier;
  status: TenantStatus;
  settings: ITenantSettings;
}

export interface RequestWidget {
  tenantId: string;
  sessionId?: string;
  visitorId?: string;
}

export interface RequestSession {
  id: string;
  tenantId: string;
  status: string;
}

declare global {
  namespace Express {
    interface Request {
      tenantId?: string;
      userId?: string;
      requestId?: string;
      user?: RequestUser;
      tenant?: RequestTenant;
      widget?: RequestWidget;
      agentId?: string;
      session?: RequestSession;
    }
  }
}

// ============================================================================
// Tenant Types
// ============================================================================

export type TenantTier = 'free' | 'pro' | 'enterprise';
export type TenantStatus = 'active' | 'suspended' | 'cancelled';

export interface ITenant {
  id: string;
  name: string;
  slug: string;
  apiKey: string;
  webhookUrl?: string;
  tier: TenantTier;
  status: TenantStatus;
  settings: ITenantSettings;
  maxSessions: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface ITenantSettings {
  theme?: {
    primaryColor?: string;
    logoUrl?: string;
    customCss?: string;
  };
  features?: {
    fileUploadEnabled: boolean;
    handoffEnabled: boolean;
  };
  businessHours?: {
    enabled: boolean;
    timezone: string;
    schedule: IScheduleDay[];
  };
}

export interface IScheduleDay {
  day: string;
  open: string;
  close: string;
  closed: boolean;
}

// ============================================================================
// User & Agent Types
// ============================================================================

export type UserRole = 'super_admin' | 'admin' | 'supervisor' | 'agent';
export type AgentStatus = 'online' | 'away' | 'busy' | 'offline';

export interface IUser {
  id: string;
  tenantId: string;
  email: string;
  name: string;
  role: UserRole;
  avatarUrl?: string;
  isActive: boolean;
  lastLoginAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface IAgent {
  id: string;
  tenantId: string;
  userId: string;
  status: AgentStatus;
  maxConcurrentChats: number;
  currentChatCount: number;
  skills: string[];
  languages: string[];
  createdAt: Date;
  updatedAt: Date;
}

// ============================================================================
// Chat Session Types
// ============================================================================

export type SessionStatus = 'active' | 'closed' | 'waiting' | 'handoff';
export type ParticipantType = 'user' | 'agent' | 'bot' | 'system';

export interface IChatSession {
  id: string;
  tenantId: string;
  visitorId: string;
  status: SessionStatus;
  assignedAgentId?: string;
  source: string;
  metadata: Record<string, unknown>;
  startedAt: Date;
  endedAt?: Date;
  lastActivityAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface IParticipant {
  id: string;
  sessionId: string;
  type: ParticipantType;
  userId?: string;
  name: string;
  avatarUrl?: string;
  joinedAt: Date;
  leftAt?: Date;
}

// ============================================================================
// Message Types
// ============================================================================

export type MessageType = 'text' | 'image' | 'file' | 'system' | 'typing';
export type MessageStatus = 'sending' | 'sent' | 'delivered' | 'read' | 'failed';

export interface IMessage {
  id: string;
  sessionId: string;
  tenantId: string;
  participantId: string;
  type: MessageType;
  content: string;
  contentEncrypted?: boolean;
  metadata?: IMessageMetadata;
  status: MessageStatus;
  replyToId?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface IMessageMetadata {
  fileName?: string;
  fileSize?: number;
  fileType?: string;
  fileUrl?: string;
  thumbnailUrl?: string;
  duration?: number;
  dimensions?: { width: number; height: number };
  customData?: Record<string, unknown>;
}

export interface ITypingIndicator {
  sessionId: string;
  participantId: string;
  isTyping: boolean;
  timestamp: Date;
}

// ============================================================================
// File Upload Types
// ============================================================================

export type FileUploadStatus = 'pending' | 'uploading' | 'completed' | 'failed' | 'cancelled';

export interface IFileUpload {
  id: string;
  sessionId: string;
  tenantId: string;
  participantId: string;
  fileName: string;
  fileType: string;
  fileSize: number;
  chunkSize: number;
  totalChunks: number;
  uploadedChunks: number[];
  status: FileUploadStatus;
  storagePath?: string;
  publicUrl?: string;
  metadata?: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
  completedAt?: Date;
}

export interface IFileChunk {
  uploadId: string;
  chunkIndex: number;
  totalChunks: number;
  data: Buffer;
  checksum: string;
}

// ============================================================================
// Handoff Types
// ============================================================================

export type HandoffStatus = 'requested' | 'accepted' | 'rejected' | 'completed' | 'timeout';
export type HandoffReason = 'user_request' | 'bot_confidence_low' | 'escalation_trigger' | 'business_hours';

export interface IHandoffRequest {
  id: string;
  sessionId: string;
  tenantId: string;
  requestedBy: string;
  requestedAt: Date;
  status: HandoffStatus;
  reason: HandoffReason;
  priority: 'low' | 'medium' | 'high' | 'urgent';
  assignedAgentId?: string;
  acceptedAt?: Date;
  completedAt?: Date;
  notes?: string;
  context?: Record<string, unknown>;
}

// ============================================================================
// WebSocket Types
// ============================================================================

export interface ISocketAuth {
  token: string;
  tenantId: string;
  sessionId?: string;
  userId?: string;
  type: 'widget' | 'agent' | 'system';
}

export interface ISocketSession {
  socketId: string;
  tenantId: string;
  sessionId?: string;
  userId?: string;
  type: 'widget' | 'agent' | 'system';
  connectedAt: Date;
  lastPingAt: Date;
  rooms: string[];
}

export interface IWebSocketEvent<T = unknown> {
  event: string;
  data: T;
  timestamp: Date;
  tenantId: string;
  sessionId?: string;
}

// ============================================================================
// Queue Types
// ============================================================================

export type QueueJobType = 'message_process' | 'webhook_send' | 'notification_send' | 'file_process';
export type QueueJobStatus = 'pending' | 'processing' | 'completed' | 'failed' | 'retrying';

export interface IQueueJob<T = unknown> {
  id: string;
  type: QueueJobType;
  data: T;
  status: QueueJobStatus;
  attempts: number;
  maxAttempts: number;
  priority: number;
  delay?: number;
  createdAt: Date;
  processedAt?: Date;
  completedAt?: Date;
  failedAt?: Date;
  error?: string;
}

export interface IMessageProcessJob {
  messageId: string;
  sessionId: string;
  tenantId: string;
  content: string;
  type: MessageType;
  metadata?: Record<string, unknown>;
}

export interface IWebhookJob {
  tenantId: string;
  event: string;
  payload: Record<string, unknown>;
  webhookUrl: string;
  secret?: string;
}

// ============================================================================
// API Types
// ============================================================================

export interface IApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: IApiError;
  meta?: IApiMeta;
}

export interface IApiError {
  code: string;
  message: string;
  details?: Record<string, unknown>;
  stack?: string;
}

export interface IApiMeta {
  page?: number;
  limit?: number;
  total?: number;
  totalPages?: number;
  hasMore?: boolean;
  timestamp: Date;
  requestId: string;
}

export interface IPaginationParams {
  page: number;
  limit: number;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
}

export interface PaginatedResponse<T> {
  data: T[];
  meta: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
    hasMore: boolean;
  };
}

// ============================================================================
// Widget Types
// ============================================================================

export interface IWidgetConfig {
  tenantId: string;
  apiKey: string;
  theme: {
    primaryColor: string;
    backgroundColor: string;
    textColor: string;
    fontFamily: string;
    borderRadius: string;
    logoUrl?: string;
  };
  position: 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left';
  greetingMessage?: string;
  offlineMessage?: string;
  features: {
    fileUpload: boolean;
    emoji: boolean;
    typingIndicator: boolean;
    soundEnabled: boolean;
  };
}

// ============================================================================
// Analytics Types
// ============================================================================

export interface ISessionMetrics {
  totalSessions: number;
  activeSessions: number;
  avgDuration: number;
  satisfactionScore: number;
  handoffRate: number;
  responseTime: number;
}

export interface IAgentMetrics {
  agentId: string;
  totalChats: number;
  avgResponseTime: number;
  satisfactionScore: number;
  availabilityPercentage: number;
}
