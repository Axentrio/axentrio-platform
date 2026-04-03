import { useQuery } from '@tanstack/react-query';
import { api } from '../services/apiClient';
import { queryKeys } from './queryKeys';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

interface OnboardingSteps {
  aiEnabled: boolean;
  brandVoiceConfigured: boolean;
  knowledgeBaseHasDocs: boolean;
  calcomConnected: boolean;
  automationsConfigured: boolean;
  [key: string]: boolean;
}

interface OnboardingStatusResponse {
  complete: boolean;
  completedCount: number;
  totalCount: number;
  steps: OnboardingSteps;
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
