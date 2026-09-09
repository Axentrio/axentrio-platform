import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from 'typeorm';

/**
 * Long-lived compliance proof.
 *
 * `audit_logs` is the security trail and is deleted after `AUDIT_RETENTION_DAYS`
 * (90 by default). The events here are the ones a regulator, a court or a
 * customer dispute actually asks for — "prove you deleted my data", "prove the
 * retention sweep ran", "prove who changed the retention period" — and those
 * questions routinely arrive more than 90 days later. Keeping them in the same
 * table as login noise forced one period to serve two incompatible purposes;
 * this table lets each have its own.
 *
 * Rows here are Axentrio's OWN records (controller side), not tenant content:
 * they name the tenant, the event and the counts, never the data subject's
 * details.
 */
@Entity('compliance_events')
@Index(['tenantId', 'createdAt'])
@Index(['eventType', 'createdAt'])
export class ComplianceEvent {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** Null for platform-level events that belong to no single tenant. */
  @Column({ type: 'uuid', nullable: true, name: 'tenant_id' })
  tenantId?: string | null;

  /** The user who caused it, or `system` for a scheduled sweep. */
  @Column({ type: 'varchar', length: 100, name: 'actor_id' })
  actorId!: string;

  /** e.g. `leads.erased`, `conversations.retention_applied`. */
  @Column({ type: 'varchar', length: 100, name: 'event_type' })
  eventType!: string;

  @Column({ type: 'varchar', length: 50, nullable: true, name: 'subject_type' })
  subjectType?: string | null;

  /**
   * Varchar rather than uuid: a subject is sometimes a lead or session id, but
   * sometimes a tenant slug or a settings key.
   */
  @Column({ type: 'varchar', length: 255, nullable: true, name: 'subject_id' })
  subjectId?: string | null;

  @Column({ type: 'jsonb', nullable: true })
  details?: Record<string, unknown> | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;
}
