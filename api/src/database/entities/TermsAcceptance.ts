import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from 'typeorm';

/**
 * Proof that a named person accepted a named version of the Terms, when, and from
 * where.
 *
 * Nothing recorded this before: the analysis searched for `acceptedTerms`,
 * `termsAccepted`, `tosAccepted` and `consentAt` and found only
 * `HandoffRequest.acceptedAt`, which is an agent taking a chat. Without it, the
 * contract you are enforcing is the one you cannot show anyone.
 *
 * One row per (tenant, user, version): re-accepting the same version is idempotent,
 * and a new version adds a row rather than overwriting the old one — the history
 * IS the evidence.
 */
@Entity('terms_acceptances')
@Index(['tenantId', 'userId', 'termsVersion'], { unique: true })
export class TermsAcceptance {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'tenant_id' })
  tenantId!: string;

  @Column({ type: 'uuid', name: 'user_id' })
  userId!: string;

  @Column({ type: 'varchar', length: 32, name: 'terms_version' })
  termsVersion!: string;

  @CreateDateColumn({ name: 'accepted_at' })
  acceptedAt!: Date;

  /** Evidence of WHO accepted: an IP and a user agent are worth recording. */
  @Column({ type: 'varchar', length: 45, nullable: true, name: 'ip_address' })
  ipAddress?: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true, name: 'user_agent' })
  userAgent?: string | null;
}
