/**
 * Which address this conversation is about - held where the booking that uses it is written.
 *
 * This was Redis until #95. The move is not a preference: the booking INSERT lands in Postgres,
 * and a Redis lease cannot fence a Postgres write. If the lease lapses, mutual exclusion is gone
 * and a customer's confirmation can land between the check and the insert, so the booking persists
 * an address the customer has just replaced. That is a property of splitting the authority from
 * the write, not a gap to patch, and the only fix is to stop splitting them. A row lock on this
 * table gives directly what a lock, an ownership token, a lease and a renewer were all simulating.
 *
 * ## The three states, and why `address` is nullable
 *
 *   nothing bound      `address`, `place_id` and `source` all null. The ordinary state, and also
 *                      what a completed booking leaves behind.
 *   picked             the customer chose from suggestions. `place_id` is their identity for it.
 *   confirmed          the customer answered a correction question in the affirmative. There is no
 *                      `place_id`, because nothing was geocoded - a proposal is a question, not a
 *                      place, and resolving it would need an `ActiveTravelEligibility` this path
 *                      does not have.
 *
 * `pending` is INDEPENDENT of all three. A row with `pending` set and `address` null is the case
 * the whole design turns on: a booking took the address and consumed the question, the question is
 * still answerable, and the answer governs the NEXT booking rather than the one already made.
 *
 * ## Why the CHECK is on the entity and not only in the migration
 *
 * The test schema is built by `synchronize()` from entity metadata, not by running migrations, so
 * a constraint that exists only in a migration is absent from every test. There is exactly one
 * other `@Check` in this codebase for that reason. Both halves are written here: the decorator so
 * the invariant holds under test, and the migration so it holds in production.
 */
import { Entity, PrimaryColumn, Column, Check, UpdateDateColumn } from 'typeorm';

/** What is waiting on an answer. Stored as jsonb so the shape can grow without a migration. */
export interface PendingCorrectionRecord {
  /**
   * Which proposal an answer is answering.
   *
   * Derived from the normalised proposed text, so the same suggestion twice is the same proposal
   * and a customer restating their address differently supersedes rather than duplicates. It is
   * also what stops a late "yes" confirming a question the customer has already moved past.
   */
  proposalId: string;
  /** The address being proposed. Never a `place_id`: nothing has been resolved. */
  formattedAddress: string;
  /**
   * Set by the booking that took the address out from under this question.
   *
   * Its presence is the entire cutoff. A confirmation arriving afterwards may not touch that
   * booking - it is already made - but it still promotes the address for the next one, and the
   * customer is told which of the two happened rather than being silently ignored.
   */
  consumedByBooking?: string;
}

@Entity('chatbot_address_bindings')
// A picked address always carries its identity; a confirmed one never does; a cleared binding has
// neither. Written as a constraint rather than trusted to the two constructors, because the
// combination that matters most - `picked` with no `place_id` - is exactly what a careless promote
// would produce, and a test that has to remember to check it is a test that eventually forgets.
@Check(
  'ck_address_binding_active_consistent',
  // COALESCE, not a bare comparison. With `source` NULL the clauses read FALSE OR NULL OR NULL,
  // which evaluates to NULL - and a CHECK passes on NULL, failing only on FALSE. An address with
  // no source sailed through the first version of this constraint for exactly that reason, caught
  // by its own test. It is the same three-valued-logic hole that silently disables an exclusion
  // constraint when a nullable column joins the column list.
  `("address" IS NULL AND "source" IS NULL AND "place_id" IS NULL)
   OR ("address" IS NOT NULL AND COALESCE("source", '') = 'picked' AND "place_id" IS NOT NULL)
   OR ("address" IS NOT NULL AND COALESCE("source", '') = 'confirmed' AND "place_id" IS NULL)`
)
export class AddressBinding {
  /** One conversation, one row. The session is the natural key; there is nothing else to add. */
  @PrimaryColumn({ type: 'uuid', name: 'session_id' })
  sessionId!: string;

  @Column({ type: 'text', nullable: true })
  address?: string | null;

  @Column({ type: 'text', name: 'place_id', nullable: true })
  placeId?: string | null;

  @Column({ type: 'varchar', length: 16, nullable: true })
  source?: 'picked' | 'confirmed' | null;

  @Column({ type: 'jsonb', nullable: true })
  pending?: PendingCorrectionRecord | null;

  /**
   * Bumped by every transition, and read by the booking to assert the address has not moved since
   * it resolved one.
   *
   * ONLY the booking's assertion uses it. The confirm and reject paths must NOT, because consuming
   * a proposal legitimately bumps this - a confirmation that had been waiting behind the booking
   * would find its expected value stale and could never land, which would kill the exact case this
   * design exists to honour. Those paths key on `pending->>'proposalId'` instead, which identifies
   * the question rather than the generation.
   */
  @Column({ type: 'int', default: 0 })
  version!: number;

  /**
   * Refreshed on every write, and read as an expiry.
   *
   * Redis gave a 35-minute TTL for free and a table does not, so the staleness is enforced on READ
   * rather than trusted to a sweep: a row older than the window is absent whether or not anything
   * has deleted it. The window is anchored to the 30-minute session auto-close plus its 5-minute
   * sweep, so an address never disappears from under a conversation the platform still considers
   * live.
   */
  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updatedAt!: Date;
}
