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
  calendarSync: boolean;
  leadCapture: boolean;
  platformAssistant: boolean;
  crm: boolean;
  hideWidgetAttribution: boolean;
  customWidgetAppearance: boolean;
  handoff: boolean;
  fileUpload: boolean;
  channelWhatsapp: boolean;
  channelMessenger: boolean;
  channelInstagram: boolean;
  channelTelegram: boolean;
  /** Tiered Insights ladder (ADR-0013): surface / evidence drill-down / intelligence layer. */
  gapInsights: boolean;
  gapEvidence: boolean;
  aiBusinessInsights: boolean;
}

export interface Entitlements {
  planId: InternalPlanId;
  /** False for free/suspended/cancelled tenants — everything below is off. */
  billable: boolean;
  limits: PlanLimits;
  features: PlanFeatures;
  support: SupportTier;
  /** Ids of modules active for this tenant (feature- or enablement-gated). */
  activeModules: string[];
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
 * Returns true when the named Module is active for the current tenant —
 * feature-gated modules (e.g. 'booking') follow the plan/overrides;
 * enablement-gated (bespoke) modules follow their per-tenant switch. Use this
 * to show/hide bespoke module UI. Fails closed while loading or on error.
 */
export function useHasModule(moduleId: string): boolean {
  const { data } = useEntitlements();
  return data?.current.activeModules?.includes(moduleId) ?? false;
}

/**
 * Returns the current tenant's plan id, or `undefined` while loading.
 */
export function useCurrentTier(): InternalPlanId | undefined {
  const { data } = useEntitlements();
  return data?.current.planId;
}
