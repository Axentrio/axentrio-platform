/**
 * The recorded version must be the version on the page.
 *
 * A `terms_acceptances` row is only evidence if it points at a document someone
 * could have read. If the page is updated and the constant is not, every new
 * acceptance records consent to something that no longer exists — which is worse
 * than no record, because it looks like proof.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { CURRENT_TERMS_VERSION } from '../../config/terms';

describe('CURRENT_TERMS_VERSION', () => {
  it('matches the lastUpdated on the published Terms page', () => {
    const page = readFileSync(
      join(__dirname, '../../../../portal/src/pages/legal/Terms.tsx'),
      'utf8',
    );
    const match = /lastUpdated="([^"]+)"/.exec(page);
    expect(match, 'Terms.tsx must carry a lastUpdated date').not.toBeNull();

    // A calendar date, not an instant: reading it through toISOString() shifts it
    // by a day anywhere east of UTC.
    const parsed = new Date(match![1]);
    const published = [
      parsed.getFullYear(),
      String(parsed.getMonth() + 1).padStart(2, '0'),
      String(parsed.getDate()).padStart(2, '0'),
    ].join('-');
    expect(published).toBe(CURRENT_TERMS_VERSION);
  });

  it('is an ISO date, so it sorts and compares', () => {
    expect(CURRENT_TERMS_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
