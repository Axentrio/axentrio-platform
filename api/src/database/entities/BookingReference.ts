/**
 * BookingReference — links an internal booking to the external calendar event
 * it was mirrored to (Phase 1). Mirrors Cal.com's BookingReference. One row per
 * (booking, provider). Lets reschedule/cancel update/delete the right event.
 */
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from 'typeorm';

@Index(['bookingId', 'providerType'], { unique: true })
@Entity('chatbot_booking_references')
export class BookingReference {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'booking_id' })
  bookingId!: string;

  @Column({ type: 'varchar', length: 16, name: 'provider_type', default: 'google' })
  providerType!: string;

  @Column({ type: 'varchar', length: 1024, name: 'external_event_id' })
  externalEventId!: string;

  @Column({ type: 'varchar', length: 320, name: 'external_calendar_id' })
  externalCalendarId!: string;

  @Column({ type: 'varchar', length: 1024, name: 'meeting_url', nullable: true })
  meetingUrl?: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;
}
