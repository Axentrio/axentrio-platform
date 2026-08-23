/**
 * StorageImportJob — one file in a cloud-import batch.
 *
 * Owns the S3 targetKey before bytes exist so a failed download cannot
 * orphan objects. The portal renders these rows until documentId is set.
 */
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

export type StorageImportJobStatus =
  | 'queued'
  | 'downloading'
  | 'scanning'
  | 'stored'
  | 'document_created'
  | 'failed';

@Entity('storage_import_jobs')
export class StorageImportJob {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index()
  @Column({ type: 'uuid', name: 'tenant_id' })
  tenantId!: string;

  @Column({ type: 'uuid', name: 'knowledge_base_id' })
  knowledgeBaseId!: string;

  @Column({ type: 'uuid', name: 'storage_connection_id' })
  storageConnectionId!: string;

  @Column({ type: 'varchar', length: 32 })
  provider!: string;

  @Column({ type: 'varchar', length: 320, name: 'file_id' })
  fileId!: string;

  @Column({ type: 'varchar', length: 1024, name: 'target_key' })
  targetKey!: string;

  @Column({ type: 'varchar', length: 32, default: 'queued' })
  status!: StorageImportJobStatus;

  @Column({ type: 'text', nullable: true })
  error!: string | null;

  @Column({ type: 'uuid', name: 'document_id', nullable: true })
  documentId!: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;
}
