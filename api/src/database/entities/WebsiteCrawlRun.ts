import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from "typeorm";

/**
 * One row per origin the crawler last ran against.
 * Exists even when no page was stored, so a refused origin is visible.
 */
@Entity("website_crawl_runs")
@Index(["tenantId", "knowledgeBaseId", "origin"], { unique: true })
export class WebsiteCrawlRun {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column("uuid")
  tenantId!: string;

  @Column("uuid")
  knowledgeBaseId!: string;

  @Column({ type: "varchar", length: 2048 })
  origin!: string;

  @Column({ type: "int", default: 0 })
  skippedByRules!: number;

  @Column({ type: "boolean", default: false })
  rulesUnreachable!: boolean;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
