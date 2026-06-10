/**
 * Copilot tool: getLeadStats
 *
 * Aggregate lead counts for the tenant. Drives questions like:
 *   - "How many leads have I captured?"
 *   - "How many leads this week?"
 *   - "Where are my leads coming from?"
 *
 * Returns ONLY aggregate counts — no names, emails, phones, notes,
 * timestamps of specific leads, or custom fields (per invariant #8).
 *
 * `bySource` is exhaustive and zero-filled across every known
 * source so the LLM never misreads absence as "unknown."
 */
import { IsNull, MoreThanOrEqual } from 'typeorm';
import { Lead, type LeadSource } from '../../database/entities/Lead';
import type { CopilotTool, CopilotToolContext } from './types';

export interface LeadStatsResult {
  totalCount: number;
  last7Days: number;
  last30Days: number;
  bySource: Record<LeadSource, number>;
}

const KNOWN_SOURCES: readonly LeadSource[] = ['tool', 'manual', 'import', 'webhook'];

export const getLeadStats: CopilotTool<Record<string, never>, LeadStatsResult> = {
  name: 'getLeadStats',
  description:
    'Return aggregate lead counts for the current tenant: totalCount, last7Days, last30Days, and bySource breakdown (tool/manual/import/webhook). No names, emails, phones, or other PII — counts only.',
  parameters: { type: 'object', properties: {}, additionalProperties: false },

  async execute(_args, ctx: CopilotToolContext): Promise<LeadStatsResult> {
    const now = Date.now();
    const sevenDaysAgo = new Date(now - 7 * 24 * 60 * 60 * 1000);
    const thirtyDaysAgo = new Date(now - 30 * 24 * 60 * 60 * 1000);

    const [totalCount, last7Days, last30Days, sourceRows] = await Promise.all([
      ctx.manager.count(Lead, {
        where: { tenantId: ctx.tenantId, deletedAt: IsNull() },
      }),
      ctx.manager.count(Lead, {
        where: {
          tenantId: ctx.tenantId,
          deletedAt: IsNull(),
          createdAt: MoreThanOrEqual(sevenDaysAgo),
        },
      }),
      ctx.manager.count(Lead, {
        where: {
          tenantId: ctx.tenantId,
          deletedAt: IsNull(),
          createdAt: MoreThanOrEqual(thirtyDaysAgo),
        },
      }),
      Promise.all(
        KNOWN_SOURCES.map(async (source) => ({
          source,
          count: await ctx.manager.count(Lead, {
            where: { tenantId: ctx.tenantId, deletedAt: IsNull(), source },
          }),
        })),
      ),
    ]);

    const bySource: LeadStatsResult['bySource'] = {
      channel: 0,
      tool: 0,
      booking: 0,
      manual: 0,
      import: 0,
      webhook: 0,
    };
    for (const { source, count } of sourceRows) {
      bySource[source] = count;
    }

    return { totalCount, last7Days, last30Days, bySource };
  },
};
