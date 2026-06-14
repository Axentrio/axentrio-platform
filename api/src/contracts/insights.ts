/**
 * Wire contract: GET /api/v1/insights (+ /:gapId/evidence) — shared between
 * api (provider) and portal (consumer, type-only imports). Pure types; see
 * contracts/entitlements.ts for the directory rules.
 */

export type GapStatus = 'open' | 'dormant' | 'resolved_data' | 'resolved_manual' | 'archived';
export type GapSeverity = 'red' | 'orange' | 'green';

export interface GapDto {
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

export interface InsightsMeta {
  lastRefreshedAt: string | null;
  /** judged-eligible / total-eligible for the 7-day window; null pre-first-run. */
  completeness: number | null;
  /** Wins-history window in days, derived from the tenant's flag set (ADR-0013). */
  retentionDays: number;
  evidenceEnabled: boolean;
}

export interface InsightsListResponse {
  gaps: GapDto[];
  meta: InsightsMeta;
}

export interface EvidenceMessageDto {
  id: string;
  sender: string;
  content: string;
  at: string;
}

export interface EvidenceEntryDto {
  sessionId: string;
  sessionStartedAt: string;
  reasoning: string | null;
  messages: EvidenceMessageDto[];
}

export interface EvidenceResponse {
  evidence: EvidenceEntryDto[];
}

/* ------------------------------------------------------------------ */
/*  P3 — AI Business Insights (Enterprise). Additive; see ADR-0014.   */
/* ------------------------------------------------------------------ */

export type ExperimentKind = 'correlation' | 'sentiment';
export type ExperimentSeverity = 'red' | 'orange' | 'green';

/**
 * An experiment (correlation or sentiment) — an OBSERVATION, never resolvable
 * (ADR-0001). State is active|dismissed only; there is no resolved/Win.
 */
export interface ExperimentDto {
  id: string;
  kind: ExperimentKind;
  severity: ExperimentSeverity;
  title: string;
  detail: string | null;
  /** Kind-specific display data (rates, counts, suggestion text). */
  payload: Record<string, unknown>;
  firstSeenAt: string;
  lastSeenAt: string;
}

export interface ExperimentsResponse {
  experiments: ExperimentDto[];
}

/** The structured header of a weekly digest (rendered above the narrative). */
export interface DigestMetrics {
  conversations: { current: number; previous: number };
  bookings: { current: number; previous: number };
  leads: { current: number; previous: number };
  gapsOpened: number;
  gapsWon: number;
}

export interface DigestDto {
  weekStart: string;
  summaryMd: string;
  metrics: DigestMetrics;
}

/** null when no digest has been generated yet (pre-first-Monday). */
export interface DigestResponse {
  digest: DigestDto | null;
}

export type ExportDataset = 'outcomes-timeseries' | 'gaps' | 'leads';
