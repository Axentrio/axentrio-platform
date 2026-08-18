export type PrioritySeverity = 'red' | 'orange' | 'green';

const SEVERITY_WEIGHT: Record<PrioritySeverity, number> = {
  red: 3,
  orange: 2,
  green: 1,
};

export function trendMultiplier(current: number, baseline: number): number {
  const currentVolume = Math.max(0, current);
  const baselineVolume = Math.max(0, baseline);
  if (baselineVolume === 0) return currentVolume > 0 ? 1.5 : 1;
  return Math.min(2, Math.max(0.5, currentVolume / baselineVolume));
}

export function priorityScore(input: {
  severity: PrioritySeverity;
  occurrences: number;
  currentVolume: number;
  baselineVolume: number;
}): number {
  const score =
    SEVERITY_WEIGHT[input.severity] *
    Math.max(0, input.occurrences) *
    trendMultiplier(input.currentVolume, input.baselineVolume);
  return Math.round(score * 100) / 100;
}

export function experimentOccurrences(payload: Record<string, unknown>): number {
  if (typeof payload.sessions === 'number') return payload.sessions;
  return ['a', 'b', 'c', 'd'].reduce(
    (sum, key) => sum + (typeof payload[key] === 'number' ? payload[key] : 0),
    0,
  );
}
