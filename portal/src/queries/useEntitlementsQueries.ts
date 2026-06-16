/**
 * useEntitlementsQueries
 * React Query SDK for the backend entitlements endpoint (M1).
 *
 * Backend: `GET /api/v1/entitlements` returns the current tenant's plan,
 * limits, feature flags, and the marketed plan catalogue. Entitlements
 * rarely change mid-session, so we cache for 5 minutes.
 */

import { useQuery, useMutation, useQueryClient, queryOptions } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api } from '../services/apiClient';
import { queryKeys } from './queryKeys';
// Wire types come from the api's contract module (type-only — erased at
// build, no runtime coupling). The api types its responses with the same
// definitions, so a renamed key fails tsc on BOTH sides instead of silently
// breaking the portal at runtime.
import type {
  InternalPlanId,
  SupportTier,
  PlanLimits,
  PlanFeatures,
  EntitlementsDto,
  PlanDefinitionDto,
  EntitlementsResponse,
  ToggleableFeatureKey,
  TenantFeatureToggles,
} from '@contracts/entitlements';

export type {
  InternalPlanId,
  SupportTier,
  PlanLimits,
  PlanFeatures,
  EntitlementsResponse,
  ToggleableFeatureKey,
  TenantFeatureToggles,
};
export type Entitlements = EntitlementsDto;
export type PlanDefinition = PlanDefinitionDto;

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
 * Returns true when the current tenant is ENTITLED to the feature — the plan
 * ceiling, BEFORE the tenant's own on/off preference. Use this (not
 * `useHasFeature`) to decide whether to show an upsell/"locked" surface: a
 * feature the tenant turned off is still entitled, so it must NOT show an
 * upgrade prompt. Fails closed while loading or on error.
 */
export function useIsEntitled(feature: keyof PlanFeatures): boolean {
  const { data } = useEntitlements();
  return data?.current.entitledFeatures[feature] ?? false;
}

/**
 * Tenant's stored feature on/off preferences (the raw map). Absent key = on
 * (when entitled). Drives the Features settings switches.
 */
export function useFeatureToggles(): TenantFeatureToggles {
  const { data } = useEntitlements();
  return data?.current.featureToggles ?? {};
}

/**
 * PUT /tenants/me/feature-toggles — replaces the FULL toggle map (tenant
 * admin only; the API clamps to the entitlement ceiling and rejects enabling
 * a non-entitled feature). Invalidates entitlements so every gate re-resolves.
 */
export function useUpdateFeatureToggles() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (toggles: TenantFeatureToggles) =>
      // The route returns only the effective/ceiling/prefs slice, not the full DTO.
      api.put<Pick<EntitlementsDto, 'featureToggles' | 'entitledFeatures' | 'features'>>(
        '/tenants/me/feature-toggles',
        toggles,
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.entitlements.all() });
    },
    onError: () => toast.error('Failed to update features'),
  });
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
