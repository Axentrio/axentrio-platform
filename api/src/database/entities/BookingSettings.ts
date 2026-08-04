/**
 * BookingSettings — booking configuration that belongs to the BUSINESS rather than to one
 * service or one weekly schedule.
 *
 * Why a table of its own rather than another column on `AvailabilityRule`: that row answers
 * *when* the owner is bookable, and a service area answers *where* they will work. They are
 * edited together in one card, but they are not the same fact, and folding one into the
 * other would leave the next business-level setting (a daily cap, a default notice period)
 * with nowhere honest to live either.
 *
 * One row per bot, created lazily on first write — a bot without one simply has no service
 * area, which is the behaviour every bot had before this table existed.
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
import type { ServiceAreaEntry } from '../../contracts/service-area';
import { Tenant } from './Tenant';
import { Bot } from './Bot';

@Entity('chatbot_booking_settings')
@Index(['botId'], { unique: true })
export class BookingSettings {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'tenant_id' })
  tenantId!: string;

  @Column({ type: 'uuid', name: 'bot_id' })
  botId!: string;

  /**
   * Places this business serves. Empty array = no area configured, which never blocks a
   * booking. Stays loosely typed on read: a legacy or hand-edited non-array degrades to
   * "no area" at every consumer rather than throwing mid-booking.
   */
  @Column({ type: 'jsonb', name: 'service_area', default: () => `'[]'::jsonb` })
  serviceArea!: ServiceAreaEntry[];

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
