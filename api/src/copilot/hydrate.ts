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
import { DataSource } from 'typeorm';
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

export async function hydrateCopilotDocs(dataSource: DataSource): Promise<HydrationResult> {
  const bundle = await readBundle();
  const start = Date.now();

  let inserted = 0;
  let updated = 0;
  let unchanged = 0;

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
  });

  const total = inserted + updated + unchanged;
  logger.info('Copilot docs hydrated', {
    inserted,
    updated,
    unchanged,
    total,
    bundleGeneratedAt: bundle.generatedAt,
    durationMs: Date.now() - start,
  });

  return { inserted, updated, unchanged, total };
}
