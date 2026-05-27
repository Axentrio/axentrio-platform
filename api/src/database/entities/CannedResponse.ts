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
import { User } from './User';

export type CannedResponseScope = 'shared' | 'personal';

@Entity('canned_responses')
@Index(['tenantId', 'isActive'])
@Index(['tenantId', 'scope'])
export class CannedResponse {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  tenantId!: string;

  @Column({ type: 'uuid', nullable: true })
  createdByUserId?: string;

  @Column({ type: 'varchar', length: 100 })
  title!: string;

  @Column({ type: 'varchar', length: 20 })
  shortcut!: string;

  @Column({ type: 'text' })
  content!: string;

  @Column({ type: 'varchar', length: 50, nullable: true })
  category?: string;

  @Column({ type: 'varchar', length: 50, array: true, default: [] })
  tags!: string[];

  @Column({ type: 'varchar', length: 10, default: 'personal' })
  scope!: CannedResponseScope;

  @Column({ type: 'int', default: 0 })
  usageCount!: number;

  @Column({ type: 'boolean', default: true })
  isActive!: boolean;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;

  @ManyToOne(() => Tenant, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'tenantId' })
  tenant!: Tenant;

  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'createdByUserId' })
  createdBy?: User;
}
