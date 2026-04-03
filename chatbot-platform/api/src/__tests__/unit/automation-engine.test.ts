import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import { AutomationEngine } from '../../automations/automation.engine';
import { EmailService } from '../../automations/email.service';
import type { AppointmentBookedEvent, LeadCreatedEvent } from '../../webhooks/webhook.types';
import type { Tenant } from '../../database/entities/Tenant';

function makeTenant(automations: Record<string, unknown> = {}): Tenant {
  return {
    id: 'tenant-1',
    name: 'Acme Corp',
    settings: { automations } as unknown,
  } as Tenant;
}

const BASE_SESSION = {
  channel: 'web',
  visitorId: 'visitor-1',
  startedAt: '2026-04-03T10:00:00Z',
  messageCount: 5,
};

describe('AutomationEngine', () => {
  let emailService: EmailService;
  let engine: AutomationEngine;

  beforeEach(() => {
    emailService = { send: vi.fn().mockResolvedValue({ success: true }) } as unknown as EmailService;
    engine = new AutomationEngine(emailService);
    vi.clearAllMocks();
  });

  it('sends booking confirmation when enabled', async () => {
    const tenant = makeTenant({
      emailNotifications: {
        bookingConfirmation: { enabled: true },
      },
    });

    const event: AppointmentBookedEvent = {
      id: 'evt-1',
      type: 'appointment.booked',
      tenantId: 'tenant-1',
      sessionId: 'session-1',
      timestamp: '2026-04-03T10:00:00Z',
      session: BASE_SESSION,
      appointment: {
        bookingId: 'booking-1',
        startTime: '2026-04-10T14:00:00Z',
        attendeeName: 'Alice',
        attendeeEmail: 'alice@example.com',
      },
    };

    await engine.process(event, tenant);

    expect(emailService.send).toHaveBeenCalledOnce();
    expect(emailService.send).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'alice@example.com' })
    );
  });

  it('sends new lead alert to team recipients', async () => {
    const tenant = makeTenant({
      emailNotifications: {
        newLeadAlert: {
          enabled: true,
          recipients: ['team@acme.com', 'sales@acme.com'],
        },
      },
    });

    const event: LeadCreatedEvent = {
      id: 'evt-2',
      type: 'lead.created',
      tenantId: 'tenant-1',
      sessionId: 'session-2',
      timestamp: '2026-04-03T10:00:00Z',
      session: BASE_SESSION,
      lead: {
        name: 'Bob',
        email: 'bob@example.com',
        phone: '+1-555-0100',
        source: 'chat',
      },
    };

    await engine.process(event, tenant);

    expect(emailService.send).toHaveBeenCalledOnce();
    expect(emailService.send).toHaveBeenCalledWith(
      expect.objectContaining({ to: ['team@acme.com', 'sales@acme.com'] })
    );
  });

  it('does nothing when automations not configured', async () => {
    const tenant = makeTenant();

    const event: LeadCreatedEvent = {
      id: 'evt-3',
      type: 'lead.created',
      tenantId: 'tenant-1',
      sessionId: 'session-3',
      timestamp: '2026-04-03T10:00:00Z',
      session: BASE_SESSION,
      lead: { name: 'Carol', email: 'carol@example.com', source: 'chat' },
    };

    await engine.process(event, tenant);

    expect(emailService.send).not.toHaveBeenCalled();
  });

  it('does nothing when automation is disabled', async () => {
    const tenant = makeTenant({
      emailNotifications: {
        bookingConfirmation: { enabled: false },
      },
    });

    const event: AppointmentBookedEvent = {
      id: 'evt-4',
      type: 'appointment.booked',
      tenantId: 'tenant-1',
      sessionId: 'session-4',
      timestamp: '2026-04-03T10:00:00Z',
      session: BASE_SESSION,
      appointment: {
        bookingId: 'booking-2',
        startTime: '2026-04-11T09:00:00Z',
        attendeeName: 'Dave',
        attendeeEmail: 'dave@example.com',
      },
    };

    await engine.process(event, tenant);

    expect(emailService.send).not.toHaveBeenCalled();
  });
});
