import { logger } from '../utils/logger';
import { EmailService } from './email.service';
import { renderTemplate, buildVariablesFromEvent } from './template';
import type { WebhookEvent } from '../webhooks/webhook.types';
import type { Tenant } from '../database/entities/Tenant';

type EmailNotificationConfig = {
  enabled: boolean;
  subject?: string;
  body?: string;
  recipients?: string[];
};

type AutomationsSettings = {
  emailNotifications?: {
    bookingConfirmation?: EmailNotificationConfig;
    newLeadAlert?: EmailNotificationConfig & { recipients: string[] };
    conversationSummary?: EmailNotificationConfig & { recipients: string[] };
  };
};

export class AutomationEngine {
  constructor(private readonly emailService: EmailService) {}

  async process(event: WebhookEvent, tenant: Tenant): Promise<void> {
    const automations = (tenant.settings as unknown as { automations?: AutomationsSettings })
      .automations;

    if (!automations?.emailNotifications) {
      return;
    }

    const { emailNotifications } = automations;
    const tenantName = tenant.name;
    const botName = 'Assistant';

    try {
      if (event.type === 'appointment.booked') {
        const config = emailNotifications.bookingConfirmation;
        if (!config?.enabled) return;

        const attendeeEmail = event.appointment.attendeeEmail;
        const variables = buildVariablesFromEvent(
          { type: event.type, data: { name: event.appointment.attendeeName, email: attendeeEmail, date: event.appointment.startTime, time: event.appointment.startTime } },
          tenantName,
          botName
        );
        const subject = config.subject ? renderTemplate(config.subject, variables) : 'Your appointment has been confirmed';
        const body = config.body ? renderTemplate(config.body, variables) : `Hi {name}, your appointment is confirmed.`;

        await this.emailService.send({ to: attendeeEmail, subject, body });
        return;
      }

      if (event.type === 'lead.created') {
        const config = emailNotifications.newLeadAlert;
        if (!config?.enabled) return;

        const recipients = config.recipients ?? [];
        if (recipients.length === 0) return;

        const variables = buildVariablesFromEvent(
          { type: event.type, data: { name: event.lead.name, email: event.lead.email, phone: event.lead.phone, notes: event.lead.notes } },
          tenantName,
          botName
        );
        const subject = config.subject ? renderTemplate(config.subject, variables) : 'New lead received';
        const body = config.body ? renderTemplate(config.body, variables) : `A new lead has been captured.`;

        await this.emailService.send({ to: recipients, subject, body });
        return;
      }

      if (event.type === 'conversation.ended') {
        const config = emailNotifications.conversationSummary;
        if (!config?.enabled) return;

        const recipients = config.recipients ?? [];
        if (recipients.length === 0) return;

        const variables = buildVariablesFromEvent(
          {
            type: event.type,
            data: {
              messageCount: event.conversation.messageCount,
              duration: event.conversation.durationSeconds,
              tags: event.session.tags,
            },
          },
          tenantName,
          botName
        );
        const subject = config.subject ? renderTemplate(config.subject, variables) : 'Conversation summary';
        const body = config.body ? renderTemplate(config.body, variables) : `A conversation has ended.`;

        await this.emailService.send({ to: recipients, subject, body });
        return;
      }
    } catch (err) {
      logger.error('[AutomationEngine] failed to process event', { eventType: event.type, tenantId: tenant.id, err });
    }
  }
}
