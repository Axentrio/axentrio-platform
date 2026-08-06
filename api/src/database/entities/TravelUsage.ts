/**
 * TravelUsage — how much of Google Maps a Tenant has spent this month.
 *
 * A TABLE, not a Redis counter, and the distinction is the whole point: a spend guard that
 * forgets its total on deploy is not a spend guard. `MeteringService` counts LLM tokens in
 * Redis against a daily budget, which is fine for a limit that resets every night anyway;
 * a monthly cap on a metered external bill has to survive a restart, and this platform
 * deploys more often than once a month.
 *
 * The row exists before anything can spend. Travel time is the first capability on the
 * platform with a real per-use external cost, and the ordering — cap first, callers later
 * — is deliberate: a guard introduced after the thing it guards has already been running
 * unmetered for a release.
 *
 * `elements` counts BILLABLE GOOGLE UNITS, not requests. Route Matrix prices per
 * origin×destination pair, so one call for three candidate slots costs three. Counting
 * calls would undercount by exactly the factor that matters.
 *
 * Exhausting the cap is NOT an outage and must not read as one: it degrades to the same
 * branch as Routes being unreachable (ADR-0015) — provably-impossible slots still refused
 * on the haversine bounds, provably-fine ones still confirmed, the undecided middle band
 * captured as requests.
 */
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

@Entity('chatbot_travel_usage')
// UNIQUE rather than a plain index: this is the ON CONFLICT target that keeps the
// increment a single atomic statement. Without it, two concurrent bookings each insert a
// row and the tenant's total silently halves.
@Index('ux_travel_usage_tenant_period', ['tenantId', 'periodStart'], { unique: true })
export class TravelUsage {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'tenant_id' })
  tenantId!: string;

  /**
   * First day of a UTC calendar month. A calendar month rather than a rolling window
   * because a spend guard has to be explainable to whoever pays the bill, and the bill
   * arrives monthly.
   */
  @Column({ type: 'date', name: 'period_start' })
  periodStart!: string;

  @Column({ type: 'int', default: 0 })
  elements!: number;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;
}
