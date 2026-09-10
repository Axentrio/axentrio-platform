/**
 * Every relative link in the README must point at a file that exists.
 *
 * The README carried `docs/security-audit.md` for a long time and that file was
 * never written. A dead link in a security section is worse than no link: the
 * reader believes a checklist exists and stops looking.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const REPO_ROOT = join(__dirname, '../../../..');

describe('README relative links', () => {
  it('all resolve to a file in the repository', () => {
    const readme = readFileSync(join(REPO_ROOT, 'README.md'), 'utf8');

    const targets: string[] = [];
    for (const match of readme.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
      const target = match[1];
      // Absolute URLs and in-page anchors are not this test's business.
      if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('#')) continue;
      targets.push(target.split('#')[0]);
    }

    expect(targets.length, 'README must contain relative links to check').toBeGreaterThan(0);

    const dead = targets.filter((t) => !existsSync(join(REPO_ROOT, t)));
    expect(dead, `README links to files that do not exist: ${dead.join(', ')}`).toEqual([]);
  });
});
