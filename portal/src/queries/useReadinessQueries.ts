/**
 * useReadinessQueries
 * React Query SDK for the capability-readiness endpoint (change 7).
 *
 * Backend: `GET /api/v1/bots/readiness?botId=<id>` — per-bot, per-capability
 * readiness signal. Optional `botId` defaults to the tenant's anchor bot.
 *
 * The shapes here MIRROR the backend contract verbatim:
 *   - ReadinessResult: api/src/readiness/registry.ts
 *   - booking detail:  api/src/readiness/capabilities/booking.readiness.ts
 * Keep them in sync — a divergence would silently mis-render the cards.
 */

import { useQuery } from '@tanstack/react-query';
import { api } from '../services/apiClient';
import { queryKeys } from './queryKeys';

export type CapabilityKey = 'booking' | 'answering' | 'lead_capture' | 'channel';
export type ReadinessState = 'not_ready' | 'live';

/** A deep-link CTA for a missing step or attention item. */
export interface ReadinessCta {
  route: string;
  label: string;
}

export interface ReadinessMissingStep {
  id: string;
  label: string;
  cta?: ReadinessCta;
}

export interface ReadinessAttention {
  code: string;
  label: string;
  cta?: ReadinessCta;
}

export interface ReadinessResult {
  capability: CapabilityKey;
  /** Present only for `channel` (one result per ChannelConnection row). */
  instanceId?: string;
  state: ReadinessState;
  /** Ordered path to `live` only — empty when state === 'live'. */
  missingSteps: ReadinessMissingStep[];
  /** Non-blocking, can't-do-MORE items (e.g. live booking that can't auto-confirm). */
  attention?: ReadinessAttention[];
  detail?: Record<string, unknown>;
}

/**
 * A feature the tenant is entitled to AND has switched on, whose delivering skill
 * no template bound to this bot selects — so the agent's template tool-gate strips
 * it and the feature is silently dead for this bot.
 * Mirrors UnselectedEntitledSkill in api/src/modules/skill-coverage.ts.
 */
export interface UnselectedEntitledSkill {
  /** Entitlement key, e.g. 'leadCapture' — keys the `features.keys.*` labels. */
  feature: string;
  /** Skill id, e.g. 'lead_capture'. */
  skillId: string;
  /** Human skill label, e.g. 'Lead capture'. */
  skillName: string;
}

export interface ReadinessOverall {
  applicableCount: number;
  liveCount: number;
  allLive: boolean;
  nothingApplicable: boolean;
  botPaused: boolean;
  aiEnabled: boolean;
}

export interface BotReadinessResponse {
  /** The resolved bot id (the anchor when the request omitted `botId`). */
  botId: string;
  capabilities: ReadinessResult[];
  /** Entitled-but-undelivered features (see UnselectedEntitledSkill). Optional so
   *  a portal build newer than the API still renders the rest of the response. */
  unselectedEntitledSkills?: UnselectedEntitledSkill[];
  overall: ReadinessOverall;
}

/**
 * GET /bots/readiness — per-bot, per-capability readiness. Omit `botId` to
 * resolve the tenant's anchor bot. `enabled` lets callers defer the fetch
 * behind a feature flag / entitlement gate.
 */
export function useBotReadiness(botId?: string, opts: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: queryKeys.bots.readiness(botId),
    queryFn: () =>
      api.get<BotReadinessResponse>('/bots/readiness', {
        params: botId ? { botId } : undefined,
      }),
    enabled: opts.enabled ?? true,
  });
}
