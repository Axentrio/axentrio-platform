/**
 * RAG bearer auth. The property that matters is that a rotation can be deployed
 * without a flag day, and that a wrong token never throws (a malformed header must
 * be a 401, not a 500).
 */
import { describe, it, expect } from 'vitest';
import { matchRagToken } from '../../rag/rag-auth';

const CURRENT = 'current-secret-value';
const PREVIOUS = 'previous-secret-value';

describe('matchRagToken', () => {
  it('accepts the current secret', () => {
    expect(matchRagToken(`Bearer ${CURRENT}`, { current: CURRENT })).toBe('current');
  });

  it('accepts the previous secret, so a rotation is two deploys not a flag day', () => {
    expect(
      matchRagToken(`Bearer ${PREVIOUS}`, { current: CURRENT, previous: PREVIOUS }),
    ).toBe('previous');
  });

  it('prefers the current secret when both are configured to the same value', () => {
    expect(matchRagToken(`Bearer ${CURRENT}`, { current: CURRENT, previous: CURRENT })).toBe(
      'current',
    );
  });

  it('rejects a wrong token', () => {
    expect(matchRagToken('Bearer nope', { current: CURRENT, previous: PREVIOUS })).toBeNull();
  });

  it('rejects an empty or malformed header without throwing', () => {
    expect(matchRagToken('', { current: CURRENT })).toBeNull();
    expect(matchRagToken('Bearer', { current: CURRENT })).toBeNull();
    expect(matchRagToken(`Basic ${CURRENT}`, { current: CURRENT })).toBeNull();
  });

  it('rejects everything when no secret is configured', () => {
    expect(matchRagToken(`Bearer ${CURRENT}`, {})).toBeNull();
  });

  it('does not accept the bare secret without the Bearer prefix', () => {
    expect(matchRagToken(CURRENT, { current: CURRENT })).toBeNull();
  });
});
