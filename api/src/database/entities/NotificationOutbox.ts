/**
 * Handoff-notification outbox — the durability backstop for operator alerts.
 *
 * One row is written INSIDE the handoff-creation transaction (`requestHandoff`),
 * so the intent to alert cannot survive-fail the commit that created the handoff.
 * A sweep worker replays `notifyNewHandoff` from `payload`; that function is
 * idempotent (per-recipient notification dedupe + per-recipient email idempotency
 * key), so a double dispatch never double-sends. See ADR-0018.
 *
 * `status`: `pending` until delivered, `sent` once dispatched, `dead` once the
 * attempt cap is hit. `next_attempt_at` is both the initial grace (so the
 * immediate best-effort notify wins the happy path) and the backoff visibility
 * timeout (a crash mid-dispatch simply retries after it elapses).
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

export type NotificationOutboxStatus = 'pending' | 'sent' | 'dead';

/**
 * The initial grace on `next_attempt_at`: the immediate best-effort notify has
 * this long to run and mark the row `sent` before the worker would pick it up,
 * so the happy path is not dispatched twice.
 */
export const HANDOFF_OUTBOX_GRACE_MS = 90_000;

/** The `NewHandoffNotificationParams` a worker needs to replay a handoff alert. */
export interface HandoffOutboxPayload {
  tenantId: string;
  handoffId: string;
  sessionId: string;
  reason: string;
  /** ISO-8601; rehydrated to a Date before dispatch. */
  requestedAt: string;
}

@Entity('notification_outbox')
@Check('ck_notification_outbox_status', "status IN ('pending', 'sent', 'dead')")
@Index('ix_notification_outbox_claim', ['status', 'nextAttemptAt'])
@Index('uq_notification_outbox_kind_related', ['kind', 'relatedId'], { unique: true })
export class NotificationOutbox {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'tenant_id' })
  tenantId!: string;

  /** Discriminates the payload shape. Only `handoff` today. */
  @Column({ type: 'varchar', length: 64 })
  kind!: string;

  /** The entity this alert is about — the handoff id. Unique with `kind`. */
  @Column({ type: 'uuid', name: 'related_id' })
  relatedId!: string;

  @Column({ type: 'jsonb' })
  payload!: HandoffOutboxPayload;

  @Column({ type: 'varchar', length: 24, default: 'pending' })
  status!: NotificationOutboxStatus;

  @Column({ type: 'int', default: 0, name: 'attempt_count' })
  attemptCount!: number;

  @Column({ type: 'timestamptz', name: 'next_attempt_at', default: () => 'now()' })
  nextAttemptAt!: Date;

  @Column({ type: 'text', nullable: true, name: 'last_error' })
  lastError!: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;
}
