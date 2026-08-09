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

/**
 * What the LP3 baseline needs to know about an offer, carried WITH the response (#80).
 *
 * The measurement has to happen at DISPATCH, not where the slots were composed: channels
 * truncate quick replies by `capabilities.maxQuickReplies` and drop them where unsupported, so
 * recording at composition would credit the baseline with slots nobody received. But dispatch
 * knows none of this - `routeOutboundMessage` receives a session and a tenant, not the
 * availability call, the service or the location mode.
 *
 * So it rides along. The canonical instants are here because the rendered chips are
 * natural-language text ("Wed 2:00 PM") with no recoverable timestamp, and a Booking has to be
 * matchable against what was offered.
 */
export interface OfferMeasurement {
  botId: string;
  serviceId?: string | null;
  availabilityCallId?: string | null;
  locationMode?: string | null;
  /** Canonical instants in presentation order, BEFORE any channel truncation. */
  slotStarts: string[];
}

export interface ResponsePayload {
  type?: ResponseType;
  content?: string | Record<string, unknown>;
  quickReplies?: (string | QuickReply)[];
  /** Measurement only. Never rendered, never sent to a customer. */
  offer?: OfferMeasurement;
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
