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
