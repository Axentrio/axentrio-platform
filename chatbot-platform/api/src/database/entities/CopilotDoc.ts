/**
 * CopilotDoc — one entry in the Copilot's FAQ-grounded retrieval corpus.
 *
 * Sourced from engineering-authored markdown in `src/copilot/docs/`,
 * compiled at build time into `dist/copilot/docs-bundle.json`, then
 * hydrated into this table at server boot. One row per `(slug, locale)`.
 *
 * `content_hash` is sha256 over the entire raw `.md` file bytes
 * (front-matter + body, LF-normalized) — front-matter-only edits
 * therefore trigger the hydration update path.
 *
 * v1 retrieval uses pg_trgm against `title || ' ' || body`. The vector
 * embeddings table arrives in a later migration.
 */
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

export type CopilotLocale = 'en' | 'nl' | 'fr';

@Entity('chatbot_copilot_docs')
@Index(['slug', 'locale'], { unique: true })
export class CopilotDoc {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 128 })
  slug!: string;

  @Column({ type: 'varchar', length: 8 })
  locale!: CopilotLocale;

  @Column({ type: 'varchar', length: 255 })
  title!: string;

  @Column({ type: 'text' })
  body!: string;

  @Column({ type: 'text', array: true, default: () => "'{}'" })
  tags!: string[];

  @Column({ type: 'varchar', length: 64, name: 'content_hash' })
  contentHash!: string;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;
}
