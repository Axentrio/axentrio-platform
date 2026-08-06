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

/**
 * How the slot engine treats `weeklyHours`:
 *  - `business_hours` (default): slots are restricted to the configured weekly
 *    windows — a barber doesn't get 3am bookings.
 *  - `always_open`: the owner is bookable around the clock (every day 00:00–24:00),
 *    so the only limits are the connected calendar's busy times + min-notice/horizon.
 *    Suits emergency trades (a plumber) and fixes the "empty hours = never open" footgun.
 * Date-override closures still apply in both modes (a holiday is still closed).
 */
export type AvailabilityMode = 'always_open' | 'business_hours';

/** Recurring weekly hours: each weekday maps to zero or more open windows. */
export type WeeklyHours = Partial<Record<Weekday, TimeWindow[]>>;

/**
 * A one-off override for a specific date (YYYY-MM-DD, in the rule timezone).
 * `closed: true` → fully unavailable that day. Otherwise `windows` replaces the
 * weekly hours for that day.
 */
export interface DateOverride {
  date: string;
  /**
   * Inclusive last day of a multi-day override. Absent = a single day.
   *
   * Added because a closure could only ever be ONE date: a hairdresser shutting for two
   * weeks in August had to add fourteen rows by hand, and only the first eight upcoming
   * closures are ever stated to the bot — so from day nine it went back to quoting the
   * weekly hours and telling customers their time would be confirmed for a day the
   * business was shut.
   */
  endDate?: string;
  closed?: boolean;
  windows?: TimeWindow[];
}

/**
 * Does this override apply on `dateStr` (YYYY-MM-DD)?
 *
 * ISO dates compare correctly as strings, so no parsing and no timezone maths — which also
 * means this cannot drift from however the caller derived `dateStr`. A missing or malformed
 * `endDate` degrades to a single-day override rather than swallowing a whole year.
 */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The override's inclusive last day, or `null` when it is a single-day row.
 *
 * The SHAPE check is what matters, not just the ordering. A garbage `endDate` like "zzz"
 * compares greater than every ISO date, so without this it becomes an open-ended upper
 * bound and one malformed row closes the business forever. A backwards range is already
 * empty by construction; a malformed one is not.
 *
 * Every surface that interprets `endDate` must go through this. The engine used to shape-check
 * while the prompt builder only compared ordering, so a hand-edited `"zzz"` was stated to
 * customers as a closure that never ends while the engine ignored the row entirely.
 */
export function effectiveEndDate(o: DateOverride): string | null {
  if (!o?.date || !o.endDate) return null;
  if (!ISO_DATE.test(o.endDate) || o.endDate < o.date) return null;
  return o.endDate;
}

/** A row that spans more than its start date. Single-day rows are the common case. */
export function isRangedOverride(o: DateOverride): boolean {
  const end = effectiveEndDate(o);
  return end !== null && end > o.date;
}

export function overrideCoversDate(o: DateOverride, dateStr: string): boolean {
  if (!o?.date) return false;
  if (o.date === dateStr) return true;
  const end = effectiveEndDate(o);
  if (!end) return false;
  return dateStr > o.date && dateStr <= end;
}

/**
 * Of the overrides covering a date, the one that actually applies: the **narrowest**.
 *
 * Rows are stored in the order the owner added them and nothing sorts or merges them, so
 * plain first-match made precedence depend on insertion order — invisible in the portal and
 * unchangeable by the owner. A re-open day typed inside an existing closure range lost to the
 * range, while the prompt stated both rows, so the bot offered a day it could not book.
 * Narrowest-wins makes the specific exception beat the broad rule, which is the only reading
 * that matches how the two rows are worded on screen.
 */
export function pickOverrideForDate(
  overrides: DateOverride[] | null | undefined,
  dateStr: string
): DateOverride | undefined {
  let best: DateOverride | undefined;
  let bestSpan = Infinity;
  for (const o of overrides || []) {
    if (!overrideCoversDate(o, dateStr)) continue;
    const end = effectiveEndDate(o);
    // Cheap ordinal span: ISO dates make lexical comparison total, and only the RANKING
    // matters here, so counting calendar days would buy nothing.
    const span = end ? Date.parse(`${end}T00:00:00Z`) - Date.parse(`${o.date}T00:00:00Z`) : 0;
    if (span < bestSpan) {
      best = o;
      bestSpan = span;
    }
  }
  return best;
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

  /** Whether `weeklyHours` gates bookable slots, or the owner is open 24/7. */
  @Column({ type: 'varchar', length: 16, name: 'availability_mode', default: 'business_hours' })
  availabilityMode!: AvailabilityMode;

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
