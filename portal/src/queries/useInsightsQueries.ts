/**
 * Insights (Gaps) queries — ADR-0007 surface over GET /insights.
 * Evidence drill-down is Pro+ (`gapEvidence`); callers gate the fetch.
 */
import { useQuery, useMutation, useQueryClient, queryOptions } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api } from '../services/apiClient';
import { queryKeys } from './queryKeys';

export type GapStatus = 'open' | 'dormant' | 'resolved_data' | 'resolved_manual' | 'archived';
export type GapSeverity = 'red' | 'orange' | 'green';

export interface GapRow {
  id: string;
  topic: string;
  status: GapStatus;
  severity: GapSeverity;
  occurrences: number;
  distinctVisitors: number;
  firstDetectedAt: string;
  lastSeenAt: string;
  resolvedAt: string | null;
  archivedAt: string | null;
  recommendation: string | null;
}

export interface InsightsResponse {
  gaps: GapRow[];
  meta: {
    lastRefreshedAt: string | null;
    completeness: number | null;
    retentionDays: number;
    evidenceEnabled: boolean;
  };
}

export interface EvidenceEntry {
  sessionId: string;
  sessionStartedAt: string;
  reasoning: string | null;
  messages: Array<{ id: string; sender: string; content: string; at: string }>;
}

const insightsOptions = {
  list: () => queryOptions({
    queryKey: queryKeys.insights.list(),
    queryFn: () => api.get<InsightsResponse>('/insights'),
  }),
  evidence: (gapId: string) => queryOptions({
    queryKey: queryKeys.insights.evidence(gapId),
    queryFn: () => api.get<{ evidence: EvidenceEntry[] }>(`/insights/${gapId}/evidence`),
  }),
};

export function useInsights(enabled = true) {
  return useQuery({ ...insightsOptions.list(), enabled });
}

export function useGapEvidence(gapId: string | null, enabled: boolean) {
  return useQuery({ ...insightsOptions.evidence(gapId ?? ''), enabled: enabled && !!gapId });
}

function useGapAction(action: 'resolve' | 'archive', successMessage: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (gapId: string) => {
      await api.post(`/insights/${gapId}/${action}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.insights.all() });
      toast.success(successMessage);
    },
    onError: () => toast.error('Something went wrong'),
  });
}

export function useResolveGap(successMessage: string) {
  return useGapAction('resolve', successMessage);
}

export function useArchiveGap(successMessage: string) {
  return useGapAction('archive', successMessage);
}
