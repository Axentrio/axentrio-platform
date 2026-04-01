import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
  Unique,
} from 'typeorm';
import { Tenant } from './Tenant';

@Entity('booking_logs')
@Index(['tenantId', 'createdAt'])
@Index(['tenantId', 'attendeeEmail'])
@Index(['calBookingId'])
@Unique(['tenantId', 'idempotencyKey'])
export class BookingLog {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'tenant_id' })
  tenantId!: string;

  @ManyToOne(() => Tenant, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'tenant_id' })
  tenant!: Tenant;

  @Column({ type: 'uuid', name: 'session_id' })
  sessionId!: string;

  @Column({ type: 'varchar', length: 255, nullable: true, name: 'idempotency_key' })
  idempotencyKey?: string;

  @Column({ type: 'varchar', length: 255, nullable: true, name: 'cal_booking_id' })
  calBookingId?: string;

  @Column({ type: 'varchar', length: 50, name: 'event_type' })
  eventType!: 'created' | 'rescheduled' | 'cancelled';

  @Column({ type: 'varchar', length: 255, nullable: true, name: 'attendee_name' })
  attendeeName?: string;

  @Column({ type: 'varchar', length: 255, nullable: true, name: 'attendee_email' })
  attendeeEmail?: string;

  @Column({ type: 'timestamptz', nullable: true, name: 'start_time' })
  startTime?: Date;

  @Column({ type: 'timestamptz', nullable: true, name: 'end_time' })
  endTime?: Date;

  @Column({ type: 'text', nullable: true })
  notes?: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
