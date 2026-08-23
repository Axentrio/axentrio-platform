import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from "typeorm";
import { Tenant } from "./Tenant";
import { KnowledgeBase } from "./KnowledgeBase";

export type DocumentType = "text" | "faq" | "pdf" | "docx" | "url";
export type DocumentStatus = "pending" | "processing" | "indexed" | "failed";

@Entity("knowledge_documents")
@Index(["knowledgeBaseId", "storageProvider", "storageFileId"], {
  unique: true,
  where: '"storageProvider" IS NOT NULL AND "storageFileId" IS NOT NULL',
})
export class KnowledgeDocument {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column("uuid")
  knowledgeBaseId!: string;

  @ManyToOne(
    () => KnowledgeBase,
    (kb) => kb.documents,
  )
  @JoinColumn({ name: "knowledgeBaseId" })
  knowledgeBase!: KnowledgeBase;

  @Column("uuid")
  tenantId!: string;

  @ManyToOne(() => Tenant)
  @JoinColumn({ name: "tenantId" })
  tenant!: Tenant;

  @Column({
    type: "enum",
    enum: ["text", "faq", "pdf", "docx", "url"],
  })
  type!: DocumentType;

  @Column({ type: "varchar" })
  title!: string;

  /** Canonical page URL for type `url`. Unique per KnowledgeBase when set. */
  @Column({ type: "varchar", nullable: true })
  sourceUrl!: string | null;

  @Column({ type: "text", nullable: true })
  sourceContent!: string | null;

  @Column({ type: "varchar", nullable: true })
  storagePath!: string | null;

  /** Cloud-import provenance. Unique with storageFileId per KnowledgeBase when set. */
  @Column({ type: "varchar", nullable: true })
  storageProvider!: string | null;

  @Column({ type: "varchar", nullable: true })
  storageFileId!: string | null;

  @Column({
    type: "enum",
    enum: ["pending", "processing", "indexed", "failed"],
    default: "pending",
  })
  status!: DocumentStatus;

  @Column({ type: "int", default: 1 })
  processingVersion!: number;

  @Column({ type: "varchar", nullable: true })
  errorMessage!: string | null;

  @Column({ type: "int", default: 0 })
  chunkCount!: number;

  @Column({ type: "jsonb", default: {} })
  metadata!: Record<string, unknown>;

  @Column({ type: "jsonb", nullable: true, default: null })
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
