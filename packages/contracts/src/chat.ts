export type SessionStatus = 'active' | 'closed' | 'waiting' | 'handoff' | 'bot';

export type MessageType = 'text' | 'image' | 'file' | 'system' | 'typing';

export type MessageStatus =
  | 'sending'
  | 'sent'
  | 'delivered'
  | 'read'
  | 'failed';

/** Item in GET /api/v1/chats/sessions (agent inbox list). */
export interface SessionSummary {
  id: string;
  sessionId: string;
  status: SessionStatus;
  userName: string;
  assignedAgent: { id: string } | null;
  assignedAgentName: string | null;
  messageCount: number;
  lastMessage: string | null;
  lastMessageSender: string | null;
  lastMessageAt: string;
  lastActivityAt: string;
  source: string;
  createdAt: string;
}

/** A message inside a conversation (agent-facing). */
export interface ConversationMessage {
  id: string;
  type: MessageType;
  content: string;
  status: MessageStatus;
  createdAt: string;
  metadata?: Record<string, unknown>;
  sender: string;
  senderName: string;
  participantId: string;
}

/** GET /api/v1/chats/:id (full conversation, agent-facing). */
export interface Conversation {
  id: string;
  sessionId: string;
  tenantId: string;
  status: SessionStatus;
  visitorId: string;
  assignedAgentId: string | null;
  assignedAgentName: string | null;
  messages: ConversationMessage[];
  metadata: { source: string };
  createdAt: string;
  updatedAt: string;
  lastMessageAt: string;
  closedAt: string | null;
}

/** GET /api/v1/chats/:id/history */
export interface ConversationHistory {
  sessionId: string;
  messages: ConversationMessage[];
  pagination: {
    total: number;
    limit: number;
    offset: number;
    hasMore: boolean;
  };
}
