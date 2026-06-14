/**
 * Weekly digest generation (P3 / ADR-0014, D6) — Enterprise-only.
 *
 * Once a week (Monday nightly) we summarize the COMPLETE week that just ended:
 * a structured header (outcomes vs the prior week + gap movements) and a short
 * LLM narrative. The row is upserted idempotently on (tenant, weekStart) and
 * IS the email outbox — see digest-send.service for the claim-based reconciler.
 *
 * Generation never sends. It only writes the row in `pending` (when the tenant
 * wants the email) or `skipped` (opted out), so the surface always has a digest
 * to show in-app regardless of email preference.
 */
import { AppDataSource } from '../database/data-source';
import { Tenant } from '../database/entities/Tenant';
import { InsightDigest } from '../database/entities/InsightDigest';
import { InsightExperiment } from '../database/entities/InsightExperiment';
import { getProvider } from '../llm/provider-factory';
import { DEFAULT_PROVIDER, DEFAULT_MODEL } from '../llm/defaults';
import { logger } from '../utils/logger';
import type { DigestMetrics } from '../contracts/insights';

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The Monday (00:00 UTC) that begins the COMPLETE week summarized by a run at
 * `now` — i.e. the week ending on the most recent Monday. A Monday-night run on
 * Jun 15 summarizes [Jun 8, Jun 15). Returned as a YYYY-MM-DD date string.
 */
export function weekStartFor(now: Date): string {
  const midnight = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const daysSinceMonday = (midnight.getUTCDay() + 6) % 7; // Mon=0 … Sun=6
  const thisMonday = new Date(midnight.getTime() - daysSinceMonday * 24 * 60 * 60 * 1000);
  const summarizedMonday = new Date(thisMonday.getTime() - WEEK_MS);
  return summarizedMonday.toISOString().slice(0, 10);
}

/** Default-ON: only an explicit `false` opts the tenant out of the email. */
export function digestEmailEnabled(tenant: Pick<Tenant, 'settings'>): boolean {
  return tenant.settings?.insights?.digestEmail !== false;
}

async function countSince(sql: string, params: unknown[]): Promise<number> {
  const [row] = await AppDataSource.query(sql, params);
  return Number(row?.count ?? 0);
}

async function computeMetrics(tenantId: string, weekStart: Date): Promise<DigestMetrics> {
  const weekEnd = new Date(weekStart.getTime() + WEEK_MS);
  const prevStart = new Date(weekStart.getTime() - WEEK_MS);

  const convoSql = `SELECT COUNT(*)::int AS count FROM chat_sessions
                    WHERE tenant_id = $1 AND created_at >= $2 AND created_at < $3`;
  const bookingSql = `SELECT COUNT(*)::int AS count FROM chatbot_bookings
                      WHERE tenant_id = $1 AND status NOT IN ('cancelled','failed')
                        AND created_at >= $2 AND created_at < $3`;
  const leadSql = `SELECT COUNT(*)::int AS count FROM chatbot_leads
                   WHERE tenant_id = $1 AND deleted_at IS NULL
                     AND created_at >= $2 AND created_at < $3`;

  const [
    conversations, convPrev,
    bookings, bookPrev,
    leads, leadPrev,
    gapsOpened, gapsWon,
  ] = await Promise.all([
    countSince(convoSql, [tenantId, weekStart, weekEnd]),
    countSince(convoSql, [tenantId, prevStart, weekStart]),
    countSince(bookingSql, [tenantId, weekStart, weekEnd]),
    countSince(bookingSql, [tenantId, prevStart, weekStart]),
    countSince(leadSql, [tenantId, weekStart, weekEnd]),
    countSince(leadSql, [tenantId, prevStart, weekStart]),
    countSince(
      `SELECT COUNT(*)::int AS count FROM chatbot_gaps
       WHERE tenant_id = $1 AND first_detected_at >= $2 AND first_detected_at < $3`,
      [tenantId, weekStart, weekEnd],
    ),
    countSince(
      `SELECT COUNT(*)::int AS count FROM chatbot_gaps
       WHERE tenant_id = $1 AND status IN ('resolved_data','resolved_manual')
         AND resolved_at >= $2 AND resolved_at < $3`,
      [tenantId, weekStart, weekEnd],
    ),
  ]);

  return {
    conversations: { current: conversations, previous: convPrev },
    bookings: { current: bookings, previous: bookPrev },
    leads: { current: leads, previous: leadPrev },
    gapsOpened,
    gapsWon,
  };
}

function deltaPhrase(label: string, current: number, previous: number): string {
  if (previous === 0) return `${current} ${label}`;
  const pct = Math.round(((current - previous) / previous) * 100);
  const dir = pct > 0 ? 'up' : pct < 0 ? 'down' : 'flat';
  return `${current} ${label} (${dir === 'flat' ? 'flat' : `${dir} ${Math.abs(pct)}%`} vs prior week)`;
}

/**
 * A grounded 2–3 sentence narrative. The LLM only phrases numbers we computed —
 * it is never asked to infer causation (ADR-0014 D4). Falls back to a plain
 * deterministic summary if the model call fails, so generation never throws.
 */
async function narrate(metrics: DigestMetrics, topExperiment: string | null): Promise<string> {
  const facts = [
    deltaPhrase('conversations', metrics.conversations.current, metrics.conversations.previous),
    deltaPhrase('bookings', metrics.bookings.current, metrics.bookings.previous),
    deltaPhrase('leads', metrics.leads.current, metrics.leads.previous),
    `${metrics.gapsOpened} new unanswered topics, ${metrics.gapsWon} resolved`,
    topExperiment ? `notable pattern: ${topExperiment}` : null,
  ].filter(Boolean).join('; ');

  const deterministic =
    `This week: ${facts}. These are observed figures, not predictions.`;

  try {
    const provider = getProvider(DEFAULT_PROVIDER);
    const response = await provider.chat(
      [
        {
          role: 'system',
          content:
            'You write a 2–3 sentence weekly business summary for a small-business owner from the figures provided. ' +
            'Warm, plain English. Use ONLY the figures given — never invent numbers, never claim one thing caused another. ' +
            'No greeting, no sign-off, no markdown headers.',
        },
        { role: 'user', content: facts },
      ],
      { model: DEFAULT_MODEL, maxTokens: 200, temperature: 0.3, jsonMode: false },
    );
    const text = response.content?.trim();
    return text && text.length > 0 ? text : deterministic;
  } catch (err) {
    logger.warn('[insights-digest] narrative LLM failed, using deterministic summary', {
      error: err instanceof Error ? err.message : 'unknown',
    });
    return deterministic;
  }
}

/**
 * Generate (or refresh) the digest for the week ending at `now`'s most recent
 * Monday. Idempotent: re-running overwrites the SAME (tenant, weekStart) row's
 * content but never resets a row that has already been sent.
 */
export async function generateDigest(tenantId: string, now: Date): Promise<void> {
  const weekStartStr = weekStartFor(now);
  const weekStart = new Date(`${weekStartStr}T00:00:00.000Z`);

  const metrics = await computeMetrics(tenantId, weekStart);

  const topExp = await AppDataSource.getRepository(InsightExperiment).findOne({
    where: { tenantId, state: 'active' },
    order: { severity: 'ASC', lastSeenAt: 'DESC' },
  });
  const summaryMd = await narrate(metrics, topExp?.title ?? null);

  const tenant = await AppDataSource.getRepository(Tenant).findOne({
    where: { id: tenantId },
    select: ['id', 'settings'],
  });
  const wantsEmail = tenant ? digestEmailEnabled(tenant) : true;

  const repo = AppDataSource.getRepository(InsightDigest);
  const existing = await repo.findOne({ where: { tenantId, weekStart: weekStartStr } });

  if (existing) {
    // Refresh content; never disturb a digest already in flight or sent.
    existing.summaryMd = summaryMd;
    existing.metrics = metrics as unknown as Record<string, unknown>;
    if (existing.sendState === 'pending' || existing.sendState === 'skipped') {
      existing.sendState = wantsEmail ? 'pending' : 'skipped';
      existing.sendNextAttemptAt = wantsEmail ? now : null;
    }
    await repo.save(existing);
  } else {
    await repo.save(
      repo.create({
        tenantId,
        weekStart: weekStartStr,
        summaryMd,
        metrics: metrics as unknown as Record<string, unknown>,
        sendState: wantsEmail ? 'pending' : 'skipped',
        sendNextAttemptAt: wantsEmail ? now : null,
        sendAttempts: 0,
      }),
    );
  }

  logger.info('[insights-digest] generated', { tenantId, weekStart: weekStartStr, wantsEmail });
}
