/**
 * EventType — a bookable service for the internal scheduler.
 *
 * v1 enforces a single active event type per bot (partial unique index on
 * `bot_id WHERE is_active`). Durations/buffers/notice/horizon drive the slot
 * engine. Cal.com bots don't use this — internal-provider only.
 */
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
} from 'typeorm';
import { Tenant } from './Tenant';
import { Bot } from './Bot';

export type LocationType = 'google_meet' | 'phone' | 'in_person' | 'custom';

@Entity('chatbot_event_types')
export class EventType {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'tenant_id' })
  tenantId!: string;

  @Column({ type: 'uuid', name: 'bot_id' })
  botId!: string;

  @Column({ type: 'varchar', length: 255 })
  name!: string;

  @Column({ type: 'varchar', length: 255 })
  slug!: string;

  @Column({ type: 'int', name: 'duration_min', default: 30 })
  durationMin!: number;

  @Column({ type: 'int', name: 'buffer_before_min', default: 0 })
  bufferBeforeMin!: number;

  @Column({ type: 'int', name: 'buffer_after_min', default: 0 })
  bufferAfterMin!: number;

  /** Minimum lead time before a slot can be booked, in minutes. */
  @Column({ type: 'int', name: 'min_notice_min', default: 0 })
  minNoticeMin!: number;

  /** How far ahead bookings are allowed, in days. */
  @Column({ type: 'int', name: 'max_horizon_days', default: 60 })
  maxHorizonDays!: number;

  @Column({ type: 'varchar', length: 32, name: 'location_type', default: 'custom' })
  locationType!: LocationType;

  @Column({ type: 'boolean', name: 'is_active', default: true })
  isActive!: boolean;

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
