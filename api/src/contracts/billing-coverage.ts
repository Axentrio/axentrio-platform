/**
 * Whether a workspace already pays or trials, so setup must not send it to Stripe.
 * Shared by POST /onboarding/restart hydration and the portal PlanStep.
 */
export interface BillingCoverageInput {
  tier: string;
  status: string;
  hasStripeSubscription: boolean;
}

export function isPlanCovered(b: BillingCoverageInput): boolean {
  return (
    b.hasStripeSubscription === true ||
    b.status === 'trialing' ||
    b.status === 'active' ||
    b.status === 'past_due' ||
    b.tier !== 'free'
  );
}
