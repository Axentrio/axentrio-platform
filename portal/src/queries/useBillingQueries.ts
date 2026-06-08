/**
 * Billing queries / mutations.
 *
 * Maps 1:1 onto src/routes/billing.routes.ts (API step 9). Stripe-driven
 * mutations return `{ queued: true }` because the visible state change
 * happens when the Stripe webhook lands — the UI polls `useBillingState`
 * after queuing.
 */

import { useMutation, useQuery, useQueryClient, queryOptions } from '@tanstack/react-query';
import { toast } from 'sonner';
import { AxiosError } from 'axios';
import { api, extractApiErrorMessage } from '../services/apiClient';
import { queryKeys } from './queryKeys';

export type BillingTier = 'free' | 'essential' | 'pro' | 'enterprise';
export type BillingStatus = 'trialing' | 'active' | 'past_due' | 'cancelled' | 'none';
export type CheckoutablePlan = 'essential' | 'pro' | 'enterprise';

export interface BillingHistoryEntry {
  id: string;
  provider: 'stripe' | 'manual' | 'system';
  eventType: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface BillingState {
  tier: BillingTier;
  primaryProvider: 'stripe' | 'manual';
  planId: BillingTier;
  status: BillingStatus;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  pendingPlanId: BillingTier | null;
  pendingPlanEffectiveAt: string | null;
  trialEnd: string | null;
  billingEmail: string | null;
  hasStripeSubscription: boolean;
  events: BillingHistoryEntry[];
}

const billingOptions = {
  state: () =>
    queryOptions({
      queryKey: queryKeys.billing.state(),
      queryFn: () => api.get<BillingState>('/billing/state'),
      // Stripe webhooks propagate asynchronously — poll while the user is
      // looking at the page so they see the result of Subscribe / Cancel /
      // ChangePlan land within a few seconds without a manual refresh.
      refetchInterval: 5000,
      staleTime: 0,
    }),
};

export function useBillingState() {
  return useQuery(billingOptions.state());
}

function describeBillingError(err: unknown): string {
  const serverMessage = extractApiErrorMessage(err);
  if (serverMessage) return serverMessage;
  if (err instanceof AxiosError) {
    // Fall back to the code (when the envelope omits a human message) before
    // axios's generic "Network Error" / status-text string.
    const data = err.response?.data as
      | { error?: { code?: string } }
      | undefined;
    return data?.error?.code || err.message;
  }
  return err instanceof Error ? err.message : 'Unknown error';
}

export function useStartCheckout() {
  return useMutation({
    mutationFn: (input: {
      planId: CheckoutablePlan;
      successUrl: string;
      cancelUrl: string;
    }) => api.post<{ url: string }>('/billing/checkout-session', input),
    onSuccess: (result) => {
      // Hard navigation to Stripe — leaves the SPA, comes back via successUrl.
      window.location.assign(result.url);
    },
    onError: (err) => {
      toast.error(`Couldn't start checkout: ${describeBillingError(err)}`);
    },
  });
}

export function useOpenPortal() {
  return useMutation({
    mutationFn: (input: { returnUrl: string }) =>
      api.post<{ url: string }>('/billing/portal-session', input),
    onSuccess: (result) => {
      window.location.assign(result.url);
    },
    onError: (err) => {
      toast.error(`Couldn't open billing portal: ${describeBillingError(err)}`);
    },
  });
}

function invalidateBillingState(queryClient: ReturnType<typeof useQueryClient>) {
  queryClient.invalidateQueries({ queryKey: queryKeys.billing.state() });
}

export function useChangePlan() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { planId: CheckoutablePlan }) =>
      api.post('/billing/change-plan', input),
    onSuccess: () => {
      toast.success('Plan change requested — waiting for Stripe to confirm…');
      invalidateBillingState(queryClient);
    },
    onError: (err) => {
      toast.error(`Couldn't change plan: ${describeBillingError(err)}`);
    },
  });
}

export function useCancelSubscription() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.post('/billing/cancel'),
    onSuccess: () => {
      toast.success('Cancellation scheduled — subscription ends at period end.');
      invalidateBillingState(queryClient);
    },
    onError: (err) => {
      toast.error(`Couldn't cancel: ${describeBillingError(err)}`);
    },
  });
}

export function useUndoCancel() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.post('/billing/undo-cancel'),
    onSuccess: () => {
      toast.success('Cancellation reversed.');
      invalidateBillingState(queryClient);
    },
    onError: (err) => {
      toast.error(`Couldn't undo cancel: ${describeBillingError(err)}`);
    },
  });
}

export function useUndoPendingChange() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.post('/billing/undo-pending-change'),
    onSuccess: () => {
      toast.success('Pending plan change reverted.');
      invalidateBillingState(queryClient);
    },
    onError: (err) => {
      toast.error(`Couldn't undo pending change: ${describeBillingError(err)}`);
    },
  });
}

export function useUpdateBillingEmail() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (email: string) =>
      api.put<{ changed: boolean }>('/billing/email', { email }),
    onSuccess: (result) => {
      if (result.changed) {
        toast.success('Billing email updated.');
        invalidateBillingState(queryClient);
      } else {
        toast.info('Billing email is unchanged.');
      }
    },
    onError: (err) => {
      toast.error(`Couldn't update billing email: ${describeBillingError(err)}`);
    },
  });
}
