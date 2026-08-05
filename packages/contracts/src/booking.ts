export type BookingStatus =
  | 'pending'
  | 'confirmed'
  | 'cancelled'
  | 'failed'
  | 'request_created';

export type BookingMode = 'auto' | 'request';

/** Item in GET /api/v1/scheduler/bookings */
export interface Booking {
  id: string;
  tenantId: string;
  botId: string;
  provider: string;
  eventTypeId?: string;
  bookingMode?: BookingMode;
  sessionId?: string;
  status: BookingStatus;
  syncPending: boolean;
  attendeeName?: string;
  attendeeEmail?: string;
  customerPhone?: string;
  sourceChannel?: string;
  /**
   * Already joined to their question LABELS by the API — NOT the raw uuid-keyed map this
   * used to declare. Answers are stored keyed by the server-minted question id; every read
   * surface resolves them through `buildIntakeAnswers`, so the wire shape is a list.
   * Duplicate labels are permitted by design, so this is a list and not a map.
   */
  intakeAnswers?: Array<{ label: string; answer: string }>;
  startUtc: string;
  endUtc: string;
  bookedDurationMin?: number;
  aiSummary?: string;
  notes?: string;
  createdAt: string;
  updatedAt: string;
}
