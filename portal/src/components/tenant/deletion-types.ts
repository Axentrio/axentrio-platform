/** Shared wire shape for the account-deletion endpoints. */
export interface DeletionState {
  requestedAt: string | null;
  scheduledFor: string | null;
  requestedBy: string | null;
  daysRemaining: number | null;
}
