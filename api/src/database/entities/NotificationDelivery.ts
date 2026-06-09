/**
 * NotificationDelivery Entity
 * Tracks per-device delivery of a notification through the push provider.
 */

import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

export type NotificationDeliveryStatus = 'pending' | 'sent' | 'failed';

@Entity('notification_deliveries')
@Index(['notificationId'])
@Index(['deviceId'])
export class NotificationDelivery {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'notification_id' })
  notificationId!: string;

  @Column({ type: 'uuid', name: 'device_id' })
  deviceId!: string;

  @Column({ type: 'varchar', length: 24, default: 'pending' })
  status!: NotificationDeliveryStatus;

  @Column({ type: 'varchar', length: 255, nullable: true, name: 'ticket_id' })
  ticketId?: string;

  @Column({ type: 'varchar', length: 255, nullable: true, name: 'receipt_id' })
  receiptId?: string;

  @Column({ type: 'text', nullable: true })
  error?: string;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;
}
