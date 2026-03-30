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

export type ChannelType = 'widget' | 'telegram' | 'messenger' | 'instagram' | 'whatsapp';

export type ChannelConnectionStatus = 'active' | 'disconnected' | 'error' | 'pending_setup';

@Entity('channel_connections')
@Index(['tenantId', 'channel'], { unique: false })
@Index(['tenantId', 'channel', 'status'])
export class ChannelConnection {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column('uuid')
  tenantId!: string;

  @Column({ type: 'varchar', length: 20 })
  channel!: ChannelType;

  @Column({ type: 'varchar', length: 20, default: 'pending_setup' })
  status!: ChannelConnectionStatus;

  @Column({ type: 'varchar', length: 255, nullable: true })
  label!: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  platformAccountId!: string | null;

  @Column({ type: 'jsonb', default: '{}' })
  credentials!: Record<string, unknown>;

  @Column({ type: 'varchar', length: 255, nullable: true })
  webhookVerifyToken!: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  webhookSecret!: string | null;

  @Column({ type: 'jsonb', default: '{}' })
  config!: Record<string, unknown>;

  @Column({ type: 'simple-array', nullable: true })
  scopes!: string[] | null;

  @Column({ type: 'timestamptz', nullable: true })
  lastHealthCheckAt!: Date | null;

  @Column({ type: 'varchar', length: 500, nullable: true })
  lastError!: string | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;

  @ManyToOne(() => Tenant)
  @JoinColumn({ name: 'tenantId' })
  tenant!: Tenant;

  isActive(): boolean {
    return this.status === 'active';
  }
}
