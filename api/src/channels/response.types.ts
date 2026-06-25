/**
 * Channel response + AI-config types.
 *
 * These were extracted from the (now-removed) external-n8n message types because
 * they are consumed by LIVE platform code: the channel outbound router
 * (Messenger/IG/WhatsApp/Telegram delivery) renders a ResponsePayload, and the
 * message-forwarding service builds TenantAiConfig / KnowledgeBaseMetadata for the
 * agent path. They have nothing to do with external n8n; this is their real home.
 */

export type ResponseType =
  | 'text'
  | 'image'
  | 'video'
  | 'audio'
  | 'file'
  | 'quick_reply'
  | 'carousel'
  | 'template'
  | 'typing';

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
