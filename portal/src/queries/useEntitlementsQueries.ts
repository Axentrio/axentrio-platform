/**
 * useEntitlementsQueries
 * React Query SDK for the backend entitlements endpoint (M1).
 *
 * Backend: `GET /api/v1/entitlements` returns the current tenant's plan,
 * limits, feature flags, and the marketed plan catalogue. Entitlements
 * rarely change mid-session, so we cache for 5 minutes.
 */

import { useQuery, queryOptions } from '@tanstack/react-query';
import { api } from '../services/apiClient';
import { queryKeys } from './queryKeys';

export type InternalPlanId = 'free' | 'essential' | 'pro' | 'enterprise';

export type SupportTier = 'none' | 'email' | 'priority';

export interface PlanLimits {
  agents: number | null;
  sessions: number | null;
  dailyLlmCalls: number | null;
}

export interface PlanFeatures {
  unifiedInbox: boolean;
  bookings: boolean;
  calendarIntegrations: boolean;
  leadCapture: boolean;
  platformAssistant: boolean;
  crm: boolean;
  hideWidgetAttribution: boolean;
  customWidgetAppearance: boolean;
  handoff: boolean;
  fileUpload: boolean;
}

export interface Entitlements {
  planId: InternalPlanId;
  limits: PlanLimits;
  features: PlanFeatures;
  support: SupportTier;
}

export interface PlanDefinition {
  id: InternalPlanId;
  displayName: string;
  rank: number;
  priceEurMonthly: number | null;
  isSelfServeCheckoutable: boolean;
  limits: PlanLimits;
  features: PlanFeatures;
  support: SupportTier;
}

export interface EntitlementsResponse {
  current: Entitlements;
  plans: PlanDefinition[];
  selfServePlans: InternalPlanId[];
}

const FIVE_MINUTES_MS = 5 * 60 * 1000;

export const entitlementsOptions = {
  current: () =>
    queryOptions({
      queryKey: queryKeys.entitlements.all(),
      queryFn: () => api.get<EntitlementsResponse>('/entitlements'),
      staleTime: FIVE_MINUTES_MS,
    }),
};

export function useEntitlements() {
  return useQuery(entitlementsOptions.current());
}

/**
 * Returns true when the current tenant has the named feature flag enabled.
 * Returns false while loading or on error — callers using this for gating
 * should fail closed.
 */
export function useHasFeature(feature: keyof PlanFeatures): boolean {
  const { data } = useEntitlements();
  return data?.current.features[feature] ?? false;
}

/**
 * Returns the current tenant's plan id, or `undefined` while loading.
 */
export function useCurrentTier(): InternalPlanId | undefined {
  const { data } = useEntitlements();
  return data?.current.planId;
}
