import { useQuery, queryOptions } from '@tanstack/react-query';
import { api } from '../services/apiClient';
import { queryKeys } from './queryKeys';

export const analyticsOptions = {
  timeseries: (startDate: string, endDate: string) => queryOptions({
    queryKey: queryKeys.analytics.timeseries(startDate, endDate),
    queryFn: () => api.get('/analytics/chats/timeseries', { params: { startDate, endDate } }),
  }),
  chatMetrics: (from: string, to: string) => queryOptions({
    queryKey: queryKeys.analytics.chatMetrics(from, to),
    queryFn: () => api.get('/analytics/chats', { params: { from, to } }),
  }),
  agents: () => queryOptions({
    queryKey: queryKeys.analytics.agents(),
    queryFn: () => api.get('/analytics/agents'),
  }),
};

export function useAnalyticsTimeseries(startDate: string, endDate: string, enabled: boolean) {
  return useQuery({ ...analyticsOptions.timeseries(startDate, endDate), enabled });
}

export function useAnalyticsChatMetrics(from: string, to: string, enabled: boolean) {
  return useQuery({ ...analyticsOptions.chatMetrics(from, to), enabled });
}

export function useAnalyticsAgents(enabled: boolean) {
  return useQuery({ ...analyticsOptions.agents(), enabled });
}
