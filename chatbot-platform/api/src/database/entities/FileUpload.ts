/**
 * File Upload Entity
 * Represents file uploads with chunked upload support
 */

import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

export type FileUploadStatus = 'pending' | 'uploading' | 'completed' | 'failed' | 'cancelled';

@Entity('file_uploads')
@Index(['sessionId', 'status'])
@Index(['tenantId', 'createdAt'])
export class FileUpload {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'session_id' })
  sessionId!: string;

  @Column({ type: 'uuid', name: 'tenant_id' })
  tenantId!: string;

  @Column({ type: 'uuid', name: 'participant_id' })
  participantId!: string;

  @Column({ type: 'varchar', length: 255, name: 'file_name' })
  fileName!: string;

  @Column({ type: 'varchar', length: 100, name: 'file_type' })
  fileType!: string;

  @Column({ type: 'bigint', name: 'file_size' })
  fileSize!: number;

  @Column({ type: 'int', name: 'chunk_size' })
  chunkSize!: number;

  @Column({ type: 'int', name: 'total_chunks' })
  totalChunks!: number;

  @Column({ type: 'int', array: true, default: [], name: 'uploaded_chunks' })
  uploadedChunks!: number[];

  @Column({
    type: 'enum',
    enum: ['pending', 'uploading', 'completed', 'failed', 'cancelled'],
    default: 'pending',
  })
  status!: FileUploadStatus;

  @Column({ type: 'varchar', length: 500, nullable: true, name: 'storage_path' })
  storagePath?: string;

  @Column({ type: 'varchar', length: 500, nullable: true, name: 'public_url' })
  publicUrl?: string;

  @Column({ type: 'varchar', length: 64, nullable: true, name: 'checksum' })
  checksum?: string;

  @Column({ type: 'varchar', length: 64, nullable: true, name: 'checksum_algorithm' })
  checksumAlgorithm?: string;

  @Column({ type: 'jsonb', nullable: true })
  metadata!: {
    originalName?: string;
    mimeType?: string;
    encoding?: string;
    width?: number;
    height?: number;
    duration?: number;
    thumbnails?: Array<{
      size: string;
      url: string;
      width: number;
      height: number;
    }>;
    processingInfo?: {
      status: string;
      progress: number;
      error?: string;
    };
    customData?: Record<string, unknown>;
  };

  @Column({ type: 'int', default: 0, name: 'retry_count' })
  retryCount!: number;

  @Column({ type: 'varchar', length: 500, nullable: true, name: 'error_message' })
  errorMessage?: string;

  @Column({ type: 'timestamptz', nullable: true, name: 'expires_at' })
  expiresAt?: Date;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;

  @Column({ type: 'timestamptz', nullable: true, name: 'completed_at' })
  completedAt?: Date;

  // Helper methods
  isComplete(): boolean {
    return this.uploadedChunks.length === this.totalChunks;
  }

  getProgress(): number {
    return Math.round((this.uploadedChunks.length / this.totalChunks) * 100);
  }

  addChunk(chunkIndex: number): void {
    if (!this.uploadedChunks.includes(chunkIndex)) {
      this.uploadedChunks.push(chunkIndex);
    }
    this.status = 'uploading';
  }

  hasChunk(chunkIndex: number): boolean {
    return this.uploadedChunks.includes(chunkIndex);
  }

  getMissingChunks(): number[] {
    const missing: number[] = [];
    for (let i = 0; i < this.totalChunks; i++) {
      if (!this.uploadedChunks.includes(i)) {
        missing.push(i);
      }
    }
    return missing;
  }

  complete(storagePath: string, publicUrl: string): void {
    this.status = 'completed';
    this.storagePath = storagePath;
    this.publicUrl = publicUrl;
    this.completedAt = new Date();
  }

  fail(errorMessage: string): void {
    this.status = 'failed';
    this.errorMessage = errorMessage;
  }

  cancel(): void {
    this.status = 'cancelled';
  }

  isImage(): boolean {
    return this.fileType.startsWith('image/');
  }

  isVideo(): boolean {
    return this.fileType.startsWith('video/');
  }

  isAudio(): boolean {
    return this.fileType.startsWith('audio/');
  }

  getFileExtension(): string {
    return this.fileName.split('.').pop()?.toLowerCase() || '';
  }

  isExpired(): boolean {
    if (!this.expiresAt) return false;
    return new Date() > this.expiresAt;
  }
}
