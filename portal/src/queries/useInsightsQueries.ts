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

/** Mirrors the server's analysis-policy shape; see api/src/insights/analysis-policy.ts. */
export interface AnalysisStatus {
  eligible: boolean;
  reason: 'not_entitled' | 'automatic' | 'not_enough_chats' | 'cooling_down' | null;
  newChats: number;
  minNewChats: number;
  nextAllowedAt: string | null;
  lastRefreshedAt: string | null;
  policy: { tier: 'none' | 'essential' | 'pro' | 'enterprise'; automatic: boolean; minNewChats: number; cooldownHours: number };
}

export function useAnalysisStatus(enabled = true) {
  return useQuery({
    queryKey: [...queryKeys.insights.all(), 'analysis-status'],
    queryFn: () => api.get<AnalysisStatus>('/insights/analysis-status'),
    enabled,
  });
}

/**
 * Run analysis on demand. On success every insights view is invalidated, not just the
 * status — the whole point of the run is that the gaps, digest and experiments beneath
 * it have changed.
 */
export function useRunAnalysis() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<AnalysisStatus>('/insights/analyse'),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.insights.all() });
    },
  });
}

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

/** Lead demand — what customers actually asked for. Enterprise (aiBusinessInsights). */
export interface DemandSlice {
  label: string;
  leads: number;
  /** Share of the CLASSIFIED subset, not of all leads. See `classifiedLeads`. */
  share: number;
}

export interface LeadDemandResponse {
  window: { from: string; to: string; days: number };
  totalLeads: number;
  /** The denominator `topServices` shares are computed against. */
  classifiedLeads: number;
  topServices: DemandSlice[];
  /** Inferred (needs enrichment), reported separately from the factual services. */
  topTags: DemandSlice[];
  taggedLeads: number;
  byUrgency: { emergency: number; urgent: number; routine: number; unknown: number };
  suppressed: boolean;
  suppressionReason: string | null;
}

export function useLeadDemand(enabled = true) {
  return useQuery({
    queryKey: [...queryKeys.insights.all(), 'lead-demand'] as const,
    queryFn: () => api.get<LeadDemandResponse>('/insights/lead-demand'),
    enabled,
  });
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
