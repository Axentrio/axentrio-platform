import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
} from 'typeorm';
import { Tenant } from './Tenant';
import { KnowledgeBase } from './KnowledgeBase';

export type DocumentType = 'text' | 'faq' | 'pdf' | 'docx';
export type DocumentStatus = 'pending' | 'processing' | 'indexed' | 'failed';

@Entity('knowledge_documents')
export class KnowledgeDocument {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column('uuid')
  knowledgeBaseId!: string;

  @ManyToOne(() => KnowledgeBase, (kb) => kb.documents)
  @JoinColumn({ name: 'knowledgeBaseId' })
  knowledgeBase!: KnowledgeBase;

  @Column('uuid')
  tenantId!: string;

  @ManyToOne(() => Tenant)
  @JoinColumn({ name: 'tenantId' })
  tenant!: Tenant;

  @Column({
    type: 'enum',
    enum: ['text', 'faq', 'pdf', 'docx'],
  })
  type!: DocumentType;

  @Column({ type: 'varchar' })
  title!: string;

  @Column({ type: 'text', nullable: true })
  sourceContent!: string | null;

  @Column({ type: 'varchar', nullable: true })
  storagePath!: string | null;

  @Column({
    type: 'enum',
    enum: ['pending', 'processing', 'indexed', 'failed'],
    default: 'pending',
  })
  status!: DocumentStatus;

  @Column({ type: 'int', default: 1 })
  processingVersion!: number;

  @Column({ type: 'varchar', nullable: true })
  errorMessage!: string | null;

  @Column({ type: 'int', default: 0 })
  chunkCount!: number;

  @Column({ type: 'jsonb', default: {} })
  metadata!: Record<string, any>;

  @Column({ type: 'jsonb', nullable: true, default: null })
  qualityReport!: {
    contentType: string;
    contentSummary: string;
    originalCharCount: number;
    processedCharCount: number;
    strippedCharCount: number;
    transformedSections: number;
    passthroughSections: number;
    strippedSections: number;
    qualityScore: string;
    qualityReason: string;
    chunksCreated: number;
    estimatedTokenCost: number;
  } | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
