export type WebhookEventType =
  | 'lead.created'
  // A lead the tenant already received has CHANGED (the request summary landed
  // later, or structured booking detail was attached). Without this the outbound
  // payload was a lossy one-shot fired at first contact, before the conversation
  // had said what the customer actually wanted.
  | 'lead.updated'
  // The lead's personal data was ERASED (GDPR Art 17). This is not optional
  // nicety: a downstream CRM that received `lead.created` has its own copy, and
  // without a deletion signal the tenant cannot honour erasure end-to-end.
  | 'lead.deleted'
  | 'appointment.booked'
  | 'booking.request_created'
  | 'conversation.ended';

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

/** Fields shared by every lead.* event. */
export interface LeadEventPayload {
  /**
   * Stable lead id. Previously ABSENT, which made downstream sync impossible: a
   * consumer had no key to update or delete against and could only ever insert.
   */
  leadId: string;
  /** Per-identity dedup anchor (`whatsapp:32475…` / `email:a@b.com`). */
  dedupeKey?: string;
  botId?: string;
  name: string;
  email: string;
  phone?: string;
  notes?: string;
  source: 'booking' | 'chat' | 'tool';
}

export interface LeadCreatedEvent extends WebhookEventBase {
  type: 'lead.created';
  lead: LeadEventPayload;
}

export interface LeadUpdatedEvent extends WebhookEventBase {
  type: 'lead.updated';
  lead: LeadEventPayload;
  /** Which fields changed, so a consumer can patch instead of overwrite. */
  changed: string[];
}

/**
 * Erasure notification. Carries ONLY the identifiers a consumer needs to find its
 * own copy — deliberately no name/email/phone/notes, because a "please delete this
 * person" message that restates their personal data defeats its own purpose.
 */
export interface LeadDeletedEvent extends WebhookEventBase {
  type: 'lead.deleted';
  lead: { leadId: string; dedupeKey?: string };
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

export interface BookingRequestCreatedEvent extends WebhookEventBase {
  type: 'booking.request_created';
  booking: {
    bookingId: string;
    startTime: string;
    endTime: string;
    attendeeName: string;
    attendeeEmail: string;
    notes?: string;
  };
  service: { id: string; name: string };
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

export type WebhookEvent =
  | LeadCreatedEvent
  | LeadUpdatedEvent
  | LeadDeletedEvent
  | AppointmentBookedEvent
  | BookingRequestCreatedEvent
  | ConversationEndedEvent;

export interface EventWebhookConfig {
  url: string;
  events: WebhookEventType[];
  secret: string;
  enabled: boolean;
}
