/**
* StorageConnection — a tenant's connected cloud drive (Google Drive / OneDrive).
*
* Tenant-scoped, not per-KB. knowledgeBaseId is chosen at import time.
* Tokens are encrypted at rest. Unique per (tenant, provider, providerAccountId).
*/
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from "typeorm";

export type StorageProvider = "google_drive" | "onedrive";
export type StorageConnectionStatus = "active" | "revoked";

@Index(["tenantId", "provider", "providerAccountId"], { unique: true })
@Entity("knowledge_storage_connections")
export class StorageConnection {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "uuid", name: "tenant_id" })
  tenantId!: string;

  @Column({ type: "varchar", length: 32 })
  provider!: StorageProvider;

  @Column({ type: "varchar", length: 320, name: "provider_account_id" })
  providerAccountId!: string;

  @Column({
  type: "varchar",
  length: 320,
  name: "account_email",
  nullable: true,
})
accountEmail!: string | null;

@Column({ type: "varchar", length: 16, default: "active" })
status!: StorageConnectionStatus;

@Column({ type: "boolean", name: "reauth_required", default: false })
reauthRequired!: boolean;

@Column({ type: "text", name: "access_token_enc" })
accessTokenEnc!: string;

@Column({ type: "text", name: "refresh_token_enc", nullable: true })
refreshTokenEnc!: string | null;

@Column({ type: "timestamptz", name: "token_expiry", nullable: true })
tokenExpiry!: Date | null;

@Column({ type: "uuid", name: "connected_by_user_id" })
connectedByUserId!: string;

@CreateDateColumn({ name: "created_at" })
createdAt!: Date;

@UpdateDateColumn({ name: "updated_at" })
updatedAt!: Date;
}

