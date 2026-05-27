import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from 'typeorm';
import { ChannelType } from './ChannelConnection';

@Entity('webhook_event_log')
@Index(['dedupeKey'], { unique: true })
@Index(['channelConnectionId', 'createdAt'])
@Index(['status', 'createdAt'])
export class WebhookEventLog {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column('uuid')
  channelConnectionId!: string;

  @Column({ type: 'varchar', length: 20 })
  channel!: ChannelType;

  @Column({ type: 'varchar', length: 255 })
  dedupeKey!: string;

  @Column({ type: 'varchar', length: 50 })
  eventType!: string;

  @Column({ type: 'jsonb' })
  rawPayload!: Record<string, unknown>;

  @Column({ type: 'varchar', length: 20, default: 'received' })
  status!: 'received' | 'processing' | 'processed' | 'failed' | 'skipped';

  @Column({ type: 'varchar', length: 500, nullable: true })
  error!: string | null;

  @Column({ type: 'integer', default: 0 })
  processingAttempts!: number;

  @CreateDateColumn()
  createdAt!: Date;
}
