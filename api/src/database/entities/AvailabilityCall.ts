import { Entity, PrimaryGeneratedColumn, Column, Index, CreateDateColumn } from 'typeorm';

/**
 * Every `check_availability` call, surfaced or not (#80, LP3).
 *
 * A SEPARATE TABLE FROM THE OFFER, because #80 asks two questions with two different measurement
 * units and one table cannot answer both. "What share of bookings took the first offered slot" is
 * per delivered OFFER. "What share of availability calls requested a range spanning more than one
 * day" is per CALL - and calls the model discards never become offers, while several calls can
 * precede one response, so an offer-level denominator is wrong in both directions.
 *
 * The second question is also location-independent, which is why this table records every call
 * rather than only the travel ones. It supplies #84's gate: whether enough customers ask across
 * several days for structured flexibility to be worth collecting.
 *
 * Cheap by design - no address, no coordinates, no free text beyond the raw range the caller
 * asked for.
 */
@Entity('chatbot_availability_calls')
@Index('ix_availability_calls_created', ['createdAt'])
@Index('ix_availability_calls_session', ['sessionId'])
export class AvailabilityCall {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'tenant_id' })
  tenantId!: string;

  @Column({ type: 'uuid', name: 'bot_id' })
  botId!: string;

  /** No foreign key: a purged session must not be held alive by a measurement row. */
  @Column({ type: 'uuid', name: 'session_id' })
  sessionId!: string;

  /**
   * Null when the call did not resolve one. Still recorded: a customer asking about times they
   * cannot yet name a service for is a customer asking, which is what the range metric counts.
   */
  @Column({ type: 'uuid', name: 'service_id', nullable: true })
  serviceId?: string | null;

  /**
   * The parsed range in the BUSINESS timezone, inclusive, or null when it did not parse.
   *
   * Both are needed alongside `rangeValid` because a malformed range has to be RECORDABLE rather
   * than unrepresentable - a parse failure is not a customer behaviour and must not silently join
   * the single-day population, which is what typed-columns-only would have done.
   */
  @Column({ type: 'date', name: 'requested_start_date', nullable: true })
  requestedStartDate?: string | null;

  @Column({ type: 'date', name: 'requested_end_date', nullable: true })
  requestedEndDate?: string | null;

  /** Exactly what the caller asked for, so a bad range can be diagnosed rather than guessed at. */
  @Column({ type: 'varchar', length: 128, name: 'requested_range_raw', nullable: true })
  requestedRangeRaw?: string | null;

  /** False excludes this row from the range metric's denominator. */
  @Column({ type: 'boolean', name: 'range_valid', default: true })
  rangeValid!: boolean;

  /** How many slots came back. Zero is a real and interesting answer. */
  @Column({ type: 'int', name: 'slot_count', default: 0 })
  slotCount!: number;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;
}
