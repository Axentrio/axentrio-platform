import { config } from '../config/environment';
import { logger } from '../utils/logger';
import { AppDataSource } from '../database/data-source';
import { Bot } from '../database/entities/Bot';
import { ChatSession } from '../database/entities/ChatSession';
import { HandoffReason } from '../database/entities/HandoffRequest';
import { Tenant } from '../database/entities/Tenant';
import { User } from '../database/entities/User';
import { emailDeliveryService } from './email-delivery.service';
import { notificationService } from './notification.service';
import { resolveNotificationPrefs } from './notification-prefs.service';

export interface NewHandoffNotificationParams {
  tenantId: string;
  handoffId: string;
  sessionId: string;
  reason: HandoffReason;
  requestedAt: Date;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function humanizeReason(reason: HandoffReason): string {
  return reason.replace(/_/g, ' ');
}

function formatRequestedAt(requestedAt: Date): string {
  return requestedAt.toLocaleString('en-US', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'UTC',
  });
}

export function renderHandoffEmail(params: {
  tenantName: string;
  botName: string;
  channel: string;
  requestedAt: Date;
  reason: HandoffReason;
  deepLink: string;
}): { subject: string; body: string } {
  const subject = 'New handoff request';
  const body = [
    '<p>A new handoff request needs attention.</p>',
    `<p>Tenant: ${escapeHtml(params.tenantName)}<br>` +
      `Bot: ${escapeHtml(params.botName)}<br>` +
      `Channel: ${escapeHtml(params.channel)}<br>` +
      `Requested: ${escapeHtml(formatRequestedAt(params.requestedAt))}<br>` +
      `Reason: ${escapeHtml(humanizeReason(params.reason))}</p>`,
    `<p><a href="${escapeHtml(params.deepLink)}">Open the handoff in Inbox</a></p>`,
  ].join('');
  return { subject, body };
}

export async function notifyNewHandoff(params: NewHandoffNotificationParams): Promise<void> {
  const users = await AppDataSource.getRepository(User).find({
    where: { tenantId: params.tenantId, isActive: true },
    select: ['id', 'email', 'notificationPreferences'],
  });

  const platformRecipientIds: string[] = [];
  const emailRecipients: User[] = [];
  for (const user of users) {
    const prefs = resolveNotificationPrefs(user);
    if (prefs.handoffPlatform) platformRecipientIds.push(user.id);
    if (prefs.handoffEmail) emailRecipients.push(user);
  }

  const deepLink = `${config.portal.url}/inbox?chat=${params.sessionId}`;
  const message = params.reason
    ? `A visitor needs help: ${params.reason}`
    : 'A visitor is requesting a human agent.';

  try {
    if (platformRecipientIds.length > 0) {
      await notificationService.createForRecipients({
        tenantId: params.tenantId,
        type: 'handoff_requested',
        title: 'New handoff request',
        message,
        data: {
          sessionId: params.sessionId,
          handoffId: params.handoffId,
          deepLink,
        },
        dedupeBase: `handoff:${params.handoffId}`,
        recipientUserIds: platformRecipientIds,
      });
    }
  } catch (error) {
    logger.warn('Handoff platform notification failed', {
      tenantId: params.tenantId,
      sessionId: params.sessionId,
      handoffId: params.handoffId,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  try {
    if (emailRecipients.length === 0) return;

    const tenant = await AppDataSource.getRepository(Tenant).findOneOrFail({
      where: { id: params.tenantId },
      select: ['id', 'name'],
    });
    const session = await AppDataSource.getRepository(ChatSession).findOne({
      where: { id: params.sessionId },
      select: ['id', 'channel', 'botId'],
    });
    if (!session) throw new Error(`Chat session ${params.sessionId} not found`);
    const bot = await AppDataSource.getRepository(Bot).findOne({
      where: { id: session.botId },
      select: ['id', 'name'],
    });
    const email = renderHandoffEmail({
      tenantName: tenant.name,
      botName: bot?.name ?? 'the assistant',
      channel: session.channel,
      requestedAt: params.requestedAt,
      reason: params.reason,
      deepLink,
    });

    await Promise.allSettled(
      emailRecipients.map((user) =>
        emailDeliveryService.sendDurable({
          tenantId: params.tenantId,
          recipientUserId: user.id,
          recipientEmail: user.email,
          subject: email.subject,
          body: email.body,
          kind: 'handoff',
          relatedId: params.handoffId,
          idempotencyKey: `handoff:${params.handoffId}:${user.id}`,
        }),
      ),
    );
  } catch (error) {
    logger.warn('Handoff email notification failed', {
      tenantId: params.tenantId,
      sessionId: params.sessionId,
      handoffId: params.handoffId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
