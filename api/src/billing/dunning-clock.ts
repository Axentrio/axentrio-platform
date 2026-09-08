export const DUNNING_GRACE_MS = 3 * 24 * 60 * 60 * 1000;
export const DUNNING_SWEEP_MS = 15 * 60 * 1000;
export type DunningDay = 0 | 1 | 2;

export function graceEndsAt(started: Date): Date {
  return new Date(started.getTime() + DUNNING_GRACE_MS);
}
