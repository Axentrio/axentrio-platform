/**
 * Notification Entity
 * DB-backed operator notifications (replaces the legacy in-memory store).
 * One row per recipient; `dedupeKey` makes creation idempotent per event+recipient.
 */

import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

@Entity('notifications')
@Index(['tenantId', 'recipientUserId', 'readAt'])
export class Notification {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'tenant_id' })
  tenantId!: string;

  @Column({ type: 'uuid', name: 'recipient_user_id' })
  recipientUserId!: string;

  @Column({ type: 'varchar', length: 64 })
  type!: string;

  @Column({ type: 'varchar', length: 200 })
  title!: string;

  @Column({ type: 'text' })
  message!: string;

  @Column({ type: 'jsonb', nullable: true })
  data?: Record<string, unknown>;

  @Column({ type: 'timestamptz', nullable: true, name: 'read_at' })
  readAt?: Date | null;

  /** `${type}:${entityId}:${recipientUserId}` — unique for idempotent creation. */
  @Column({ type: 'varchar', length: 255, nullable: true, unique: true, name: 'dedupe_key' })
  dedupeKey?: string;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;
}
