/**
 * UploadSession Entity
 *
 * Persistent storage for the upload-session metadata that `upload.service.ts`
 * previously held in an in-memory Map (`uploadSessions`). The Map worked in
 * dev / single-replica but breaks in production on Railway when:
 *   - The two halves of an upload (presigned-URL request + scan-complete
 *     callback) land on different replicas, or
 *   - A deploy / restart happens between the two halves.
 *
 * See `chatbot-platform/docs/widget-file-upload-status.md` for the broader
 * context (this is the PR-Persistence in the four-PR sequence) and codex
 * round PR1 #2 / widget-design #5 for the original bug report.
 *
 * Scope note vs the existing `FileUpload` entity:
 *   - `FileUpload` was designed for tracking CHUNKED uploads (different
 *     status enum: 'pending' / 'uploading' / 'completed' / 'failed' /
 *     'cancelled') and is currently registered but not used.
 *   - `UploadSession` (this entity) backs the simple-upload + scan-pipeline
 *     flow with status 'pending' / 'uploading' / 'scanning' / 'ready' /
 *     'failed' / 'quarantined'.
 *   - Both can coexist; this is intentionally additive.
 *
 * The primary key is the service-generated UUID (`session_id`) — that's the
 * same identifier callers pass to `/files/:sessionId/upload-complete`, so
 * using it as PK lets the route do a single indexed lookup.
 */

import {
  Entity,
  PrimaryColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

export type UploadSessionStatus =
  | 'pending'
  | 'uploading'
  | 'scanning'
  | 'ready'
  | 'failed'
  | 'quarantined';

export interface UploadSessionScanResult {
  clean: boolean;
  threats?: string[];
  scannedAt: string; // ISO string in JSONB
  scanDurationMs?: number;
  scanMethod?: string;
  fileKey?: string;
}

@Entity('upload_sessions')
@Index(['tenantId', 'createdAt'])
@Index(['chatSessionId'])
@Index(['fileKey'])
@Index(['status', 'expiresAt']) // for cleanupExpiredSessions sweep
export class UploadSession {
  // Primary key is the service-generated `sessionId` UUID. Routes look up
  // sessions by this exact value (PK lookup) so no additional indexes
  // needed for that path.
  @PrimaryColumn({ type: 'uuid', name: 'session_id' })
  sessionId!: string;

  @Column({ type: 'uuid', name: 'tenant_id' })
  tenantId!: string;

  // Chat session this upload is associated with. Required for the widget's
  // tenant + chat-session scoping check on /upload-complete.
  @Column({ type: 'uuid', name: 'chat_session_id' })
  chatSessionId!: string;

  // Varchar (not uuid) because widget visitors have IDs like "widget-abc123"
  // (see widget.js:1493). Portal users have UUID strings; both fit in 255.
  @Column({ type: 'varchar', length: 255, name: 'user_id' })
  userId!: string;

  // S3 key (path like "uploads/<tenant>/<yyyy>/<mm>/<dd>/<hash>.<ext>").
  // Long enough for nested paths plus reasonable filename roots.
  @Column({ type: 'varchar', length: 500, name: 'file_key' })
  fileKey!: string;

  @Column({ type: 'varchar', length: 64, name: 'file_hash' })
  fileHash!: string;

  @Column({ type: 'varchar', length: 255, name: 'original_name' })
  originalName!: string;

  @Column({ type: 'bigint', name: 'file_size' })
  fileSize!: number;

  @Column({ type: 'varchar', length: 100, name: 'mime_type' })
  mimeType!: string;

  // Presigned upload URL. S3 presigned URLs can be quite long; 2000 char
  // ceiling matches common HTTP body limits.
  @Column({ type: 'varchar', length: 2000, name: 'upload_url' })
  uploadUrl!: string;

  @Column({ type: 'varchar', length: 2000, name: 'public_url' })
  publicUrl!: string;

  @Column({
    type: 'enum',
    enum: ['pending', 'uploading', 'scanning', 'ready', 'failed', 'quarantined'],
    default: 'pending',
  })
  status!: UploadSessionStatus;

  @Column({ type: 'jsonb', nullable: true, name: 'scan_result' })
  scanResult?: UploadSessionScanResult;

  @Column({ type: 'varchar', length: 2000, nullable: true, name: 'thumbnail_url' })
  thumbnailUrl?: string;

  @Column({ type: 'timestamptz', name: 'expires_at' })
  expiresAt!: Date;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;
}
