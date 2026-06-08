import type { ToolAdapter, ToolContext, ToolResult } from '../tool-adapter';
import {
  checkAvailability,
  createBooking,
  requestBooking,
  listBookings,
  rescheduleBooking,
  cancelBooking,
  BookingError,
} from '../../n8n/booking.service';
import { emitWebhookEvent, buildEventBase } from '../../webhooks/webhook.emitter';
import { ChatSession } from '../../database/entities/ChatSession';
import type { AppointmentBookedEvent, LeadCreatedEvent } from '../../webhooks/webhook.types';

/**
 * Surface a BookingError's machine-readable code to the LLM (e.g. "ADDRESS_REQUIRED:
 * …"), so the agent can branch on the codes the SERVICES prompt rules reference
 * (ADDRESS_REQUIRED / PHONE_REQUIRED / SERVICE_REQUIRED / SLOT_UNAVAILABLE / etc.).
 */
function toolError(err: unknown, fallback: string): string {
  if (err instanceof BookingError) return `${err.code}: ${err.message}`;
  return err instanceof Error ? err.message : fallback;
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
        ctx.sessionId,
        args.startDate as string,
        args.endDate as string,
        args.serviceId as string | undefined,
        args.durationMin as number | undefined
      );
      return { success: true, data: result };
    } catch (err) {
      return { success: false, error: toolError(err, 'Failed to check availability') };
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
        description: 'Start time of the booking in ISO 8601 format.',
      },
      attendeeName: {
        type: 'string',
        description: 'Full name of the person being booked.',
      },
      attendeeEmail: {
        type: 'string',
        description: 'Email address of the person being booked.',
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
    required: ['startTime', 'attendeeName', 'attendeeEmail'],
  };
  hasSideEffects = true;
  // Precondition removed — the skill instructions tell the LLM to check availability first.
  // Hard precondition caused issues: forced redundant re-checks that returned different results
  // from Cal.com's API when using narrow vs full-day date ranges.

  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    try {
      const idempotencyKey = `${ctx.runId}:create_booking:${args.startTime as string}`;
      const result = await createBooking(
        ctx.sessionId,
        idempotencyKey,
        args.startTime as string,
        { name: args.attendeeName as string, email: args.attendeeEmail as string },
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

      // Fire-and-forget: emit appointment.booked + lead.created — confirmed bookings only.
      // A request-mode service short-circuits to a request inside the provider, which fires
      // booking.request_created itself; emitting appointment.booked here would wrongly
      // signal a confirmation (and would re-fire on idempotent re-returns).
      const isRequest = (result as { requested?: boolean })?.requested === true;
      if (!isRequest) void (async () => {
        try {
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

          const bookingData = result as unknown as Record<string, unknown>;
          const appointmentEvent: AppointmentBookedEvent = {
            ...buildEventBase('appointment.booked', ctx.tenantId, sessionCtx),
            type: 'appointment.booked',
            appointment: {
              bookingId: (bookingData?.bookingId as string) ?? idempotencyKey,
              startTime: args.startTime as string,
              attendeeName: args.attendeeName as string,
              attendeeEmail: args.attendeeEmail as string,
              notes: args.notes as string | undefined,
            },
          };
          emitWebhookEvent(appointmentEvent);

          const leadEvent: LeadCreatedEvent = {
            ...buildEventBase('lead.created', ctx.tenantId, sessionCtx),
            type: 'lead.created',
            lead: {
              name: args.attendeeName as string,
              email: args.attendeeEmail as string,
              source: 'booking',
            },
          };
          emitWebhookEvent(leadEvent);
        } catch {
          // non-fatal — booking succeeded, webhook emission is best-effort
        }
      })();

      return { success: true, data: result };
    } catch (err) {
      return { success: false, error: toolError(err, 'Failed to create booking') };
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
        description: "The customer's preferred appointment time in ISO 8601 format.",
      },
      attendeeName: {
        type: 'string',
        description: 'Full name of the person requesting the appointment.',
      },
      attendeeEmail: {
        type: 'string',
        description: 'Email address of the person requesting the appointment.',
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
    required: ['preferredTime', 'attendeeName', 'attendeeEmail'],
  };
  hasSideEffects = true;

  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    try {
      const idempotencyKey = `${ctx.runId}:request_appointment:${args.preferredTime as string}`;
      const result = await requestBooking(
        ctx.sessionId,
        idempotencyKey,
        args.preferredTime as string,
        { name: args.attendeeName as string, email: args.attendeeEmail as string },
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
      return { success: false, error: toolError(err, 'Failed to capture request') };
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
      const result = await listBookings(ctx.sessionId, args.attendeeEmail as string);
      return { success: true, data: result };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : 'Failed to list bookings' };
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
        ctx.sessionId,
        args.bookingId as string,
        args.newStartTime as string
      );
      return { success: true, data: result };
    } catch (err) {
      return { success: false, error: toolError(err, 'Failed to reschedule booking') };
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
        ctx.sessionId,
        args.bookingId as string,
        args.reason as string | undefined
      );
      return { success: true, data: result };
    } catch (err) {
      return { success: false, error: toolError(err, 'Failed to cancel booking') };
    }
  }
}
