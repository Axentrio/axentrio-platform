/**
 * Build the Copilot docs bundle.
 *
 *   npx ts-node scripts/build-copilot-docs.ts
 *
 * Reads every `.md` file under `src/copilot/docs/`, parses front-matter,
 * computes sha256 over the entire file bytes (LF-normalized so CRLF
 * editors don't churn the hash), and writes
 * `dist/copilot/docs-bundle.json`.
 *
 * The hash spans the WHOLE file (front-matter + body) so a title rename
 * or tag edit still trips the hydration update path.
 *
 * Front-matter format (minimal — no nested YAML, just flat keys + a
 * `tags` array as a YAML list):
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
 * Run automatically as part of `npm run build` after `tsc`. Server boot
 * fails fast if the bundle is missing.
 */
import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import * as path from 'path';

const DOCS_DIR = path.join(__dirname, '..', 'src', 'copilot', 'docs');
const OUT_PATH = path.join(__dirname, '..', 'dist', 'copilot', 'docs-bundle.json');

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

interface FrontMatter {
  slug: string;
  title: string;
  locale: Locale;
  tags: string[];
}

/**
 * Parse the YAML-ish front-matter at the top of a markdown file.
 * Supports flat `key: value` pairs and a `tags:` array of `- item` lines.
 * Anything more complex (nested objects, multi-line strings) is
 * intentionally unsupported — Copilot docs front-matter stays flat.
 */
function parseFrontMatter(raw: string, file: string): { fm: FrontMatter; body: string } {
  if (!raw.startsWith('---\n')) {
    throw new Error(`[${file}] missing opening '---' front-matter delimiter`);
  }
  const end = raw.indexOf('\n---\n', 4);
  if (end === -1) {
    throw new Error(`[${file}] missing closing '---' front-matter delimiter`);
  }
  const fmBlock = raw.slice(4, end);
  const body = raw.slice(end + 5);

  const lines = fmBlock.split('\n');
  const obj: Record<string, string | string[]> = {};
  let currentArrayKey: string | null = null;

  for (const line of lines) {
    if (line.trim() === '') {
      currentArrayKey = null;
      continue;
    }
    // List item under the current array key (e.g. `  - basics`)
    const listMatch = /^\s*-\s+(.+)$/.exec(line);
    if (listMatch && currentArrayKey) {
      (obj[currentArrayKey] as string[]).push(listMatch[1].trim());
      continue;
    }
    // Key: value, or Key: (array follows)
    const kvMatch = /^([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*(.*)$/.exec(line);
    if (!kvMatch) {
      throw new Error(`[${file}] unparseable front-matter line: ${JSON.stringify(line)}`);
    }
    const key = kvMatch[1];
    const value = kvMatch[2];
    if (value === '') {
      // Array-valued key — following lines are `- item`
      obj[key] = [];
      currentArrayKey = key;
    } else {
      obj[key] = value;
      currentArrayKey = null;
    }
  }

  const requireString = (key: string): string => {
    const v = obj[key];
    if (typeof v !== 'string' || v.length === 0) {
      throw new Error(`[${file}] front-matter requires non-empty string '${key}'`);
    }
    return v;
  };

  const locale = requireString('locale');
  if (!(ALLOWED_LOCALES as readonly string[]).includes(locale)) {
    throw new Error(`[${file}] locale '${locale}' not in ${ALLOWED_LOCALES.join('|')}`);
  }

  const tagsRaw = obj['tags'];
  const tags: string[] = Array.isArray(tagsRaw) ? tagsRaw : [];

  return {
    fm: {
      slug: requireString('slug'),
      title: requireString('title'),
      locale: locale as Locale,
      tags,
    },
    body,
  };
}

function sha256OfFile(raw: string): string {
  // Normalize CRLF → LF so editors don't churn the hash across platforms.
  const normalized = raw.replace(/\r\n/g, '\n');
  return createHash('sha256').update(normalized, 'utf8').digest('hex');
}

async function main(): Promise<void> {
  const entries: BundleEntry[] = [];
  const seen = new Map<string, string>(); // `${slug}|${locale}` -> file

  let files: string[];
  try {
    files = (await fs.readdir(DOCS_DIR)).filter((f) => f.endsWith('.md'));
  } catch (err: any) {
    throw new Error(
      `Cannot read Copilot docs dir at ${DOCS_DIR}: ${err.message}. Create src/copilot/docs/ before running this script.`,
    );
  }

  if (files.length === 0) {
    throw new Error(`No .md files found in ${DOCS_DIR}. Copilot needs a non-empty docs corpus.`);
  }

  for (const file of files.sort()) {
    const fullPath = path.join(DOCS_DIR, file);
    const raw = await fs.readFile(fullPath, 'utf8');
    const { fm, body } = parseFrontMatter(raw, file);

    const key = `${fm.slug}|${fm.locale}`;
    const prior = seen.get(key);
    if (prior) {
      throw new Error(
        `Duplicate (slug, locale) ('${fm.slug}', '${fm.locale}') in '${file}' and '${prior}' — each pair must be unique.`,
      );
    }
    seen.set(key, file);

    entries.push({
      slug: fm.slug,
      locale: fm.locale,
      title: fm.title,
      body: body.trimEnd() + '\n',
      tags: fm.tags,
      contentHash: sha256OfFile(raw),
    });
  }

  const outDir = path.dirname(OUT_PATH);
  await fs.mkdir(outDir, { recursive: true });
  const bundle = {
    generatedAt: new Date().toISOString(),
    schemaVersion: 1,
    entries,
  };
  await fs.writeFile(OUT_PATH, JSON.stringify(bundle, null, 2) + '\n', 'utf8');

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
