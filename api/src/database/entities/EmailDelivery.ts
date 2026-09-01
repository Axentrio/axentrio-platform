/**
 * Durable email delivery ledger.
 *
 * One row represents one logical email for one recipient. The idempotency key
 * is the load-bearing uniqueness boundary for provider retries.
 */

import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
  Check,
} from 'typeorm';

export type EmailDeliveryStatus = 'pending' | 'sent' | 'failed';

export interface EmailDeliveryPayload {
  from?: string;
  replyTo?: string;
  subject: string;
  body: string;
  attachments?: Array<{ filename: string; content: string; contentType?: string }>;
}

@Entity('email_deliveries')
@Check('ck_email_deliveries_status', "status IN ('pending', 'sent', 'failed')")
@Index(['tenantId'])
@Index(['relatedId'])
@Index('uq_email_deliveries_idempotency_key', ['idempotencyKey'], { unique: true })
export class EmailDelivery {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'tenant_id' })
  tenantId!: string;

  @Column({ type: 'uuid', nullable: true, name: 'recipient_user_id' })
  recipientUserId!: string | null;

  @Column({ type: 'varchar', length: 255, name: 'recipient_email' })
  recipientEmail!: string;

  @Column({ type: 'varchar', length: 255 })
  subject!: string;

  @Column({ type: 'varchar', length: 64 })
  kind!: string;

  @Column({ type: 'uuid', name: 'related_id' })
  relatedId!: string;

  @Column({ type: 'varchar', length: 24, default: 'pending' })
  status!: EmailDeliveryStatus;

  @Column({ type: 'int', default: 0, name: 'attempt_count' })
  attemptCount!: number;

  @Column({ type: 'varchar', length: 255, name: 'idempotency_key' })
  idempotencyKey!: string;

  @Column({ type: 'varchar', length: 255, nullable: true, name: 'provider_message_id' })
  providerMessageId!: string | null;

  @Column({ type: 'text', nullable: true })
  error!: string | null;

  @Column({ type: 'jsonb', nullable: true })
  payload?: EmailDeliveryPayload | null;

  @Column({ type: 'timestamptz', name: 'next_attempt_at', nullable: true })
  nextAttemptAt?: Date | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;
}
