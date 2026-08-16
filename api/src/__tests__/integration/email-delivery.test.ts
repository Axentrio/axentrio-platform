import { describe, it, expect, beforeEach, vi } from 'vitest';

const { send } = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock('../../automations', () => ({ getEmailService: () => ({ send }) }));

import { AppDataSource } from '../../database/data-source';
import { EmailDelivery } from '../../database/entities/EmailDelivery';
import { createTestTenant } from '../helpers/factories';
import { emailDeliveryService } from '../../services/email-delivery.service';
import { renderHandoffEmail } from '../../services/handoff-notification.service';

beforeEach(() => {
  send.mockReset();
  send.mockResolvedValue({ success: true, messageId: 'provider-message-1' });
});

function input(tenantId: string, idempotencyKey = 'handoff:h1:user-1') {
  return {
    tenantId,
    recipientUserId: '00000000-0000-0000-0000-000000000001',
    recipientEmail: 'operator@example.com',
    subject: 'New handoff request',
    body: '<p>A new handoff request needs attention.</p>',
    kind: 'handoff',
    relatedId: '00000000-0000-0000-0000-000000000002',
    idempotencyKey,
  };
}

describe('emailDeliveryService.sendDurable', () => {
  it('creates and sends a fresh delivery, recording the provider message id', async () => {
    const tenant = await createTestTenant();

    const result = await emailDeliveryService.sendDurable(input(tenant.id));
    const row = await AppDataSource.getRepository(EmailDelivery).findOneByOrFail({
      idempotencyKey: 'handoff:h1:user-1',
    });

    expect(result).toMatchObject({
      status: 'sent',
      deliveryId: row.id,
      providerMessageId: 'provider-message-1',
    });
    expect(row).toMatchObject({
      status: 'sent',
      attemptCount: 1,
      providerMessageId: 'provider-message-1',
      error: null,
    });
    expect(send).toHaveBeenCalledWith({
      to: 'operator@example.com',
      subject: 'New handoff request',
      body: '<p>A new handoff request needs attention.</p>',
      // Provider-level idempotency (ADR-0018): same key as the ledger row.
      idempotencyKey: 'handoff:h1:user-1',
    });
  });

  it('records a thrown provider error as failed and never sent', async () => {
    const tenant = await createTestTenant();
    send.mockRejectedValue(new Error('provider threw'));

    const result = await emailDeliveryService.sendDurable(input(tenant.id, 'handoff:h2:user-1'));
    const row = await AppDataSource.getRepository(EmailDelivery).findOneByOrFail({
      idempotencyKey: 'handoff:h2:user-1',
    });

    expect(result).toMatchObject({ status: 'failed', error: 'provider threw' });
    expect(row).toMatchObject({ status: 'failed', attemptCount: 1, error: 'provider threw' });
    expect(row.status).not.toBe('sent');
  });

  it('records a returned provider failure as failed and never sent', async () => {
    const tenant = await createTestTenant();
    send.mockResolvedValue({ success: false, error: 'provider rejected message' });

    const result = await emailDeliveryService.sendDurable(input(tenant.id, 'handoff:h3:user-1'));
    const row = await AppDataSource.getRepository(EmailDelivery).findOneByOrFail({
      idempotencyKey: 'handoff:h3:user-1',
    });

    expect(result).toMatchObject({ status: 'failed', error: 'provider rejected message' });
    expect(row).toMatchObject({
      status: 'failed',
      attemptCount: 1,
      error: 'provider rejected message',
    });
    expect(row.status).not.toBe('sent');
  });

  it('returns already_sent without calling the provider again', async () => {
    const tenant = await createTestTenant();
    const deliveryInput = input(tenant.id, 'handoff:h4:user-1');

    const first = await emailDeliveryService.sendDurable(deliveryInput);
    const second = await emailDeliveryService.sendDurable(deliveryInput);

    expect(first.status).toBe('sent');
    expect(second).toMatchObject({
      status: 'already_sent',
      deliveryId: first.deliveryId,
      providerMessageId: 'provider-message-1',
    });
    expect(send).toHaveBeenCalledTimes(1);
  });
});

describe('renderHandoffEmail', () => {
  it('contains only the operational handoff fields and omits customer PII', () => {
    const rendered = renderHandoffEmail({
      tenantName: 'Acme Support',
      botName: 'Acme Assistant',
      channel: 'widget',
      requestedAt: new Date('2026-08-16T10:30:00Z'),
      reason: 'bot_confidence_low',
      deepLink: 'https://portal.example/inbox?chat=session-123',
    });

    expect(rendered.subject).toBe('New handoff request');
    expect(rendered.body).toContain('Acme Support');
    expect(rendered.body).toContain('Acme Assistant');
    expect(rendered.body).toContain('widget');
    expect(rendered.body).toContain('2026');
    expect(rendered.body).toContain('bot confidence low');
    expect(rendered.body).toContain('https://portal.example/inbox?chat=session-123');
    expect(rendered.body).not.toContain('Ada Customer');
    expect(rendered.body).not.toContain('+15551234567');
    expect(rendered.body).not.toContain('42 Secret Address');
  });
});
