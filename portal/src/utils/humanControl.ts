/**
 * humanControl — the non-component half of the B-PR5b timed human-control UI
 * (kept out of the component file so fast refresh stays component-only).
 */

/** The takeover policy a menu pick emits. The CALLER owns the wire payload. */
export type TakeoverPolicy = { mode: 'indefinite' } | { mode: 'timed'; hours: number };

/** The offered timed durations. The backend accepts hours 1..24 (B-PR5a). */
export const TAKEOVER_HOURS = [1, 2, 4, 8, 12, 24] as const;

/** Remaining time under this threshold renders in the warning color. */
export const WARNING_THRESHOLD_MS = 5 * 60 * 1000;

/** mm:ss under an hour, else "Hh Mm". Clamped at 0. */
export function formatRemaining(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  if (totalSeconds >= 3600) {
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    return `${hours}h ${minutes}m`;
  }
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}
