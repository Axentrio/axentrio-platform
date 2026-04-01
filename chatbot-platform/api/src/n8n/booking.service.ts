import axios, { AxiosError } from 'axios';
import { AppDataSource } from '../database/data-source';
import { ChatSession } from '../database/entities/ChatSession';
import { Tenant } from '../database/entities/Tenant';
import { BookingLog } from '../database/entities/BookingLog';
import { decrypt } from '../utils/encryption';
import { logger } from '../utils/logger';

interface CalComConfig {
  apiKey: string;
  eventTypeId: number;
  timezone: string;
}

interface Slot {
  start: string;
  end: string;
}

interface BookingNotificationDetails {
  calBookingId: string;
  startTime: string;
  endTime?: string;
  attendeeName: string;
  attendeeEmail: string;
  notes?: string;
}

async function sendBookingNotification(
  type: 'created' | 'rescheduled' | 'cancelled',
  booking: BookingNotificationDetails,
  tenantName: string
): Promise<void> {
  // Step 1: log only. Resend integration configured separately later.
  logger.info(`[Booking] Email notification: ${type}`, { booking, tenantName });
}

async function resolveSessionTenant(sessionId: string): Promise<{ session: ChatSession; tenant: Tenant; calConfig: CalComConfig }> {
  const sessionRepo = AppDataSource.getRepository(ChatSession);
  const tenantRepo = AppDataSource.getRepository(Tenant);

  const session = await sessionRepo.findOne({ where: { id: sessionId } });
  if (!session) throw new BookingError('Session not found', 'SESSION_NOT_FOUND', 404);

  const tenant = await tenantRepo.findOne({ where: { id: session.tenantId } });
  if (!tenant) throw new BookingError('Tenant not found', 'TENANT_NOT_FOUND', 404);

  const calcom = tenant.settings?.integrations?.calcom;
  if (!calcom?.apiKey || !calcom?.eventTypeId) {
    throw new BookingError('Booking not configured for this tenant', 'BOOKING_NOT_CONFIGURED', 400);
  }

  const timezone = tenant.settings?.businessHours?.timezone || 'UTC';

  return {
    session,
    tenant,
    calConfig: {
      apiKey: decrypt(calcom.apiKey),
      eventTypeId: calcom.eventTypeId,
      timezone,
    },
  };
}

export class BookingError extends Error {
  constructor(
    message: string,
    public code: string,
    public statusCode: number
  ) {
    super(message);
    this.name = 'BookingError';
  }
}

export async function listBookings(sessionId: string, attendeeEmail: string) {
  const { tenant } = await resolveSessionTenant(sessionId);

  const bookingLogRepo = AppDataSource.getRepository(BookingLog);
  const logs = await bookingLogRepo
    .createQueryBuilder('bl')
    .where('bl.tenant_id = :tenantId', { tenantId: tenant.id })
    .andWhere('bl.attendee_email = :email', { email: attendeeEmail })
    .andWhere('bl.event_type != :cancelled', { cancelled: 'cancelled' })
    .andWhere('bl.cal_booking_id IS NOT NULL')
    .orderBy('bl.created_at', 'DESC')
    .getMany();

  // Deduplicate by calBookingId (keep latest)
  const seen = new Set<string>();
  const unique = logs.filter(log => {
    if (!log.calBookingId || seen.has(log.calBookingId)) return false;
    seen.add(log.calBookingId);
    return true;
  });

  return {
    bookings: unique.map(log => ({
      id: log.calBookingId,
      startTime: log.startTime?.toISOString(),
      endTime: log.endTime?.toISOString(),
      attendee: { name: log.attendeeName, email: log.attendeeEmail },
      status: 'accepted',
    })),
  };
}

export async function checkAvailability(sessionId: string, startDate: string, endDate: string) {
  const { calConfig } = await resolveSessionTenant(sessionId);

  try {
    const response = await axios.get('https://api.cal.com/v2/slots', {
      params: {
        eventTypeId: calConfig.eventTypeId,
        timeZone: calConfig.timezone,
        start: startDate,
        end: endDate,
      },
      headers: {
        'Authorization': `Bearer ${calConfig.apiKey}`,
        'cal-api-version': '2024-09-04',
      },
      timeout: 10000,
    });

    const slotsData = response.data?.data || response.data?.slots || {};
    const slots: Slot[] = [];

    // Cal.com returns slots grouped by date
    for (const dateSlots of Object.values(slotsData)) {
      if (Array.isArray(dateSlots)) {
        for (const slot of dateSlots) {
          slots.push({
            start: slot.start || slot.time,
            end: slot.end || '',
          });
        }
      }
    }

    return { slots, timezone: calConfig.timezone };
  } catch (error) {
    if (error instanceof AxiosError && error.response?.status && error.response.status >= 500) {
      throw new BookingError('Cal.com is currently unavailable', 'BOOKING_UNAVAILABLE', 503);
    }
    throw new BookingError(
      `Failed to check availability: ${error instanceof Error ? error.message : 'Unknown error'}`,
      'AVAILABILITY_CHECK_FAILED',
      502
    );
  }
}

export async function createBooking(
  sessionId: string,
  idempotencyKey: string,
  startTime: string,
  attendee: { name: string; email: string },
  notes?: string
) {
  const { tenant, calConfig } = await resolveSessionTenant(sessionId);
  const bookingLogRepo = AppDataSource.getRepository(BookingLog);

  // Idempotency check
  const existing = await bookingLogRepo.findOne({
    where: { tenantId: tenant.id, idempotencyKey },
  });
  if (existing) {
    return {
      success: true,
      idempotent: true,
      booking: {
        id: existing.calBookingId,
        startTime: existing.startTime?.toISOString(),
        endTime: existing.endTime?.toISOString(),
        attendee: { name: existing.attendeeName, email: existing.attendeeEmail },
      },
    };
  }

  try {
    const response = await axios.post('https://api.cal.com/v2/bookings', {
      eventTypeId: calConfig.eventTypeId,
      start: startTime,
      attendee: {
        name: attendee.name,
        email: attendee.email,
        timeZone: calConfig.timezone,
        language: 'en',
      },
      bookingFieldsResponses: {
        notes: notes || '',
      },
    }, {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${calConfig.apiKey}`,
        'cal-api-version': '2024-08-13',
      },
      timeout: 15000,
    });

    const booking = response.data?.data || response.data;
    const calBookingId = booking?.id?.toString() || booking?.uid || '';
    const endTime = booking?.endTime || booking?.end || '';

    // Save to booking log
    const log = bookingLogRepo.create({
      tenantId: tenant.id,
      sessionId,
      idempotencyKey,
      calBookingId,
      eventType: 'created',
      attendeeName: attendee.name,
      attendeeEmail: attendee.email,
      startTime: new Date(startTime),
      endTime: endTime ? new Date(endTime) : undefined,
      notes,
    });
    await bookingLogRepo.save(log);

    await sendBookingNotification('created', {
      calBookingId,
      startTime,
      endTime,
      attendeeName: attendee.name,
      attendeeEmail: attendee.email,
      notes,
    }, tenant.name);

    return {
      success: true,
      booking: {
        id: calBookingId,
        startTime,
        endTime,
        attendee,
      },
    };
  } catch (error) {
    if (error instanceof AxiosError) {
      if (error.response?.status === 409) {
        throw new BookingError('This time slot is no longer available', 'SLOT_UNAVAILABLE', 409);
      }
      if (error.response?.status && error.response.status >= 500) {
        throw new BookingError('Cal.com is currently unavailable', 'BOOKING_UNAVAILABLE', 503);
      }
    }
    throw new BookingError(
      `Failed to create booking: ${error instanceof Error ? error.message : 'Unknown error'}`,
      'BOOKING_CREATE_FAILED',
      502
    );
  }
}

export async function rescheduleBooking(
  sessionId: string,
  bookingId: string,
  newStartTime: string
) {
  const { tenant, calConfig } = await resolveSessionTenant(sessionId);
  const bookingLogRepo = AppDataSource.getRepository(BookingLog);

  // Ownership validation
  const existingLog = await bookingLogRepo.findOne({
    where: { tenantId: tenant.id, calBookingId: bookingId, eventType: 'created' },
  });
  if (!existingLog) {
    throw new BookingError('Booking not found for this tenant', 'BOOKING_NOT_FOUND', 404);
  }

  try {
    const response = await axios.post(`https://api.cal.com/v2/bookings/${bookingId}/reschedule`, {
      start: newStartTime,
    }, {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${calConfig.apiKey}`,
        'cal-api-version': '2024-08-13',
      },
      timeout: 15000,
    });

    const booking = response.data?.data || response.data;
    const endTime = booking?.endTime || booking?.end || '';

    // Log the reschedule
    const log = bookingLogRepo.create({
      tenantId: tenant.id,
      sessionId,
      calBookingId: bookingId,
      eventType: 'rescheduled',
      attendeeName: existingLog.attendeeName,
      attendeeEmail: existingLog.attendeeEmail,
      startTime: new Date(newStartTime),
      endTime: endTime ? new Date(endTime) : undefined,
    });
    await bookingLogRepo.save(log);

    await sendBookingNotification('rescheduled', {
      calBookingId: bookingId,
      startTime: newStartTime,
      endTime,
      attendeeName: existingLog.attendeeName || '',
      attendeeEmail: existingLog.attendeeEmail || '',
    }, tenant.name);

    return {
      success: true,
      booking: {
        id: bookingId,
        startTime: newStartTime,
        endTime,
      },
    };
  } catch (error) {
    if (error instanceof BookingError) throw error;
    if (error instanceof AxiosError && error.response?.status && error.response.status >= 500) {
      throw new BookingError('Cal.com is currently unavailable', 'BOOKING_UNAVAILABLE', 503);
    }
    throw new BookingError(
      `Failed to reschedule: ${error instanceof Error ? error.message : 'Unknown error'}`,
      'RESCHEDULE_FAILED',
      502
    );
  }
}

export async function cancelBooking(
  sessionId: string,
  bookingId: string,
  reason?: string
) {
  const { tenant, calConfig } = await resolveSessionTenant(sessionId);
  const bookingLogRepo = AppDataSource.getRepository(BookingLog);

  // Ownership validation
  const existingLog = await bookingLogRepo.findOne({
    where: { tenantId: tenant.id, calBookingId: bookingId, eventType: 'created' },
  });
  if (!existingLog) {
    throw new BookingError('Booking not found for this tenant', 'BOOKING_NOT_FOUND', 404);
  }

  try {
    await axios.delete(`https://api.cal.com/v2/bookings/${bookingId}/cancel`, {
      data: { cancellationReason: reason || 'Cancelled by customer' },
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${calConfig.apiKey}`,
        'cal-api-version': '2024-08-13',
      },
      timeout: 15000,
    });

    // Log the cancellation
    const log = bookingLogRepo.create({
      tenantId: tenant.id,
      sessionId,
      calBookingId: bookingId,
      eventType: 'cancelled',
      attendeeName: existingLog.attendeeName,
      attendeeEmail: existingLog.attendeeEmail,
      startTime: existingLog.startTime,
      notes: reason,
    });
    await bookingLogRepo.save(log);

    await sendBookingNotification('cancelled', {
      calBookingId: bookingId,
      startTime: existingLog.startTime?.toISOString() || '',
      attendeeName: existingLog.attendeeName || '',
      attendeeEmail: existingLog.attendeeEmail || '',
    }, tenant.name);

    return { success: true, cancelled: true };
  } catch (error) {
    if (error instanceof BookingError) throw error;
    if (error instanceof AxiosError && error.response?.status && error.response.status >= 500) {
      throw new BookingError('Cal.com is currently unavailable', 'BOOKING_UNAVAILABLE', 503);
    }
    throw new BookingError(
      `Failed to cancel: ${error instanceof Error ? error.message : 'Unknown error'}`,
      'CANCEL_FAILED',
      502
    );
  }
}
