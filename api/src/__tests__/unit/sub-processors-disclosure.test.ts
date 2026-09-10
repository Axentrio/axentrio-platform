/**
 * The sub-processor disclosure cannot drift.
 *
 * Three documents say who processes our customers' data — the privacy notice, the
 * public sub-processor page, and the DPA draft — and the one a customer reads is
 * never the one that got updated. The first two now RENDER the same list; this
 * test keeps the third honest and stops a second hardcoded list appearing.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { SUB_PROCESSORS } from '../../contracts/sub-processors';

const ROOT = join(__dirname, '../../../..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

describe('sub-processor disclosure', () => {
  it('lists every provider with a purpose and the data that reaches it', () => {
    expect(SUB_PROCESSORS.length).toBeGreaterThan(5);
    for (const sp of SUB_PROCESSORS) {
      expect(sp.name.trim(), 'name').not.toBe('');
      expect(sp.purpose.length, `${sp.name} purpose`).toBeGreaterThan(10);
      expect(sp.data.length, `${sp.name} data`).toBeGreaterThan(3);
    }
  });

  it('names no provider twice', () => {
    const names = SUB_PROCESSORS.map((sp) => sp.name.toLowerCase());
    expect(new Set(names).size).toBe(names.length);
  });

  it('renders the SAME list in the notice and on the page', () => {
    // A hardcoded second list is the failure mode: it looks right until someone
    // adds a provider in one place only.
    for (const file of [
      'portal/src/pages/legal/PrivacyPolicy.tsx',
      'portal/src/pages/legal/SubProcessors.tsx',
    ]) {
      const src = read(file);
      expect(src, `${file} must import the shared list`).toContain(
        "@contracts/sub-processors",
      );
      expect(src, `${file} must render it`).toContain('SUB_PROCESSORS.map');
    }
  });

  it('is reachable from the public legal routes', () => {
    const app = read('portal/src/App.tsx');
    expect(app).toContain("'/sub-processors'");
    expect(app).toContain('<SubProcessors />');
  });

  it('names every provider in the DPA draft, which is what a lawyer reviews', () => {
    const dpa = read('docs/dpa-draft.md');
    for (const sp of SUB_PROCESSORS) {
      expect(dpa, `${sp.name} is missing from docs/dpa-draft.md`).toContain(sp.name);
    }
  });
});
