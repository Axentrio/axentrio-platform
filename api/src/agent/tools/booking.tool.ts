import type { ToolAdapter, ToolContext, ToolResult } from '../tool-adapter';
import {
  checkAvailability,
  createBooking,
  listBookings,
  rescheduleBooking,
  cancelBooking,
} from '../../n8n/booking.service';
import { emitWebhookEvent, buildEventBase } from '../../webhooks/webhook.emitter';
import { ChatSession } from '../../database/entities/ChatSession';
import type { AppointmentBookedEvent, LeadCreatedEvent } from '../../webhooks/webhook.types';

export class CheckAvailabilityTool implements ToolAdapter {
  name = 'check_availability';
  description = 'Check available appointment slots for a given date range.';
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
    },
    required: ['startDate', 'endDate'],
  };
  hasSideEffects = false;

  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    try {
      const result = await checkAvailability(
        ctx.sessionId,
        args.startDate as string,
        args.endDate as string
      );
      return { success: true, data: result };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : 'Failed to check availability' };
    }
  }
}

export class CreateBookingTool implements ToolAdapter {
  name = 'create_booking';
  description = 'Create an appointment booking for the customer. You can call this directly if availability was already checked in a recent conversation turn.';
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
        args.notes as string | undefined
      );

      // Fire-and-forget: emit appointment.booked + lead.created webhook events
      void (async () => {
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
      return { success: false, error: err instanceof Error ? err.message : 'Failed to create booking' };
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
      return { success: false, error: err instanceof Error ? err.message : 'Failed to reschedule booking' };
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
      return { success: false, error: err instanceof Error ? err.message : 'Failed to cancel booking' };
    }
  }
}
