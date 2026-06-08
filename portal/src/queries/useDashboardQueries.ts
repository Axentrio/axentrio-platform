import { useQuery, queryOptions } from '@tanstack/react-query';
import { api } from '../services/apiClient';
import { queryKeys } from './queryKeys';

interface DashboardApiResponse {
  dashboard: {
    sessions: { total: number; active: number; waiting: number; handoff: number; bot: number };
    agents: { total: number; online: number };
    avgResponseTimeSeconds: number;
    csatScore: number | null;
    botResolutionRate: number | null;
  };
}

const dashboardOptions = {
  metrics: () => queryOptions({
    queryKey: queryKeys.dashboard.metrics(),
    queryFn: () => api.get<DashboardApiResponse>('/analytics/dashboard'),
    refetchInterval: 30_000,
  }),
};

export function useDashboardMetrics() {
  return useQuery(dashboardOptions.metrics());
}
