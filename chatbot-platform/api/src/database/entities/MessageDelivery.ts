import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';
import { ChannelType } from './ChannelConnection';

@Entity('message_deliveries')
@Index(['internalMessageId'])
@Index(['platformMessageId', 'channel'])
@Index(['channelConnectionId', 'status'])
export class MessageDelivery {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column('uuid')
  internalMessageId!: string;

  @Column('uuid')
  channelConnectionId!: string;

  @Column({ type: 'varchar', length: 20 })
  channel!: ChannelType;

  @Column({ type: 'varchar', length: 255, nullable: true })
  platformMessageId!: string | null;

  @Column({ type: 'varchar', length: 20, default: 'pending' })
  status!: 'pending' | 'sent' | 'delivered' | 'read' | 'failed';

  @Column({ type: 'integer', default: 0 })
  attempts!: number;

  @Column({ type: 'varchar', length: 500, nullable: true })
  error!: string | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
