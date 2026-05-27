/**
 * Copilot tool: getRecentChatSessionStats
 *
 * Aggregate chat-session metrics for the last 7 days plus an
 * "active now" count. Drives questions like:
 *   - "How many chats this week?"
 *   - "Is anyone using my bot right now?"
 *   - "What's my average first-response time?"
 *
 * Returns COUNTS + AVERAGES — no transcripts, no visitor IDs, no
 * raw timestamps of specific sessions (per invariant #8).
 *
 * `byChannel` and `byStatus` are exhaustive + zero-filled. The LLM
 * never gets a sparse map and never has to infer missing keys.
 *
 * `activeNowCount`: sessions where `status='active'` AND
 * `last_activity_at > now() - 15 minutes`.
 */
import { IsNull, MoreThanOrEqual, And } from 'typeorm';
import {
  ChatSession,
  type SessionStatus,
} from '../../database/entities/ChatSession';
import type { CopilotTool, CopilotToolContext } from './types';

type CopilotChannelKey = 'widget' | 'facebook' | 'instagram' | 'telegram' | 'whatsapp';

export interface RecentChatSessionStatsResult {
  last7Days: {
    total: number;
    byChannel: Record<CopilotChannelKey, number>;
    byStatus: Record<SessionStatus, number>;
  };
  avgFirstResponseMinutes: number | null;
  activeNowCount: number;
}

const SCHEMA_CHANNELS = ['widget', 'messenger', 'instagram', 'telegram', 'whatsapp'] as const;
const SESSION_STATUSES: readonly SessionStatus[] = [
  'active',
  'closed',
  'waiting',
  'handoff',
  'bot',
];

function copilotChannel(c: (typeof SCHEMA_CHANNELS)[number]): CopilotChannelKey {
  return c === 'messenger' ? 'facebook' : c;
}

export const getRecentChatSessionStats: CopilotTool<
  Record<string, never>,
  RecentChatSessionStatsResult
> = {
  name: 'getRecentChatSessionStats',
  description:
    'Return aggregate chat-session metrics for the current tenant: last 7 days total + byChannel + byStatus breakdowns, avgFirstResponseMinutes, and activeNowCount (status=active and last activity in last 15 min). No transcripts, no visitor IDs — counts and averages only.',
  parameters: { type: 'object', properties: {}, additionalProperties: false },

  async execute(_args, ctx: CopilotToolContext): Promise<RecentChatSessionStatsResult> {
    const now = Date.now();
    const sevenDaysAgo = new Date(now - 7 * 24 * 60 * 60 * 1000);
    const fifteenMinAgo = new Date(now - 15 * 60 * 1000);

    const byChannel: Record<CopilotChannelKey, number> = {
      widget: 0,
      facebook: 0,
      instagram: 0,
      telegram: 0,
      whatsapp: 0,
    };
    const byStatus: Record<SessionStatus, number> = {
      active: 0,
      closed: 0,
      waiting: 0,
      handoff: 0,
      bot: 0,
    };

    const [total, channelCounts, statusCounts, activeNowCount, sessionsForAvg] = await Promise.all([
      ctx.manager.count(ChatSession, {
        where: {
          tenantId: ctx.tenantId,
          deletedAt: IsNull(),
          startedAt: MoreThanOrEqual(sevenDaysAgo),
        },
      }),
      Promise.all(
        SCHEMA_CHANNELS.map(async (c) => ({
          channel: c,
          count: await ctx.manager.count(ChatSession, {
            where: {
              tenantId: ctx.tenantId,
              deletedAt: IsNull(),
              startedAt: MoreThanOrEqual(sevenDaysAgo),
              channel: c,
            },
          }),
        })),
      ),
      Promise.all(
        SESSION_STATUSES.map(async (s) => ({
          status: s,
          count: await ctx.manager.count(ChatSession, {
            where: {
              tenantId: ctx.tenantId,
              deletedAt: IsNull(),
              startedAt: MoreThanOrEqual(sevenDaysAgo),
              status: s,
            },
          }),
        })),
      ),
      ctx.manager.count(ChatSession, {
        where: {
          tenantId: ctx.tenantId,
          deletedAt: IsNull(),
          status: 'active',
          lastActivityAt: MoreThanOrEqual(fifteenMinAgo),
        },
      }),
      ctx.manager.find(ChatSession, {
        where: {
          tenantId: ctx.tenantId,
          deletedAt: IsNull(),
          startedAt: MoreThanOrEqual(sevenDaysAgo),
        },
        select: ['id', 'firstResponseTimeSeconds'],
      }),
    ]);

    for (const { channel, count } of channelCounts) {
      byChannel[copilotChannel(channel)] = count;
    }
    for (const { status, count } of statusCounts) {
      byStatus[status] = count;
    }

    // Average first-response time across the last-7-day window, in minutes.
    // Sessions with no recorded first-response are excluded (handoff-only,
    // bot-only, etc). Returns null when there are zero usable rows.
    const responseTimes = sessionsForAvg
      .map((s) => s.firstResponseTimeSeconds)
      .filter((n): n is number => typeof n === 'number' && n >= 0);
    const avgFirstResponseMinutes: number | null =
      responseTimes.length === 0
        ? null
        : Math.round((responseTimes.reduce((a, b) => a + b, 0) / responseTimes.length / 60) * 10) /
          10;

    return {
      last7Days: { total, byChannel, byStatus },
      avgFirstResponseMinutes,
      activeNowCount,
    };
  },
};

// Suppress unused-import lint for And — kept available for future
// composite filters without re-importing per file.
void And;
