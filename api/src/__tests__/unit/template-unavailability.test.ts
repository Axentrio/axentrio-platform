import { describe, it, expect } from 'vitest';
import { templateUnavailabilityReason } from '../../templates/template-resolver';

const resolved = (over: Record<string, unknown> = {}) =>
  ({ templateId: 't1', body: '', config: {}, resolvedVersion: 1, pinnedButUnavailable: false, templateUnavailable: false, ...over }) as any;

describe('templateUnavailabilityReason — AC4 fallback signal', () => {
  it('returns null when the bound template resolved normally', () => {
    expect(templateUnavailabilityReason(resolved())).toBeNull();
  });

  it('flags a missing/archived/unpublished template', () => {
    expect(templateUnavailabilityReason(resolved({ templateUnavailable: true }))).toBe('missing_or_archived');
  });

  it('flags a pinned-but-unavailable version', () => {
    expect(templateUnavailabilityReason(resolved({ pinnedButUnavailable: true }))).toBe('pinned_version_unavailable');
  });

  it('prefers the missing/archived reason when both flags are set', () => {
    expect(templateUnavailabilityReason(resolved({ templateUnavailable: true, pinnedButUnavailable: true }))).toBe('missing_or_archived');
  });
});
