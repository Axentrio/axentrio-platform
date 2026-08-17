/**
 * Tenant inbox preferences — presentation defaults only.
 *
 * `defaultTakeoverHours` preselects the Takeover menu. It never changes claim
 * semantics, expiry, or the command service.
 */

export type DefaultTakeoverHours = number | 'indefinite';

export const DEFAULT_TAKEOVER_HOURS: DefaultTakeoverHours = 'indefinite';

export function resolveDefaultTakeoverHours(stored: unknown): DefaultTakeoverHours {
  if (stored === 'indefinite' || stored === undefined || stored === null) return 'indefinite';
  if (typeof stored === 'number' && Number.isInteger(stored) && stored >= 1 && stored <= 24) {
    return stored;
  }
  return DEFAULT_TAKEOVER_HOURS;
}

export function parseDefaultTakeoverHours(input: unknown): DefaultTakeoverHours | null {
  if (input === 'indefinite') return 'indefinite';
  if (typeof input === 'number' && Number.isInteger(input) && input >= 1 && input <= 24) return input;
  return null;
}
