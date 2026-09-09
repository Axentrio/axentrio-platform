import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from 'typeorm';

/**
 * A legal hold: stop the retention sweeps deleting a named set of rows.
 *
 * The GDPR allows retention past an erasure or a retention period where the data
 * is needed for the establishment, exercise or defence of legal claims
 * (Art 17(3)(e)). The analysis called this bucket 2 of the retention proposal and
 * nothing implemented it — worse, the only stub (`UploadService.extendRetention`)
 * was dead code and has since been removed, so the codebase did not even gesture
 * at the concept.
 *
 * Three properties matter:
 *
 * 1. **It is evidence about a SPECIFIC dispute, not a switch that turns retention
 *    off.** `scope` names the rows; `{ all: true }` exists for the rare case where
 *    the whole workspace is in scope, but the default is a list.
 * 2. **It is reviewed.** `review_due_at` is required, because a hold nobody revisits
 *    becomes indefinite retention — the thing Art 5(1)(e) forbids.
 * 3. **It is reversible and auditable.** Releasing records who and why; opening and
 *    releasing both write a compliance event.
 */
@Entity('legal_holds')
@Index(['tenantId', 'releasedAt'])
export class LegalHold {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'tenant_id' })
  tenantId!: string;

  /** Why the data is being kept. The reason IS the legal basis — never empty. */
  @Column({ type: 'text' })
  reason!: string;

  /**
   * What is protected: `{ all: true }`, `{ sessionIds: [...] }`, `{ leadIds: [...] }`.
   * Several keys may be combined; an empty object protects nothing.
   */
  @Column({ type: 'jsonb', default: {} })
  scope!: {
    all?: boolean;
    sessionIds?: string[];
    leadIds?: string[];
  };

  @Column({ type: 'uuid', name: 'opened_by' })
  openedBy!: string;

  @CreateDateColumn({ type: 'timestamptz', name: 'opened_at' })
  openedAt!: Date;

  /** A hold must be revisited by this date. Indefinite holds are the failure mode. */
  @Column({ type: 'timestamptz', name: 'review_due_at' })
  reviewDueAt!: Date;

  @Column({ type: 'timestamptz', nullable: true, name: 'released_at' })
  releasedAt?: Date | null;

  @Column({ type: 'uuid', nullable: true, name: 'released_by' })
  releasedBy?: string | null;

  @Column({ type: 'text', nullable: true, name: 'release_reason' })
  releaseReason?: string | null;
}
