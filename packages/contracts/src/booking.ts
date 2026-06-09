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
  intakeAnswers?: Record<string, unknown>;
  startUtc: string;
  endUtc: string;
  bookedDurationMin?: number;
  aiSummary?: string;
  notes?: string;
  createdAt: string;
  updatedAt: string;
}
