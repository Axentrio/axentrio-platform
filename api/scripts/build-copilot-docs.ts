/**
 * Build the Copilot docs bundle.
 *
 *   npx ts-node scripts/build-copilot-docs.ts
 *
 * Reads every `.md` file under `src/copilot/docs/` and writes
 * `dist/copilot/docs-bundle.json`, which the server hydrates into
 * `chatbot_copilot_docs` at boot.
 *
 * The parsing itself lives in `src/copilot/docs-source.ts` so that anything wanting to
 * ask a question about the corpus can read the SOURCE instead of this build artifact.
 * A test that reads `dist/` only passes where a build happens to have been run — which
 * is true locally and false in `api-test`, whose steps are npm ci, tsc and vitest.
 *
 * Front-matter format (minimal — flat keys plus a `tags` YAML list):
 *
 *     ---
 *     slug: getting-started
 *     title: Getting Started with Axentrio
 *     locale: en
 *     tags:
 *       - onboarding
 *       - basics
 *     ---
 *
 *     # body markdown ...
 *
 * The content hash spans the WHOLE file (front-matter + body) so a title rename or tag
 * edit still trips the hydration update path.
 *
 * Run automatically as part of `npm run build` after `tsc`. Server boot fails fast if
 * the bundle is missing.
 */
import { promises as fs } from 'fs';
import * as path from 'path';
import { loadDocsFromSource } from '../src/copilot/docs-source';

const OUT_PATH = path.join(__dirname, '..', 'dist', 'copilot', 'docs-bundle.json');

async function main(): Promise<void> {
  const entries = await loadDocsFromSource();

  await fs.mkdir(path.dirname(OUT_PATH), { recursive: true });
  await fs.writeFile(
    OUT_PATH,
    JSON.stringify({ generatedAt: new Date().toISOString(), schemaVersion: 1, entries }, null, 2) +
      '\n',
    'utf8',
  );

  // eslint-disable-next-line no-console
  console.log(
    `[build-copilot-docs] wrote ${entries.length} entries to ${path.relative(process.cwd(), OUT_PATH)}`,
  );
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[build-copilot-docs] FAILED:', err.message);
  process.exit(1);
});
