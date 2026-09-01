import { describe, it, expect, beforeEach, vi } from 'vitest';

const { send } = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock('../../automations', () => ({ getEmailService: () => ({ send }) }));

import { AppDataSource } from '../../database/data-source';
import { EmailDelivery } from '../../database/entities/EmailDelivery';
import { createTestTenant } from '../helpers/factories';
import { emailDeliveryService } from '../../services/email-delivery.service';
import { renderHandoffEmail } from '../../services/handoff-notification.service';
import { sweepFailedEmailDeliveries } from '../../notifications/email-retry.worker';

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

  it('stores a 266-character subject and a 300-character recipient', async () => {
    // `Confirmed: ${service.name}` with ServiceType.name at its own 255 cap is 266 characters,
    // and normalizeCustomerEmail accepts 320. Both overflowed varchar(255), and sendOrReport
    // swallows the throw, so the customer silently received no invite.
    const tenant = await createTestTenant();
    const key = `booking:wide:${Date.now()}:REQUEST:invite`;
    const subject = `Confirmed: ${'s'.repeat(255)}`;
    const recipient = `${'a'.repeat(288)}@example.com`;
    expect(subject).toHaveLength(266);
    expect(recipient).toHaveLength(300);

    const result = await emailDeliveryService.sendDurable({
      ...input(tenant.id, key),
      recipientEmail: recipient,
      subject,
      kind: 'booking_email',
    });

    expect(result.status).toBe('sent');
    const row = await AppDataSource.getRepository(EmailDelivery).findOneByOrFail({
      idempotencyKey: key,
    });
    expect(row.subject).toHaveLength(266);
    expect(row.recipientEmail).toHaveLength(300);
  });
});

describe('sweepFailedEmailDeliveries', () => {
  it('resends a retainPayload failure with the same idempotency key', async () => {
    const tenant = await createTestTenant();
    const key = `booking:uid:${Date.now()}:REQUEST:invite`;
    send.mockRejectedValueOnce(new Error('outage'));

    await emailDeliveryService.sendDurable({
      ...input(tenant.id, key),
      kind: 'booking_email',
      retainPayload: true,
      from: 'bookings@example.com',
    });

    const repo = AppDataSource.getRepository(EmailDelivery);
    const failed = await repo.findOneByOrFail({ idempotencyKey: key });
    expect(failed.status).toBe('failed');
    expect(failed.payload).toMatchObject({
      subject: 'New handoff request',
      body: '<p>A new handoff request needs attention.</p>',
      from: 'bookings@example.com',
    });
    expect(failed.nextAttemptAt).toBeTruthy();

    failed.nextAttemptAt = new Date(Date.now() - 1000);
    await repo.save(failed);

    send.mockReset();
    send.mockResolvedValue({ success: true, messageId: 'retry-1' });

    const result = await sweepFailedEmailDeliveries();
    expect(result.resent).toBe(1);

    const row = await repo.findOneByOrFail({ idempotencyKey: key });
    expect(row.status).toBe('sent');
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'operator@example.com',
        idempotencyKey: key,
      }),
    );
  });

  it('never claims a row at attempt_count 6', async () => {
    const tenant = await createTestTenant();
    const key = `booking:cap:${Date.now()}:REQUEST:invite`;
    const repo = AppDataSource.getRepository(EmailDelivery);
    await repo.insert(
      repo.create({
        tenantId: tenant.id,
        recipientUserId: null,
        recipientEmail: 'ada@example.com',
        subject: 'Confirmed: x',
        kind: 'booking_email',
        relatedId: '00000000-0000-0000-0000-000000000002',
        status: 'failed',
        attemptCount: 6,
        idempotencyKey: key,
        providerMessageId: null,
        error: 'outage',
        payload: { subject: 'Confirmed: x', body: '<p>x</p>' },
        nextAttemptAt: new Date(Date.now() - 1000),
      }),
    );

    send.mockClear();
    const result = await sweepFailedEmailDeliveries();
    expect(result.resent).toBe(0);
    expect(send).not.toHaveBeenCalled();
    const row = await repo.findOneByOrFail({ idempotencyKey: key });
    expect(row.status).toBe('failed');
    expect(row.attemptCount).toBe(6);
  });

  it('keeps sweeping after a row throws, so one poison row cannot starve the batch', async () => {
    // sendDurable turns a provider failure into a `failed` RESULT rather than a throw, so a
    // malformed payload proves nothing here. The throw this guards against is anything else on
    // the row path: forced by rejecting the first call, then delegating to the real one.
    const tenant = await createTestTenant();
    const stamp = Date.now();
    const poisonKey = `booking:poison:${stamp}:REQUEST:invite`;
    const goodKey = `booking:good:${stamp}:REQUEST:invite`;
    const repo = AppDataSource.getRepository(EmailDelivery);

    const failedRow = (key: string, email: string) =>
      repo.create({
        tenantId: tenant.id,
        recipientUserId: null,
        recipientEmail: email,
        subject: 'Confirmed: klantenafspraak',
        kind: 'booking_email',
        relatedId: '00000000-0000-0000-0000-000000000002',
        status: 'failed' as const,
        attemptCount: 1,
        idempotencyKey: key,
        providerMessageId: null,
        error: 'outage',
        payload: { subject: 'Confirmed: klantenafspraak', body: '<p>x</p>' },
        nextAttemptAt: new Date(Date.now() - 1000),
      });
    await repo.insert(failedRow(poisonKey, 'poison@example.com'));
    await repo.insert(failedRow(goodKey, 'good@example.com'));
    // created_at ASC decides the claim order, so the thrower has to be first.
    await AppDataSource.query(
      `UPDATE email_deliveries SET created_at = now() - interval '1 hour' WHERE idempotency_key = $1`,
      [poisonKey],
    );

    const real = emailDeliveryService.sendDurable;
    const spy = vi
      .spyOn(emailDeliveryService, 'sendDurable')
      .mockRejectedValueOnce(new Error('poison row'))
      .mockImplementation((sendInput) => real.call(emailDeliveryService, sendInput));

    send.mockReset();
    send.mockResolvedValue({ success: true, messageId: 'after-poison' });

    await sweepFailedEmailDeliveries();

    expect(spy.mock.calls.length).toBeGreaterThanOrEqual(2);
    // The batch carried on: the row after the thrower still went out.
    expect((await repo.findOneByOrFail({ idempotencyKey: goodKey })).status).toBe('sent');
    expect((await repo.findOneByOrFail({ idempotencyKey: poisonKey })).status).toBe('failed');
    spy.mockRestore();
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
