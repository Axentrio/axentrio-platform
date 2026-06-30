/**
 * ModuleVersion — one immutable-once-published version of a Module's authored
 * prose (composable-templates Phase 4). Mirrors BotTemplateVersion's lifecycle:
 * `draft` (editable) → `published` (frozen) → `unpublished` (frozen, withdrawn).
 * A template pins a specific (moduleId, version) at publish time, so editing a
 * module later never mutates a live template.
 *
 * The prose is workflow intent + wording only — never tool-availability claims
 * (enforced by validateModuleProse at the authoring layer).
 */
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
  ManyToOne,
  JoinColumn,
} from 'typeorm';
import { Module } from './Module';

export type ModuleVersionStatus = 'draft' | 'published' | 'unpublished';

@Entity('module_versions')
@Index('ux_module_versions_module_version', ['moduleId', 'version'], { unique: true })
export class ModuleVersion {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'module_id' })
  moduleId!: string;

  /** FK to the parent module (ON DELETE CASCADE). Declared so test-synchronize
   *  creates the same constraint the migration does (test/prod parity). */
  @ManyToOne(() => Module, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'module_id' })
  module!: Module;

  /** Monotonic per module; allocated transactionally on draft create. */
  @Column({ type: 'int' })
  version!: number;

  /** The authored prose (workflow intent + wording; no tool claims). */
  @Column({ type: 'text', default: '' })
  prose!: string;

  @Column({ type: 'varchar', length: 20, default: 'draft' })
  status!: ModuleVersionStatus;

  @Column({ type: 'timestamptz', nullable: true, name: 'published_at' })
  publishedAt?: Date | null;

  @Column({ type: 'varchar', length: 255, nullable: true, name: 'published_by' })
  publishedBy?: string | null;

  /** Optimistic-concurrency token for draft edits. */
  @Column({ type: 'int', default: 0, name: 'lock_version' })
  lockVersion!: number;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updatedAt!: Date;
}
