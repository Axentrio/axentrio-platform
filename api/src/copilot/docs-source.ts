/**
 * Reading the Copilot docs corpus from its SOURCE — the markdown under
 * `src/copilot/docs/`.
 *
 * This used to live inside `scripts/build-copilot-docs.ts`, which made the parsed
 * corpus reachable only through the build artifact it produces. That is fine for the
 * server, which requires the bundle at boot, and wrong for anything that wants to check
 * the corpus itself: the docs test ended up reading `dist/`, passed locally where a
 * build had been run by hand, and failed in CI where `api-test` runs `vitest` without
 * ever building. Red main, skipped deploy.
 *
 * So the parsing is a module and the build script is a thin wrapper around it. Anything
 * that asks a question about the docs asks the files, which is what a contributor edits.
 */
import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import * as path from 'path';

export const ALLOWED_LOCALES = ['en', 'nl', 'fr'] as const;
export type Locale = (typeof ALLOWED_LOCALES)[number];

export const DOCS_DIR = path.join(__dirname, 'docs');

export interface DocFrontMatter {
  slug: string;
  title: string;
  locale: Locale;
  tags: string[];
}

export interface DocEntry extends DocFrontMatter {
  body: string;
  contentHash: string;
}

/**
 * Parse the YAML-ish front-matter at the top of a markdown file.
 * Supports flat `key: value` pairs and a `tags:` array of `- item` lines.
 * Anything more complex (nested objects, multi-line strings) is intentionally
 * unsupported — Copilot docs front-matter stays flat.
 */
export function parseFrontMatter(raw: string, file: string): { fm: DocFrontMatter; body: string } {
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
    const listMatch = /^\s*-\s+(.+)$/.exec(line);
    if (listMatch && currentArrayKey) {
      (obj[currentArrayKey] as string[]).push(listMatch[1].trim());
      continue;
    }
    const kvMatch = /^([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*(.*)$/.exec(line);
    if (!kvMatch) {
      throw new Error(`[${file}] unparseable front-matter line: ${JSON.stringify(line)}`);
    }
    const key = kvMatch[1];
    const value = kvMatch[2];
    if (value === '') {
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
    fm: { slug: requireString('slug'), title: requireString('title'), locale: locale as Locale, tags },
    body,
  };
}

/** CRLF-normalised so editors don't churn the hash across platforms. */
export function sha256OfFile(raw: string): string {
  return createHash('sha256').update(raw.replace(/\r\n/g, '\n'), 'utf8').digest('hex');
}

/**
 * Read and parse every doc. Throws on a duplicate `(slug, locale)` — that pair is the
 * upsert key, so a collision would silently drop one of the two.
 */
export async function loadDocsFromSource(docsDir: string = DOCS_DIR): Promise<DocEntry[]> {
  let files: string[];
  try {
    files = (await fs.readdir(docsDir)).filter((f) => f.endsWith('.md'));
  } catch (err) {
    throw new Error(
      `Cannot read Copilot docs dir at ${docsDir}: ${(err as Error).message}. Create src/copilot/docs/ first.`,
    );
  }
  if (files.length === 0) {
    throw new Error(`No .md files found in ${docsDir}. Copilot needs a non-empty docs corpus.`);
  }

  const entries: DocEntry[] = [];
  const seen = new Map<string, string>();

  for (const file of files.sort()) {
    const raw = await fs.readFile(path.join(docsDir, file), 'utf8');
    const { fm, body } = parseFrontMatter(raw, file);

    const key = `${fm.slug}|${fm.locale}`;
    const prior = seen.get(key);
    if (prior) {
      throw new Error(
        `Duplicate (slug, locale) ('${fm.slug}', '${fm.locale}') in '${file}' and '${prior}' — each pair must be unique.`,
      );
    }
    seen.set(key, file);

    entries.push({ ...fm, body: body.trimEnd() + '\n', contentHash: sha256OfFile(raw) });
  }

  return entries;
}
