/**
 * BotKnowledgeBase Entity
 * Join table attaching KnowledgeBases to Bots (many-to-many). A Bot retrieves
 * from all attached KnowledgeBases. KnowledgeBases stay tenant-owned and may be
 * shared across a tenant's Bots.
 *
 * Phase 1: simple FKs + a denormalised `tenant_id`. The composite-FK tenant
 * guard and relaxing the one-KB-per-tenant unique constraint are Phase 3 work
 * (they're entangled with multi-KB support).
 */

import {
  Entity,
  Column,
  PrimaryColumn,
  ManyToOne,
  JoinColumn,
  CreateDateColumn,
  Index,
} from 'typeorm';
import { Bot } from './Bot';
import { KnowledgeBase } from './KnowledgeBase';

@Entity('chatbot_bot_knowledge_bases')
@Index(['knowledgeBaseId'])
export class BotKnowledgeBase {
  @PrimaryColumn({ type: 'uuid', name: 'bot_id' })
  botId!: string;

  @PrimaryColumn({ type: 'uuid', name: 'knowledge_base_id' })
  knowledgeBaseId!: string;

  @Column({ type: 'uuid', name: 'tenant_id' })
  tenantId!: string;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @ManyToOne(() => Bot, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'bot_id' })
  bot!: Bot;

  @ManyToOne(() => KnowledgeBase, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'knowledge_base_id' })
  knowledgeBase!: KnowledgeBase;
}
