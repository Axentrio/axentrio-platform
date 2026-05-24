import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import { Tenant } from './Tenant';

@Entity('webhook_delivery_logs')
@Index(['tenantId', 'createdAt'])
export class WebhookDeliveryLog {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'tenant_id' })
  tenantId!: string;

  @ManyToOne(() => Tenant, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'tenant_id' })
  tenant!: Tenant;

  @Column({ type: 'varchar', length: 100 })
  event!: string;

  @Column({ type: 'enum', enum: ['inbound', 'outbound'] })
  direction!: 'inbound' | 'outbound';

  @Column({ type: 'varchar', length: 500 })
  url!: string;

  @Column({ type: 'enum', enum: ['success', 'failed', 'retrying', 'dropped'] })
  status!: 'success' | 'failed' | 'retrying' | 'dropped';

  @Column({ type: 'int', nullable: true, name: 'http_status' })
  httpStatus?: number;

  @Column({ type: 'int', name: 'duration_ms', default: 0 })
  durationMs!: number;

  @Column({ type: 'int', default: 1 })
  attempt!: number;

  @Column({ type: 'text', nullable: true })
  error?: string;

  @Column({ type: 'jsonb', nullable: true, name: 'request_body' })
  requestBody?: Record<string, unknown>;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;
}
