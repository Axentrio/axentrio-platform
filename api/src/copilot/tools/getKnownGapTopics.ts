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
 * v1 reality: Insights v1 hasn't shipped. This tool always returns
 * "not deployed" until the Insights migrations land — at which point
 * the implementation queries the gap tables. The capability shape
 * doesn't change, only the data behind it.
 */
import type { CopilotTool, CopilotToolContext } from './types';

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
    'Return topics customers asked about that the bot could not satisfy (Insights v1 Gaps). Three states: not-deployed (sourceAvailable=false), deployed-but-empty (sourceAvailable=true, topics=[]), or deployed with topics. v1 reality: Insights not yet shipped — always returns sourceAvailable=false.',
  parameters: { type: 'object', properties: {}, additionalProperties: false },

  async execute(_args, ctx: CopilotToolContext): Promise<KnownGapTopicsResult> {
    // Detect Insights v1 deployment by probing for the canonical-topic
    // table. If absent, source is not available.
    //
    // We deliberately use a raw read here against `information_schema`
    // rather than feature-flag config — a feature flag could drift from
    // schema reality (flag on but migrations not yet applied), and the
    // schema is the ground truth.
    //
    // This is the ONE place a Copilot tool reads outside its
    // CopilotReadOnlyManager surface — and it reads metadata, not
    // tenant data. Once Insights v1 lands, the probe becomes a
    // simple ctx.manager.find call.
    const probe = await detectInsightsDeployment(ctx);
    if (!probe.deployed) {
      return { sourceAvailable: false, topics: [] };
    }

    // Insights v1 deployed → real query goes here. For now, no
    // canonical_topic table can be reached: returning the empty
    // "deployed but no data" state.
    return { sourceAvailable: true, topics: [] };
  },
};

async function detectInsightsDeployment(_ctx: CopilotToolContext): Promise<{ deployed: boolean }> {
  // v1 hard-codes false because the migrations for Insights don't
  // exist yet. When they land, this function gets a CopilotReadOnly-
  // Manager-friendly probe (e.g. count() against the canonical-topic
  // table behind a try/catch that interprets the missing-table error
  // as "not deployed").
  return { deployed: false };
}
