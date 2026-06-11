/**
 * Copilot tool: getKnownGapTopics
 *
 * Surfaces Insights v1 Gap data — topics customers asked about that
 * the bot couldn't satisfy. Three return states (round 1 #19):
 *
 *  - **Not deployed:** `{ sourceAvailable: false, topics: [] }`
 *    Insights v1 module is absent (no `chatbot_insights` /
 *    `chatbot_gaps` / `chatbot_canonical_topics` tables in the
 *    DB yet). The prompt template handles this with "I can't
 *    access Gap data on this account."
 *
 *  - **Deployed, no data:** `{ sourceAvailable: true, topics: [] }`
 *    Module present, no Gaps detected for this tenant.
 *
 *  - **Query error:** throws `CopilotToolFailedError`. Agent loop
 *    catches, emits `tool_call_end` with `outcome: 'error'`, prompt
 *    template handles gracefully.
 *
 * Insights v1 shipped 2026-06-11 (migration 1786000000000): this tool
 * queries the real gap tables. "Not deployed" survives only as the
 * missing-table fallback during a pre-migration deploy window.
 */
import type { CopilotTool, CopilotToolContext } from './types';
import { Gap } from '../../database/entities/Gap';
import { CanonicalTopic } from '../../database/entities/CanonicalTopic';

export type GapSeverity = 'red' | 'orange' | 'green';

export interface KnownGapTopic {
  canonicalTopic: string;
  occurrences: number;
  severity: GapSeverity;
}

export interface KnownGapTopicsResult {
  sourceAvailable: boolean;
  topics: KnownGapTopic[];
}

export const getKnownGapTopics: CopilotTool<Record<string, never>, KnownGapTopicsResult> = {
  name: 'getKnownGapTopics',
  description:
    'Return topics customers asked about that the bot could not satisfy (Insights v1 Gaps). Three states: not-deployed (sourceAvailable=false), deployed-but-empty (sourceAvailable=true, topics=[]), or deployed with topics.',
  parameters: { type: 'object', properties: {}, additionalProperties: false },

  async execute(_args, ctx: CopilotToolContext): Promise<KnownGapTopicsResult> {
    // Insights v1 shipped (migration 1786000000000-CreateInsightsTables).
    // The probe is now the originally-planned CopilotReadOnlyManager call:
    // a missing-table error (pre-migration deploy window) reads as
    // "not deployed" rather than crashing the Copilot turn.
    let gaps: Gap[];
    try {
      gaps = await ctx.manager.find(Gap, {
        where: { tenantId: ctx.tenantId, status: 'open' },
        order: { distinctVisitors: 'DESC' },
        take: 20,
      });
    } catch {
      return { sourceAvailable: false, topics: [] };
    }

    if (gaps.length === 0) return { sourceAvailable: true, topics: [] };

    const topics = await ctx.manager.find(CanonicalTopic, {
      where: { tenantId: ctx.tenantId },
    });
    const topicById = new Map(topics.map((t) => [t.id, t.topic]));

    return {
      sourceAvailable: true,
      topics: gaps.map((g) => ({
        canonicalTopic: topicById.get(g.canonicalTopicId) ?? 'unknown topic',
        occurrences: g.occurrences,
        severity: g.severity as GapSeverity,
      })),
    };
  },
};
