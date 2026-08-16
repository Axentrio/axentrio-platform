import { AppDataSource } from '../database/data-source';
import { EmailDelivery, EmailDeliveryStatus } from '../database/entities/EmailDelivery';
import { getEmailService } from '../automations';

export interface SendDurableInput {
  tenantId: string;
  recipientUserId?: string | null;
  recipientEmail: string;
  subject: string;
  body: string;
  kind: string;
  relatedId: string;
  idempotencyKey: string;
}

export type SendDurableResult =
  | {
      status: 'sent' | 'failed' | 'already_sent';
      deliveryId: string;
      providerMessageId?: string;
      error?: string;
    };

function isUniqueViolation(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as {
    code?: unknown;
    driverError?: { code?: unknown };
  };
  return candidate.code === '23505' || candidate.driverError?.code === '23505';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function providerFailureMessage(result: unknown): string {
  if (result && typeof result === 'object') {
    const candidate = result as { error?: unknown };
    if (typeof candidate.error === 'string' && candidate.error.length > 0) {
      return candidate.error;
    }
  }
  return 'Email provider returned failure';
}

async function findOrCreateDelivery(input: SendDurableInput): Promise<EmailDelivery> {
  const repo = AppDataSource.getRepository(EmailDelivery);
  const existing = await repo.findOne({ where: { idempotencyKey: input.idempotencyKey } });
  if (existing) return existing;

  try {
    await repo.insert(
      repo.create({
        tenantId: input.tenantId,
        recipientUserId: input.recipientUserId ?? null,
        recipientEmail: input.recipientEmail,
        subject: input.subject,
        kind: input.kind,
        relatedId: input.relatedId,
        status: 'pending',
        attemptCount: 0,
        idempotencyKey: input.idempotencyKey,
        providerMessageId: null,
        error: null,
      }),
    );
  } catch (error) {
    // Another caller won the idempotency-key insert race. Re-fetch below and
    // let the row lock decide which caller, if any, may call the provider.
    if (!isUniqueViolation(error)) throw error;
  }

  const delivery = await repo.findOne({ where: { idempotencyKey: input.idempotencyKey } });
  if (!delivery) {
    throw new Error(`Email delivery row missing for idempotency key ${input.idempotencyKey}`);
  }
  return delivery;
}

export const emailDeliveryService = {
  async sendDurable(input: SendDurableInput): Promise<SendDurableResult> {
    const existing = await findOrCreateDelivery(input);
    if (existing.status === 'sent') {
      return {
        status: 'already_sent',
        deliveryId: existing.id,
        providerMessageId: existing.providerMessageId ?? undefined,
      };
    }

    // Keep the row lock held across the provider call. This is deliberately a
    // short transaction around one email and is what prevents two concurrent
    // callers that share an idempotency key from both sending while the row is
    // still pending.
    return AppDataSource.transaction(async (manager) => {
      const repo = manager.getRepository(EmailDelivery);
      const delivery = await repo.findOne({
        where: { idempotencyKey: input.idempotencyKey },
        lock: { mode: 'pessimistic_write' },
      });
      if (!delivery) {
        throw new Error(`Email delivery row missing for idempotency key ${input.idempotencyKey}`);
      }
      if (delivery.status === 'sent') {
        return {
          status: 'already_sent' as const,
          deliveryId: delivery.id,
          providerMessageId: delivery.providerMessageId ?? undefined,
        };
      }

      let result: { success?: boolean; messageId?: string; error?: string } | undefined;
      try {
        result = await getEmailService().send({
          to: input.recipientEmail,
          subject: input.subject,
          body: input.body,
          // Provider-level idempotency (ADR-0018): the same key that guards the
          // ledger row also guards Resend, so a retry after a crash between
          // provider-accept and our commit cannot produce a second email.
          idempotencyKey: input.idempotencyKey,
        });
      } catch (error) {
        delivery.status = 'failed' as EmailDeliveryStatus;
        delivery.attemptCount += 1;
        delivery.error = errorMessage(error);
        await repo.save(delivery);
        return {
          status: 'failed' as const,
          deliveryId: delivery.id,
          error: delivery.error,
        };
      }

      delivery.attemptCount += 1;
      if (!result || result.success !== true) {
        delivery.status = 'failed';
        delivery.error = providerFailureMessage(result);
        await repo.save(delivery);
        return {
          status: 'failed' as const,
          deliveryId: delivery.id,
          error: delivery.error,
        };
      }

      delivery.status = 'sent';
      delivery.providerMessageId = result.messageId ?? null;
      delivery.error = null;
      await repo.save(delivery);
      return {
        status: 'sent' as const,
        deliveryId: delivery.id,
        providerMessageId: result.messageId,
      };
    });
  },
};
