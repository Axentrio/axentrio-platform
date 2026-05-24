import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
  OneToMany,
  Index,
} from 'typeorm';
import { Tenant } from './Tenant';
import { KnowledgeDocument } from './KnowledgeDocument';

@Entity('knowledge_bases')
// Exactly one tenant-primary (bot-less) KnowledgeBase per tenant; bot-dedicated
// KnowledgeBases (botId set) are unlimited. Replaces the former global unique.
@Index(['tenantId'], { unique: true, where: '"botId" IS NULL' })
export class KnowledgeBase {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index()
  @Column('uuid')
  tenantId!: string;

  /**
   * The Bot this KnowledgeBase is dedicated to. NULL = the tenant-primary KB
   * (legacy tenant-level knowledge). Set = a per-bot dedicated KB.
   */
  @Column('uuid', { nullable: true })
  botId!: string | null;

  @ManyToOne(() => Tenant)
  @JoinColumn({ name: 'tenantId' })
  tenant!: Tenant;

  @Column({
    type: 'enum',
    enum: ['active', 'inactive'],
    default: 'inactive',
  })
  status!: 'active' | 'inactive';

  @Column({ type: 'varchar', default: 'text-embedding-3-small' })
  embeddingModel!: string;

  @Column({ type: 'int', default: 1000 })
  chunkSize!: number;

  @Column({ type: 'int', default: 200 })
  chunkOverlap!: number;

  @Column({ type: 'timestamptz', nullable: true })
  lastIndexedAt!: Date | null;

  @OneToMany(() => KnowledgeDocument, (doc) => doc.knowledgeBase)
  documents!: KnowledgeDocument[];

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
