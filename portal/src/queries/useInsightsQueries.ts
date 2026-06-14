/**
 * Insights (Gaps) queries — ADR-0007 surface over GET /insights.
 * Evidence drill-down is Pro+ (`gapEvidence`); callers gate the fetch.
 */
import { useQuery, useMutation, useQueryClient, queryOptions } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api } from '../services/apiClient';
import { queryKeys } from './queryKeys';
// Wire types from the api's contract module (type-only, erased at build).
import type {
  GapStatus,
  GapSeverity,
  GapDto,
  InsightsListResponse,
  EvidenceEntryDto,
  ExperimentsResponse,
  DigestResponse,
} from '@contracts/insights';

export type { GapStatus, GapSeverity };
export type GapRow = GapDto;
export type InsightsResponse = InsightsListResponse;
export type EvidenceEntry = EvidenceEntryDto;
export type { ExperimentDto, ExperimentKind, ExperimentsResponse } from '@contracts/insights';
export type { DigestDto, DigestMetrics, DigestResponse } from '@contracts/insights';

const insightsOptions = {
  list: () => queryOptions({
    queryKey: queryKeys.insights.list(),
    queryFn: () => api.get<InsightsResponse>('/insights'),
  }),
  evidence: (gapId: string) => queryOptions({
    queryKey: queryKeys.insights.evidence(gapId),
    queryFn: () => api.get<{ evidence: EvidenceEntry[] }>(`/insights/${gapId}/evidence`),
  }),
  experiments: () => queryOptions({
    queryKey: queryKeys.insights.experiments(),
    queryFn: () => api.get<ExperimentsResponse>('/insights/experiments'),
  }),
  digest: () => queryOptions({
    queryKey: queryKeys.insights.digest(),
    queryFn: () => api.get<DigestResponse>('/insights/digest'),
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

export function useExperiments(enabled = true) {
  return useQuery({ ...insightsOptions.experiments(), enabled });
}

export function useDismissExperiment(successMessage: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (experimentId: string) => {
      await api.post(`/insights/experiments/${experimentId}/dismiss`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.insights.experiments() });
      toast.success(successMessage);
    },
    onError: () => toast.error('Something went wrong'),
  });
}

export function useDigest(enabled = true) {
  return useQuery({ ...insightsOptions.digest(), enabled });
}

export function useSetDigestEmail(successMessage: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (enabled: boolean) => {
      await api.put('/insights/digest/email', { enabled });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.insights.digest() });
      toast.success(successMessage);
    },
    onError: () => toast.error('Something went wrong'),
  });
}
