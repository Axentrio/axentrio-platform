import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from 'typeorm';

/**
 * Idempotency + status sink for inbound Stripe webhook deliveries.
 *
 * This is the "inbound-event sibling" of `WebhookEventLog` referenced in
 * `.scratch/plan-m0-foundation-reshape.md` § PR9. `WebhookEventLog` itself
 * is channel-specific (Meta/Instagram/Telegram messaging webhooks) with
 * NOT NULL columns that do not apply to Stripe billing events, so a
 * dedicated table is the cleanest fit.
 *
 * Concurrency contract (locked by PR9):
 *   BEGIN
 *   pg_try_advisory_xact_lock(hashtext('webhook_event:stripe:' || event_id))
 *   --- if FALSE: ROLLBACK; HTTP 503 + Retry-After: 5
 *   --- if TRUE:
 *   SELECT status, attempts FROM chatbot_stripe_webhook_events WHERE ...
 *   --- if status='processed': ROLLBACK; HTTP 200 (replay short-circuit)
 *   --- else: UPSERT to status='processing', attempts++
 *   SAVEPOINT handler_body; <run handler>;
 *   --- success: RELEASE SAVEPOINT; UPDATE row status='processed'
 *   --- failure: ROLLBACK TO SAVEPOINT; UPDATE row status='failed', last_error
 *   COMMIT
 *
 * The outer COMMIT runs regardless of handler outcome so the status update
 * is durable; the SAVEPOINT contains the handler's mutations to local
 * tenant/billing state.
 */
export type StripeWebhookEventStatus = 'processing' | 'processed' | 'failed';

@Entity('chatbot_stripe_webhook_events')
@Index('uq_chatbot_stripe_webhook_events_provider_event', ['provider', 'eventId'], {
  unique: true,
})
@Index('idx_chatbot_stripe_webhook_events_status_created', ['status', 'createdAt'])
@Index('idx_chatbot_stripe_webhook_events_tenant_created', ['tenantId', 'createdAt'])
export class StripeWebhookEvent {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 32 })
  provider!: string;

  @Column({ type: 'varchar', length: 255, name: 'event_id' })
  eventId!: string;

  @Column({ type: 'varchar', length: 128, name: 'event_type' })
  eventType!: string;

  @Column({ type: 'varchar', length: 32 })
  status!: StripeWebhookEventStatus;

  @Column({ type: 'integer', default: 0 })
  attempts!: number;

  @Column({ type: 'text', nullable: true, name: 'last_error' })
  lastError?: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true, name: 'subscription_id' })
  subscriptionId?: string | null;

  @Column({ type: 'uuid', nullable: true, name: 'tenant_id' })
  tenantId?: string | null;

  @Column({ type: 'jsonb' })
  payload!: Record<string, unknown>;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;

  @Column({ type: 'timestamptz', nullable: true, name: 'processed_at' })
  processedAt?: Date | null;
}
