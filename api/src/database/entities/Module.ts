/**
 * Module — a super-admin-authored, reusable business-intent package: prose that
 * binds 1..N engineered skills (composable-templates Phase 4). The catalog row;
 * its editable prose lives in immutable ModuleVersion rows (mirrors BotTemplate /
 * BotTemplateVersion). v1 binds exactly one skill.
 *
 * Distinct from the engineered "module"/skill (code, module-catalog.ts): a Module
 * carries no tools and makes no capability claims — only workflow wording.
 */
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity('modules')
export class Module {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 200 })
  name!: string;

  @Column({ type: 'varchar', length: 500, nullable: true })
  description?: string | null;

  /** Engineered skill ids this module binds (v1: exactly 1). */
  @Column({ type: 'jsonb', default: [], name: 'skill_ids' })
  skillIds!: string[];

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updatedAt!: Date;
}
