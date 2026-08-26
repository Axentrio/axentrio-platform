/**
 * Idempotent boot-time hydration of `chatbot_copilot_docs` from the
 * build-time bundle.
 *
 * Reads `dist/copilot/docs-bundle.json` (produced by
 * `scripts/build-copilot-docs.ts`) and upserts each entry by
 * `(slug, locale)`. The change-gate compares `content_hash`, `title`,
 * and `tags` — if any differ, the row updates and `updated_at` advances.
 * Otherwise the row is left untouched (no spurious timestamp churn).
 *
 * Called once from `server.ts` after `AppDataSource.initialize()` and
 * any pending migrations, before the HTTP listener starts. Failures
 * throw — Copilot cannot serve without its corpus.
 */
import { promises as fs } from 'fs';
import * as path from 'path';
import { DataSource, EntityManager } from 'typeorm';
import { logger } from '../utils/logger';

const BUNDLE_PATH = path.join(__dirname, '..', '..', 'dist', 'copilot', 'docs-bundle.json');

const ALLOWED_LOCALES = ['en', 'nl', 'fr'] as const;
type Locale = (typeof ALLOWED_LOCALES)[number];

interface BundleEntry {
  slug: string;
  locale: Locale;
  title: string;
  body: string;
  tags: string[];
  contentHash: string;
}

interface Bundle {
  generatedAt: string;
  schemaVersion: number;
  entries: BundleEntry[];
}

export interface HydrationResult {
  inserted: number;
  updated: number;
  unchanged: number;
  pruned: number;
  total: number;
}

async function readBundle(): Promise<Bundle> {
  let raw: string;
  try {
    raw = await fs.readFile(BUNDLE_PATH, 'utf8');
  } catch (err: any) {
    if (err.code === 'ENOENT') {
      throw new Error(
        `Copilot docs bundle not found at ${BUNDLE_PATH}. Run 'npm run build' (which runs build-copilot-docs after tsc) before starting the server.`,
      );
    }
    throw err;
  }
  const parsed = JSON.parse(raw) as Bundle;
  if (parsed.schemaVersion !== 1) {
    throw new Error(
      `Copilot bundle schemaVersion=${parsed.schemaVersion} unsupported; this server expects schemaVersion=1. Rebuild the bundle.`,
    );
  }
  if (!Array.isArray(parsed.entries) || parsed.entries.length === 0) {
    throw new Error('Copilot bundle has no entries; refusing to hydrate an empty corpus.');
  }
  return parsed;
}

/**
 * Delete corpus rows whose (slug, locale) is not in `kept`, and return what was
 * removed. Exported so the prune can be tested without building the bundle.
 *
 * An EMPTY keep-set removes NOTHING. The corpus is only ever pruned against a
 * real bundle (readBundle refuses an empty one), and "keep nothing" is almost
 * always a caller bug, not an intent to wipe every doc — so we fail safe.
 */
export async function pruneRemovedDocs(
  manager: EntityManager,
  kept: ReadonlyArray<{ slug: string; locale: string }>,
): Promise<Array<{ slug: string; locale: string }>> {
  if (kept.length === 0) return [];
  const slugs = kept.map((e) => e.slug);
  const locales = kept.map((e) => e.locale);
  const result = await manager.query(
    `DELETE FROM chatbot_copilot_docs d
      WHERE NOT EXISTS (
        SELECT 1 FROM unnest($1::text[], $2::text[]) AS b(slug, locale)
        WHERE b.slug = d.slug AND b.locale = d.locale
      )
      RETURNING d.slug, d.locale`,
    [slugs, locales],
  );
  // TypeORM's query() returns [rows, affectedCount] for DELETE ... RETURNING
  // (but bare rows for SELECT/INSERT). Normalize to just the rows.
  const rows: Array<{ slug: string; locale: string }> = Array.isArray(result[0])
    ? result[0]
    : result;
  return rows;
}

export async function hydrateCopilotDocs(dataSource: DataSource): Promise<HydrationResult> {
  const bundle = await readBundle();
  const start = Date.now();

  let inserted = 0;
  let updated = 0;
  let unchanged = 0;
  let pruned = 0;

  await dataSource.transaction(async (manager) => {
    for (const entry of bundle.entries) {
      // Upsert via ON CONFLICT. The change-gate in WHERE skips no-op
      // UPDATEs entirely. `updated_at = now()` is set only on the
      // UPDATE branch — INSERTs use the column default.
      const result: Array<{ id: string; action: 'inserted' | 'updated' }> = await manager.query(
        `
        INSERT INTO chatbot_copilot_docs (slug, locale, title, body, tags, content_hash)
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (slug, locale) DO UPDATE
          SET title = EXCLUDED.title,
              body = EXCLUDED.body,
              tags = EXCLUDED.tags,
              content_hash = EXCLUDED.content_hash,
              updated_at = now()
          WHERE chatbot_copilot_docs.content_hash IS DISTINCT FROM EXCLUDED.content_hash
             OR chatbot_copilot_docs.title IS DISTINCT FROM EXCLUDED.title
             OR chatbot_copilot_docs.tags IS DISTINCT FROM EXCLUDED.tags
        RETURNING id, (xmax = 0) AS inserted
        `,
        [entry.slug, entry.locale, entry.title, entry.body, entry.tags, entry.contentHash],
      ).then((rows: Array<{ id: string; inserted: boolean }>) =>
        rows.map((r) => ({ id: r.id, action: r.inserted ? 'inserted' as const : 'updated' as const })),
      );

      if (result.length === 0) {
        // ON CONFLICT matched but the WHERE rejected the update — row unchanged.
        unchanged++;
      } else if (result[0].action === 'inserted') {
        inserted++;
      } else {
        updated++;
      }
    }

    // Remove rows whose (slug, locale) is no longer in the bundle — a doc
    // deleted, or a slug renamed, at build time. Runs in the SAME transaction as
    // the upserts so the corpus never has a torn state; readBundle already
    // refused an empty bundle above, so this cannot wipe it.
    const removed = await pruneRemovedDocs(manager, bundle.entries);
    pruned = removed.length;
    if (pruned > 0) {
      logger.info('Copilot docs pruned (no longer in the bundle)', {
        pruned,
        removed: removed.map((r) => `${r.slug}/${r.locale}`),
      });
    }
  });

  const total = inserted + updated + unchanged;
  logger.info('Copilot docs hydrated', {
    inserted,
    updated,
    unchanged,
    pruned,
    total,
    bundleGeneratedAt: bundle.generatedAt,
    durationMs: Date.now() - start,
  });

  return { inserted, updated, unchanged, pruned, total };
}
