import { useQuery } from '@tanstack/react-query';
import { api } from '../services/apiClient';
import { queryKeys } from './queryKeys';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

interface OnboardingStep {
  key: string;
  complete: boolean;
  [key: string]: Any;
}

interface OnboardingStatusResponse {
  complete: boolean;
  completedCount: number;
  totalCount: number;
  steps: OnboardingStep[];
}

interface AvailableToolsResponse {
  tools: Any[];
}

export function useOnboardingStatus() {
  return useQuery({
    queryKey: queryKeys.onboarding.status(),
    queryFn: () => api.get<OnboardingStatusResponse>('/tenants/me/onboarding-status'),
  });
}

export function useAvailableTools() {
  return useQuery({
    queryKey: [...queryKeys.onboarding.all(), 'available-tools'],
    queryFn: () => api.get<AvailableToolsResponse>('/tenants/me/available-tools'),
  });
}
