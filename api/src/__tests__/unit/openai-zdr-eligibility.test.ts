/**
 * The OpenAI calls we make must stay inside the set that Zero Data Retention
 * covers.
 *
 * "We have ZDR" is a claim about our code as much as about our contract: OpenAI's
 * ZDR-excluded endpoints still store application state even when ZDR is enabled,
 * so adding one silently makes the claim false. The eligibility list below is
 * transcribed from OpenAI's data-controls documentation.
 *
 * The same applies to `store: true`, which asks OpenAI to keep the response for
 * application state instead of treating it as a one-off turn.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

/** Eligible today, and the reason we are allowed to depend on it. */
const ZDR_ELIGIBLE_CALLS = ['chat.completions.create', 'embeddings.create'] as const;

/**
 * Endpoints that store application state regardless of ZDR. A call to any of
 * these needs a deliberate decision, not an accident.
 */
const ZDR_INELIGIBLE: Array<{ pattern: RegExp; endpoint: string; why: string }> = [
  { pattern: /\.files\.(create|retrieve|list|del)\s*\(/, endpoint: '/v1/files', why: 'retained until deleted' },
  { pattern: /\.vectorStores\b/, endpoint: '/v1/vector_stores', why: 'retained until deleted' },
  { pattern: /\.batches\b/, endpoint: '/v1/batches', why: 'retained until deleted' },
  { pattern: /\.assistants\b/, endpoint: '/v1/assistants', why: 'retained until deleted' },
  { pattern: /\.threads\b/, endpoint: '/v1/threads', why: 'retained until deleted' },
  { pattern: /\.conversations\b/, endpoint: '/v1/conversations', why: 'retained until deleted' },
  { pattern: /\.evals\b/, endpoint: '/v1/evals', why: 'retained until deleted' },
  { pattern: /\.videos\b/, endpoint: '/v1/videos', why: 'blocked for ZDR requests entirely' },
];

/** Ask OpenAI to keep the response = the opposite of the claim. */
const STORE_TRUE = /store\s*:\s*true/;

function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry !== '__tests__' && entry !== 'node_modules') sourceFiles(full, acc);
    } else if (entry.endsWith('.ts')) {
      acc.push(full);
    }
  }
  return acc;
}

/** Only files that actually build an OpenAI client — `store` and `files` are common words. */
function openAiCallSites(): Array<{ file: string; src: string }> {
  const apiSrc = join(__dirname, '../../');
  return sourceFiles(apiSrc)
    .map((file) => ({ file, src: readFileSync(file, 'utf8') }))
    .filter(({ src }) => /from\s+['"]openai['"]/.test(src));
}

describe('OpenAI Zero Data Retention eligibility', () => {
  it('finds the call sites it is meant to be guarding', () => {
    // Guards the guard: a broken path filter would make every assertion vacuous.
    const files = openAiCallSites();
    expect(files.length).toBeGreaterThan(0);
    const all = files.map((f) => f.src).join('\n');
    for (const call of ZDR_ELIGIBLE_CALLS) {
      expect(all, `expected to find ${call}`).toContain(call);
    }
  });

  it('calls no ZDR-ineligible endpoint', () => {
    const offenders: string[] = [];
    for (const { file, src } of openAiCallSites()) {
      for (const { pattern, endpoint, why } of ZDR_INELIGIBLE) {
        if (pattern.test(src)) {
          offenders.push(`${file.replace(/.*\/api\//, 'api/')} calls ${endpoint} — ${why}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('never asks OpenAI to store a response', () => {
    const offenders = openAiCallSites()
      .filter(({ src }) => STORE_TRUE.test(src))
      .map(({ file }) => file.replace(/.*\/api\//, 'api/'));

    expect(offenders).toEqual([]);
  });
});
