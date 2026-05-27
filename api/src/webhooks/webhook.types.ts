export type WebhookEventType = 'lead.created' | 'appointment.booked' | 'conversation.ended';

export interface WebhookEventBase {
  id: string;
  type: WebhookEventType;
  tenantId: string;
  sessionId: string;
  timestamp: string;
  session: {
    channel: string;
    visitorId: string;
    startedAt: string;
    messageCount: number;
    tags?: string[];
  };
}

export interface LeadCreatedEvent extends WebhookEventBase {
  type: 'lead.created';
  lead: { name: string; email: string; phone?: string; source: 'booking' | 'chat' | 'tool' };
}

export interface AppointmentBookedEvent extends WebhookEventBase {
  type: 'appointment.booked';
  appointment: {
    bookingId: string;
    startTime: string;
    attendeeName: string;
    attendeeEmail: string;
    notes?: string;
  };
}

export interface ConversationEndedEvent extends WebhookEventBase {
  type: 'conversation.ended';
  conversation: {
    durationSeconds: number | null;
    messageCount: number;
    finalStatus: string;
    assignedAgentId?: string;
  };
}

export type WebhookEvent = LeadCreatedEvent | AppointmentBookedEvent | ConversationEndedEvent;

export interface EventWebhookConfig {
  url: string;
  events: WebhookEventType[];
  secret: string;
  enabled: boolean;
}
