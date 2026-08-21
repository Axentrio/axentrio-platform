import {
 Entity,
 PrimaryGeneratedColumn,
 Column,
 CreateDateColumn,
 ManyToOne,
 JoinColumn,
} from "typeorm";
import { Tenant } from "./Tenant";
import { KnowledgeDocument } from "./KnowledgeDocument";

@Entity("knowledge_chunks")
export class KnowledgeChunk {
 @PrimaryGeneratedColumn("uuid")
 id!: string;

 @Column("uuid")
 documentId!: string;

 @ManyToOne(() => KnowledgeDocument, { onDelete: "CASCADE" })
 @JoinColumn({ name: "documentId" })
 document!: KnowledgeDocument;

 @Column("uuid")
 tenantId!: string;

 @ManyToOne(() => Tenant)
 @JoinColumn({ name: "tenantId" })
 tenant!: Tenant;

 @Column({ type: "text" })
 content!: string;

 /** pgvector embedding. Written via raw SQL casts ($4::vector); declared
  *  here only so DB_SYNCHRONIZE keeps the column on fresh local databases.
  *  Production gets it from CreateKnowledgeTables. */
 @Column({ type: "vector", nullable: true })
 embedding!: string | null;

 /** Full-text search vector written by the same raw SQL inserts
  *  (to_tsvector). Same synchronize-only rationale as embedding. */
 @Column({ type: "tsvector", nullable: true })
 tsv!: string | null;

 @Column({ type: "int" })
 chunkIndex!: number;

 @Column({ type: "int" })
 charCount!: number;

 @Column({ type: "jsonb", default: {} })
 metadata!: Record<string, unknown>;

 @CreateDateColumn()
 createdAt!: Date;
}
