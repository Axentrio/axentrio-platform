/**
 * Message Type Definitions
 * TypeScript interfaces for n8n message formats
 */

// ============================================================================
// Outbound Message Types (Chatbot Platform → n8n)
// ============================================================================

export type MessageEvent =
  | 'message.received'
  | 'message.sent'
  | 'session.started'
  | 'session.ended'
  | 'user.typing'
  | 'file.uploaded'
  | 'handsoff.requested'
  | 'handsoff.accepted'
  | 'handsoff.released';

export type MessageType = 'text' | 'image' | 'video' | 'file' | 'audio' | 'location' | 'contact';

export interface FileMetadata {
  filename?: string;
  mimeType?: string;
  size?: number;
  width?: number;
  height?: number;
  duration?: number;
  url?: string;
}

export interface GeoLocation {
  country?: string;
  countryCode?: string;
  region?: string;
  city?: string;
  timezone?: string;
  lat?: number;
  lng?: number;
}

export interface DeviceInfo {
  type?: 'desktop' | 'mobile' | 'tablet';
  os?: string;
  browser?: string;
  version?: string;
}

export interface UserContext {
  anonymousId?: string;
  externalId?: string;
  email?: string;
  name?: string;
  browser?: string;
  ip?: string;
  geo?: GeoLocation;
  device?: DeviceInfo;
  customData?: Record<string, unknown>;
}

export interface PreviousMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: string;
  metadata?: Record<string, unknown>;
}

export interface Entity {
  type: string;
  value: string;
  confidence?: number;
}

export interface UtmParams {
  source?: string;
  medium?: string;
  campaign?: string;
  term?: string;
  content?: string;
}

export interface ChatContext {
  previousMessages?: PreviousMessage[];
  intent?: string;
  confidence?: number;
  entities?: Entity[];
  pageUrl?: string;
  referrer?: string;
  utmParams?: UtmParams;
  customContext?: Record<string, unknown>;
}

export interface MessagePayload {
  type: MessageType;
  content?: string | Record<string, unknown>;
  metadata?: FileMetadata;
}

export interface TenantAiConfig {
  brandName: string;
  brandTone: string;
  systemPrompt: string;
  guardrails: {
    topicsToAvoid: string[];
    confidenceThreshold: number;
    maxResponseLength: number;
    escalationKeywords: string[];
  };
}

export interface KnowledgeBaseMetadata {
  enabled: boolean;
  documentCount: number;
}

export interface IntegrationsConfig {
  calcom?: {
    enabled: boolean;
    language: string;
    collectFields: string[];
    timezone: string;
  };
}

export interface OutboundMessage {
  event: MessageEvent;
  tenantId: string;
  sessionId: string;
  timestamp: string;
  payload: MessagePayload;
  user?: UserContext;
  context?: ChatContext;
  tenantConfig?: TenantAiConfig;
  knowledgeBase?: KnowledgeBaseMetadata;
  integrations?: IntegrationsConfig;
}

// ============================================================================
// Inbound Message Types (n8n → Chatbot Platform)
// ============================================================================

export type InboundAction =
  | 'message.send'
  | 'message.edit'
  | 'message.delete'
  | 'typing.start'
  | 'typing.stop'
  | 'handsoff.trigger'
  | 'handsoff.release'
  | 'file.request'
  | 'session.clear'
  | 'session.transfer'
  | 'user.update'
  | 'webhook.register'
  | 'webhook.unregister';

export type ResponseType = 'text' | 'image' | 'video' | 'audio' | 'file' | 'quick_reply' | 'carousel' | 'template' | 'typing';

export type Priority = 'low' | 'normal' | 'high' | 'urgent';

export interface QuickReply {
  id?: string;
  title: string;
  value?: string;
  action?: 'send' | 'url' | 'phone' | 'email' | 'postback' | 'location' | 'camera';
  icon?: string;
  style?: {
    backgroundColor?: string;
    textColor?: string;
    borderColor?: string;
    borderRadius?: number;
  };
  metadata?: Record<string, unknown>;
  disabled?: boolean;
  visible?: boolean;
}

export interface ResponseButton {
  title: string;
  type?: 'postback' | 'url' | 'phone';
  value?: string;
  url?: string;
  webviewHeightRatio?: 'compact' | 'tall' | 'full';
}

export interface ResponseAttachment {
  url: string;
  type?: string;
  filename?: string;
  size?: number;
}

export interface ResponsePayload {
  type?: ResponseType;
  content?: string | Record<string, unknown>;
  quickReplies?: (string | QuickReply)[];
  buttons?: ResponseButton[];
  attachments?: ResponseAttachment[];
  metadata?: Record<string, unknown>;
}

export interface MessageOptions {
  ephemeral?: boolean;
  silent?: boolean;
  requireConfirmation?: boolean;
}

export interface InboundMessage {
  action: InboundAction;
  sessionId: string;
  tenantId?: string;
  payload?: ResponsePayload;
  delay?: number;
  priority?: Priority;
  options?: MessageOptions;
}

// ============================================================================
// Handoff Types
// ============================================================================

export interface HandoffPayload {
  reason?: string;
  queue?: string;
  priority?: Priority;
  agentId?: string;
  department?: string;
  tags?: string[];
  summary?: string;
}

export interface HandoffAction {
  action: 'handsoff.trigger' | 'handsoff.release';
  sessionId: string;
  payload?: HandoffPayload;
}

// ============================================================================
// File Request Types
// ============================================================================

export type FileType = 'image' | 'document' | 'video' | 'audio' | 'any';

export interface FileRequestPayload {
  types: FileType[];
  maxSize?: number;
  maxFiles?: number;
  accept?: string;
  prompt?: string;
}

export interface FileRequestAction {
  action: 'file.request';
  sessionId: string;
  payload: FileRequestPayload;
}

// ============================================================================
// Carousel/Template Types
// ============================================================================

export interface CarouselCard {
  id?: string;
  title: string;
  subtitle?: string;
  imageUrl?: string;
  buttons?: ResponseButton[];
  defaultAction?: {
    type: 'url';
    url: string;
  };
}

export interface QuickReplyGroup {
  id?: string;
  layout?: 'horizontal' | 'vertical' | 'grid' | 'carousel';
  columns?: number;
  items: QuickReply[];
  persist?: boolean;
  dismissOnSelect?: boolean;
}

// ============================================================================
// Webhook Configuration Types
// ============================================================================

export interface WebhookConfig {
  id: string;
  tenantId: string;
  name: string;
  url: string;
  events: MessageEvent[];
  secret?: string;
  headers?: Record<string, string>;
  timeout?: number;
  retryPolicy?: {
    maxRetries: number;
    backoffMultiplier: number;
    initialDelay: number;
  };
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

// ============================================================================
// Queue Types
// ============================================================================

export interface QueuedMessage {
  id: string;
  message: OutboundMessage;
  webhookConfig: WebhookConfig;
  attempts: number;
  maxAttempts: number;
  lastAttempt?: string;
  nextAttempt?: string;
  error?: string;
  createdAt: string;
}

// ============================================================================
// Circuit Breaker Types
// ============================================================================

export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface CircuitBreakerState {
  state: CircuitState;
  failures: number;
  successCount: number;
  lastFailureTime?: number;
  lastSuccessTime?: number;
  nextAttemptTime?: number;
}

// ============================================================================
// API Response Types
// ============================================================================

export interface WebhookResponse {
  success: boolean;
  messageId?: string;
  error?: string;
  retryAfter?: number;
  actions?: InboundMessage[];
}

export interface DeliveryStatus {
  messageId: string;
  status: 'pending' | 'delivered' | 'failed' | 'queued';
  attempts: number;
  lastAttempt?: string;
  error?: string;
}
