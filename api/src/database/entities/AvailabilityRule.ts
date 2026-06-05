/**
 * AvailabilityRule — when a bot's owner is bookable (internal scheduler).
 *
 * One row per bot. `weeklyHours` is the recurring weekly schedule expressed in
 * the owner's `timezone` (local "HH:MM" windows). `dateOverrides` are one-off
 * exceptions (holiday closures or special open days) keyed by calendar date.
 * The slot engine (`booking-providers/slot-engine.ts`) expands these into
 * concrete UTC slots. Cal.com bots don't use this — it's internal-provider only.
 */
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import { Tenant } from './Tenant';
import { Bot } from './Bot';

/** A local-time window, "HH:MM"–"HH:MM" in the rule's timezone. */
export interface TimeWindow {
  start: string;
  end: string;
}

export type Weekday = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';

/** Recurring weekly hours: each weekday maps to zero or more open windows. */
export type WeeklyHours = Partial<Record<Weekday, TimeWindow[]>>;

/**
 * A one-off override for a specific date (YYYY-MM-DD, in the rule timezone).
 * `closed: true` → fully unavailable that day. Otherwise `windows` replaces the
 * weekly hours for that day.
 */
export interface DateOverride {
  date: string;
  closed?: boolean;
  windows?: TimeWindow[];
}

@Entity('chatbot_availability_rules')
@Index(['botId'], { unique: true })
export class AvailabilityRule {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'tenant_id' })
  tenantId!: string;

  @Column({ type: 'uuid', name: 'bot_id' })
  botId!: string;

  /** IANA timezone, e.g. "Europe/Brussels". */
  @Column({ type: 'varchar', length: 64, default: 'UTC' })
  timezone!: string;

  @Column({ type: 'jsonb', name: 'weekly_hours', default: {} })
  weeklyHours!: WeeklyHours;

  @Column({ type: 'jsonb', name: 'date_overrides', default: [] })
  dateOverrides!: DateOverride[];

  @Column({ type: 'int', name: 'slot_granularity_min', default: 30 })
  slotGranularityMin!: number;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;

  @ManyToOne(() => Tenant, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'tenant_id' })
  tenant?: Tenant;

  @ManyToOne(() => Bot, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'bot_id' })
  bot?: Bot;
}
