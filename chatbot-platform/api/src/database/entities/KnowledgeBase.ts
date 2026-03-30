import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
  OneToMany,
} from 'typeorm';
import { Tenant } from './Tenant';
import { KnowledgeDocument } from './KnowledgeDocument';

@Entity('knowledge_bases')
export class KnowledgeBase {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column('uuid', { unique: true })
  tenantId!: string;

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
