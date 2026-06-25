import type { ToolAdapter, ToolContext, ToolResult } from '../tool-adapter';
import {
  checkAvailability,
  createBooking,
  requestBooking,
  listBookings,
  rescheduleBooking,
  cancelBooking,
  BookingError,
} from '../../booking/booking.service';
import { emitWebhookEvent, buildEventBase } from '../../webhooks/webhook.emitter';
import { ChatSession } from '../../database/entities/ChatSession';
import type { AppointmentBookedEvent } from '../../webhooks/webhook.types';
import type { CreateBookingResult } from '../../booking/booking-providers/types';
import { logger } from '../../utils/logger';

/**
 * Surface a BookingError's machine-readable code to the LLM (e.g. "ADDRESS_REQUIRED:
 * …"), so the agent can branch on the codes the SERVICES prompt rules reference
 * (ADDRESS_REQUIRED / PHONE_REQUIRED / SERVICE_REQUIRED / SLOT_UNAVAILABLE / etc.).
 */
// R31: a BookingError is an authored DOMAIN error (its code + message are safe to
// show the model and help it respond well). Anything else is an unexpected infra
// exception — return it unmarked so the agent sanitizes it before the model sees it.
function toolError(err: unknown, fallback: string): { error: string; errorSafeForModel: boolean } {
  if (err instanceof BookingError) return { error: `${err.code}: ${err.message}`, errorSafeForModel: true };
  return { error: err instanceof Error ? err.message : fallback, errorSafeForModel: false };
}

export class CheckAvailabilityTool implements ToolAdapter {
  name = 'check_availability';
  description = 'Check available appointment slots for a given date range and service.';
  parameters = {
    type: 'object',
    properties: {
      startDate: {
        type: 'string',
        description: 'Start date in ISO 8601 format (e.g. 2026-04-01).',
      },
      endDate: {
        type: 'string',
        description: 'End date in ISO 8601 format (e.g. 2026-04-07).',
      },
      serviceId: {
        type: 'string',
        description:
          'The id of the service to check (from the SERVICES list). Omit only when the business has a single service.',
      },
      durationMin: {
        type: 'number',
        description:
          "For a service whose duration is a range or AI-estimated (flagged in the SERVICES list), the chosen/estimated length in minutes, so the offered slots fit. Omit for fixed-duration services.",
      },
    },
    required: ['startDate', 'endDate'],
  };
  hasSideEffects = false;

  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    try {
      const result = await checkAvailability(
        'agent',
        ctx.sessionId,
        args.startDate as string,
        args.endDate as string,
        args.serviceId as string | undefined,
        args.durationMin as number | undefined
      );
      return { success: true, data: result };
    } catch (err) {
      return { success: false, ...toolError(err, 'Failed to check availability') };
    }
  }
}

export class CreateBookingTool implements ToolAdapter {
  name = 'create_booking';
  description = 'Create an appointment booking for the customer. You can call this directly if availability was already checked in a recent conversation turn. If the service has intake questions, ask them first and pass the answers in intakeAnswers.';
  parameters = {
    type: 'object',
    properties: {
      startTime: {
        type: 'string',
        description:
          'Start time of the booking. Prefer the exact slot start returned by check_availability, verbatim. If you must construct it from the customer\'s words, give a ZONELESS ISO 8601 local time in the business\'s timezone — e.g. "2026-06-19T14:00:00" — never append \'Z\' or an offset.',
      },
      attendeeName: {
        type: 'string',
        description: 'Full name of the person being booked.',
      },
      attendeeEmail: {
        type: 'string',
        description:
          'Email address of the person being booked. Optional — ask for it so we can email a calendar invite, but proceed without it if the customer has none. Never invent one.',
      },
      notes: {
        type: 'string',
        description: 'Optional notes or reason for the booking.',
      },
      serviceId: {
        type: 'string',
        description:
          'The id of the service being booked (from the SERVICES list). Use the same service whose availability you checked. Omit only when the business has a single service.',
      },
      intakeAnswers: {
        type: 'object',
        additionalProperties: { type: 'string' },
        description:
          "The customer's answers to the service's intake questions, as a flat object keyed by the question id shown in the SERVICES block (e.g. {\"<question-id>\": \"answer\"}). Include every answer you collected; omit unanswered questions.",
      },
      customerAddress: {
        type: 'string',
        description: "The customer's address. Required only if the SERVICES entry flags 'needs address'.",
      },
      customerPhone: {
        type: 'string',
        description: "The customer's contact phone number. Required only if the SERVICES entry flags 'needs phone'.",
      },
      durationMin: {
        type: 'number',
        description:
          "For a range/AI-duration service (flagged in SERVICES), the chosen/estimated length in minutes — pass the SAME value you checked availability with. Omit for fixed-duration services.",
      },
      fileSessionIds: {
        type: 'array',
        items: { type: 'string' },
        description:
          'The ids of files the customer uploaded in THIS chat for this service (only if the service accepts files). Omit if none.',
      },
    },
    required: ['startTime', 'attendeeName'],
  };
  hasSideEffects = true;
  // Precondition removed — the skill instructions tell the LLM to check availability first.
  // Hard precondition caused issues: forced redundant re-checks that returned different results
  // from Cal.com's API when using narrow vs full-day date ranges.

  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    try {
      // Stable across turns (not per-runId) so a re-confirm in a later turn dedupes
      // to the same booking instead of inserting a duplicate (#35).
      const idempotencyKey = `create_booking:${ctx.sessionId}:${(args.serviceId as string) ?? 'default'}:${args.startTime as string}`;
      const result = await createBooking(
        'agent',
        ctx.sessionId,
        idempotencyKey,
        args.startTime as string,
        { name: args.attendeeName as string, email: args.attendeeEmail as string | undefined },
        args.notes as string | undefined,
        args.serviceId as string | undefined,
        args.intakeAnswers,
        {
          customerAddress: args.customerAddress as string | undefined,
          customerPhone: args.customerPhone as string | undefined,
          durationMin: args.durationMin as number | undefined,
          fileSessionIds: args.fileSessionIds as string[] | undefined,
        }
      );

      // Fire-and-forget: emit appointment.booked — confirmed bookings only.
      // (lead.created is owned by the lead-capture service, fired from the booking
      // service's captureLeadFromBooking hook — emitting it here too would double-fire.)
      // A request-mode service short-circuits to a request inside the provider, which fires
      // booking.request_created itself; emitting appointment.booked here would wrongly
      // signal a confirmation (and would re-fire on idempotent re-returns).
      // Emit appointment.booked only for a NEW confirmed booking. Skip request-mode
      // (the provider fires booking.request_created itself) AND idempotent re-returns
      // (the original create already emitted — re-firing would double the webhook +
      // downstream automations).
      const r = result as CreateBookingResult;
      const isRequest = r.requested === true;
      if (!isRequest && !r.idempotent) void (async () => {
        try {
          // #5: the id + canonical UTC time live at result.booking.{id,startTime} —
          // NOT result.bookingId (never existed → the webhook always fell back to the
          // synthetic idempotency key) and NOT args.startTime (raw, often zoneless).
          // A confirmed booking missing them is a provider-contract violation: log +
          // skip rather than emit a bogus id.
          if (!r.booking?.id || !r.booking?.startTime) {
            logger.warn('[booking] appointment.booked skipped — confirmed result missing booking id/startTime', {
              sessionId: ctx.sessionId,
              tenantId: ctx.tenantId,
            });
            return;
          }

          let session: ChatSession | null = null;
          try {
            session = await ctx.dataSource
              .getRepository(ChatSession)
              .findOne({ where: { id: ctx.sessionId } });
          } catch {
            // non-fatal
          }

          const sessionCtx = {
            id: ctx.sessionId,
            channel: session?.channel ?? 'widget',
            visitorId: session?.visitorId ?? 'unknown',
            startedAt: session?.startedAt?.toISOString() ?? new Date().toISOString(),
            messageCount: session?.messageCount ?? 0,
            tags: session?.tags,
          };

          const appointmentEvent: AppointmentBookedEvent = {
            ...buildEventBase('appointment.booked', ctx.tenantId, sessionCtx),
            type: 'appointment.booked',
            appointment: {
              bookingId: r.booking.id,
              startTime: r.booking.startTime,
              attendeeName: args.attendeeName as string,
              attendeeEmail: (args.attendeeEmail as string | undefined) ?? '',
              notes: args.notes as string | undefined,
            },
          };
          emitWebhookEvent(appointmentEvent);
        } catch {
          // non-fatal — booking succeeded, webhook emission is best-effort
        }
      })();

      return { success: true, data: result };
    } catch (err) {
      return { success: false, ...toolError(err, 'Failed to create booking') };
    }
  }
}

export class RequestAppointmentTool implements ToolAdapter {
  name = 'request_appointment';
  description =
    'Capture an appointment REQUEST (not a confirmed booking) for the customer to be reviewed by the business. Use this — never create_booking — when the service is request-only, the scope/duration is unclear, the job sounds complex/urgent/risky, or you are not confident you can safely confirm a time. The owner is notified and follows up. Only call once the service is identified.';
  parameters = {
    type: 'object',
    properties: {
      preferredTime: {
        type: 'string',
        description:
          "The customer's preferred appointment time as a ZONELESS ISO 8601 local time in the business's timezone — e.g. \"2026-06-19T14:00:00\" for 2 PM. Never append 'Z' or a timezone offset; the time is read as the business's local wall-clock.",
      },
      attendeeName: {
        type: 'string',
        description: 'Full name of the person requesting the appointment.',
      },
      attendeeEmail: {
        type: 'string',
        description:
          'Email address of the person requesting the appointment. Optional — ask for it so we can email a calendar invite, but proceed without it if the customer has none. Never invent one.',
      },
      notes: {
        type: 'string',
        description: 'Optional notes or details the customer provided about the request.',
      },
      serviceId: {
        type: 'string',
        description:
          'The id of the requested service (from the SERVICES list). Identify the service first; omit only when the business has a single service.',
      },
      aiSummary: {
        type: 'string',
        description:
          'A short one-line summary of the request for the business owner (e.g. "New client wants a deep-clean for a 3-bed flat, flexible on timing").',
      },
      intakeAnswers: {
        type: 'object',
        additionalProperties: { type: 'string' },
        description:
          "The customer's answers to the service's intake questions, as a flat object keyed by the question id shown in the SERVICES block. Include every answer you collected; omit unanswered questions.",
      },
      customerAddress: {
        type: 'string',
        description: "The customer's address. Required only if the SERVICES entry flags 'needs address'.",
      },
      customerPhone: {
        type: 'string',
        description: "The customer's contact phone number. Required only if the SERVICES entry flags 'needs phone'.",
      },
      durationMin: {
        type: 'number',
        description:
          "For a range/AI-duration service (flagged in SERVICES), the chosen/estimated length in minutes. Omit for fixed-duration services.",
      },
      fileSessionIds: {
        type: 'array',
        items: { type: 'string' },
        description:
          'The ids of files the customer uploaded in THIS chat for this service (only if the service accepts files). Omit if none.',
      },
    },
    required: ['preferredTime', 'attendeeName'],
  };
  hasSideEffects = true;

  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    try {
      // Stable across turns (not per-runId) so a re-confirm in a later turn dedupes
      // to the same request instead of inserting a duplicate (#35).
      const idempotencyKey = `request_appointment:${ctx.sessionId}:${(args.serviceId as string) ?? 'default'}:${args.preferredTime as string}`;
      const result = await requestBooking(
        'agent',
        ctx.sessionId,
        idempotencyKey,
        args.preferredTime as string,
        { name: args.attendeeName as string, email: args.attendeeEmail as string | undefined },
        args.notes as string | undefined,
        args.serviceId as string | undefined,
        args.aiSummary as string | undefined,
        args.intakeAnswers,
        {
          customerAddress: args.customerAddress as string | undefined,
          customerPhone: args.customerPhone as string | undefined,
          durationMin: args.durationMin as number | undefined,
          fileSessionIds: args.fileSessionIds as string[] | undefined,
        }
      );
      return { success: true, data: result };
    } catch (err) {
      return { success: false, ...toolError(err, 'Failed to capture request') };
    }
  }
}

export class ListBookingsTool implements ToolAdapter {
  name = 'list_bookings';
  description = 'List existing bookings for a customer by email address.';
  parameters = {
    type: 'object',
    properties: {
      attendeeEmail: {
        type: 'string',
        description: 'Email address of the customer whose bookings to retrieve.',
      },
    },
    required: ['attendeeEmail'],
  };
  hasSideEffects = false;

  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    try {
      const result = await listBookings('agent', ctx.sessionId, args.attendeeEmail as string);
      return { success: true, data: result };
    } catch (err) {
      return { success: false, ...toolError(err, 'Failed to list bookings') };
    }
  }
}

export class RescheduleBookingTool implements ToolAdapter {
  name = 'reschedule_booking';
  description = 'Reschedule an existing booking to a new time.';
  parameters = {
    type: 'object',
    properties: {
      bookingId: {
        type: 'string',
        description: 'The ID of the booking to reschedule.',
      },
      newStartTime: {
        type: 'string',
        description: 'New start time in ISO 8601 format.',
      },
    },
    required: ['bookingId', 'newStartTime'],
  };
  hasSideEffects = true;

  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    try {
      const result = await rescheduleBooking(
        'agent',
        ctx.sessionId,
        args.bookingId as string,
        args.newStartTime as string
      );
      return { success: true, data: result };
    } catch (err) {
      return { success: false, ...toolError(err, 'Failed to reschedule booking') };
    }
  }
}

export class CancelBookingTool implements ToolAdapter {
  name = 'cancel_booking';
  description = 'Cancel an existing booking.';
  parameters = {
    type: 'object',
    properties: {
      bookingId: {
        type: 'string',
        description: 'The ID of the booking to cancel.',
      },
      reason: {
        type: 'string',
        description: 'Optional reason for cancellation.',
      },
    },
    required: ['bookingId'],
  };
  hasSideEffects = true;

  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    try {
      const result = await cancelBooking(
        'agent',
        ctx.sessionId,
        args.bookingId as string,
        args.reason as string | undefined
      );
      return { success: true, data: result };
    } catch (err) {
      return { success: false, ...toolError(err, 'Failed to cancel booking') };
    }
  }
}
