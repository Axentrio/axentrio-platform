/**
 * SentimentTheme — per-Tenant registry of recurring praise/complaint themes
 * (P3 / ADR-0014, D5). Deliberately SEPARATE from the Gap canonical-topic
 * registry: Gap topics are customer-question identities that drive Gap
 * lifecycle aggregation; conflating sentiment themes into them would pollute
 * that. Same merge-or-create + validation guardrails (ADR-0009), own table.
 */
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
  Unique,
} from 'typeorm';

export type SentimentPolarity = 'positive' | 'negative' | 'neutral';

@Entity('chatbot_sentiment_themes')
@Unique(['tenantId', 'theme'])
@Index(['tenantId'])
export class SentimentTheme {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'tenant_id' })
  tenantId!: string;

  @Column({ type: 'varchar', length: 200 })
  theme!: string;

  @Column({ type: 'varchar', length: 8 })
  polarity!: SentimentPolarity;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;
}
