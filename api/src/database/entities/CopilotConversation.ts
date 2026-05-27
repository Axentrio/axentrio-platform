/**
 * CopilotConversation — one persistent thread between a tenant admin and
 * the Copilot, per (tenant_id, user_id).
 *
 * `next_turn` is a monotonic counter incremented inside the atomic-pair
 * insert tx (SELECT ... FOR UPDATE on this row reserves two consecutive
 * turn numbers for the paired user + assistant rows).
 *
 * Soft-deleted via `archived_at`. Only ONE active conversation per
 * (tenant_id, user_id) at a time — enforced by a partial unique INDEX
 * in the migration (constraints can't carry WHERE clauses, so it must
 * be an index, and ON CONFLICT must reference columns + WHERE rather
 * than the index name).
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
import { Tenant } from './Tenant';
import { User } from './User';

@Entity('chatbot_copilot_conversations')
// Partial unique index — only ONE active (archived_at IS NULL) row per
// (tenant_id, user_id). Mirrors the migration; declared here so the
// synchronize-built test schema gets it too. ON CONFLICT against this
// index requires the same WHERE clause (not the index name).
@Index('uq_chatbot_copilot_conv_active', ['tenantId', 'userId'], {
  unique: true,
  where: '"archived_at" IS NULL',
})
export class CopilotConversation {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'tenant_id' })
  tenantId!: string;

  @Column({ type: 'uuid', name: 'user_id' })
  userId!: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  title?: string | null;

  @Column({ type: 'int', name: 'next_turn', default: 0 })
  nextTurn!: number;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;

  @Column({ type: 'timestamptz', name: 'archived_at', nullable: true })
  archivedAt?: Date | null;

  @ManyToOne(() => Tenant, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'tenant_id' })
  tenant?: Tenant;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user?: User;
}
