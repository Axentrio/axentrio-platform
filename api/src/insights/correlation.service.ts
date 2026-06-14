/**
 * Correlation aggregation (P3 / ADR-0014, D2) — a FIXED curated set of
 * variable pairs, each a 2×2 contingency over the tenant's last 30 days,
 * gated by a rigorous multiplicity-corrected test:
 *   n ≥ 30 on each side · Fisher's exact · Bonferroni (p < 0.05/K) · |RR| ≥ 1.5
 * Survivors become `correlation` InsightExperiments (observations, never
 * resolvable). Phrasing is deterministic + NON-CAUSAL (D4): "X tends to go
 * with Y", never "X causes Y".
 */
import { AppDataSource } from '../database/data-source';
import { AvailabilityRule } from '../database/entities/AvailabilityRule';
import { InsightExperiment } from '../database/entities/InsightExperiment';
import { isWithinBusinessHours } from '../n8n/booking-providers/slot-engine';
import { fisherExactTwoSided, relativeRisk } from './stats/fisher';
import { logger } from '../utils/logger';

const WINDOW_DAYS = 30;
const N_FLOOR = 30; // per side
const EFFECT_HI = 1.5;
const EFFECT_LO = 0.67;
const ALPHA = 0.05;

interface SessionFact {
  id: string;
  botId: string | null;
  channel: string;
  startedAt: Date;
  status: string;
  messageCount: number;
  booked: boolean;
  hasLead: boolean;
  hitOpenGap: boolean;
}

/** A 2×2 candidate: rows = split (A / ¬A), cols = outcome (Y / ¬Y). */
interface Candidate {
  fingerprint: string;
  /** Human label of the split side A (e.g. "after hours", "WhatsApp"). */
  splitLabel: string;
  /** Human label of the outcome (e.g. "book", "convert"). */
  outcomeLabel: string;
  a: number; // A & Y
  b: number; // A & ¬Y
  c: number; // ¬A & Y
  d: number; // ¬A & ¬Y
}

function pct(n: number, total: number): number {
  return total === 0 ? 0 : Math.round((n / total) * 100);
}

export async function aggregateCorrelations(tenantId: string, now: Date): Promise<void> {
  const windowStart = new Date(now.getTime() - WINDOW_DAYS * 24 * 60 * 60 * 1000);

  const rows: Array<{
    id: string; botId: string | null; channel: string; startedAt: string;
    status: string; messageCount: number; booked: boolean; hasLead: boolean; hitOpenGap: boolean;
  }> = await AppDataSource.query(
    `SELECT s.id,
            s.bot_id AS "botId",
            s.channel,
            s.started_at AS "startedAt",
            s.status,
            s.message_count AS "messageCount",
            EXISTS (SELECT 1 FROM chatbot_bookings b
                    WHERE b.session_id = s.id AND b.status NOT IN ('cancelled','failed')) AS "booked",
            EXISTS (SELECT 1 FROM chatbot_leads l
                    WHERE l.session_id = s.id AND l.deleted_at IS NULL) AS "hasLead",
            EXISTS (SELECT 1 FROM chatbot_judgments j
                    JOIN chatbot_gaps g ON g.tenant_id = s.tenant_id
                                       AND g.canonical_topic_id = j.canonical_topic_id
                                       AND g.status = 'open'
                    WHERE j.session_id = s.id) AS "hitOpenGap"
     FROM chat_sessions s
     WHERE s.tenant_id = $1 AND s.started_at >= $2`,
    [tenantId, windowStart],
  );

  const facts: SessionFact[] = rows.map((r) => ({
    id: r.id,
    botId: r.botId,
    channel: r.channel || 'widget',
    startedAt: new Date(r.startedAt),
    status: r.status,
    messageCount: r.messageCount ?? 0,
    booked: r.booked,
    hasLead: r.hasLead,
    hitOpenGap: r.hitOpenGap,
  }));

  const candidates: Candidate[] = [];

  // ── Pair 1: after-hours ↔ booking. Needs business hours (P1.5 helper). ──
  const rules = await AppDataSource.getRepository(AvailabilityRule).find({ where: { tenantId } });
  if (rules.length > 0) {
    const byBot = new Map(rules.map((r) => [r.botId, r]));
    const fallback = rules.length === 1 ? rules[0] : null;
    const t = { a: 0, b: 0, c: 0, d: 0 };
    for (const f of facts) {
      const rule = (f.botId && byBot.get(f.botId)) || fallback;
      if (!rule) continue; // unclassifiable
      const afterHours = !isWithinBusinessHours(rule, f.startedAt);
      if (afterHours && f.booked) t.a++;
      else if (afterHours && !f.booked) t.b++;
      else if (!afterHours && f.booked) t.c++;
      else t.d++;
    }
    candidates.push({ fingerprint: 'afterhours:_:booking', splitLabel: 'after hours', outcomeLabel: 'book', ...t });
  }

  // ── Pair 2: channel ↔ conversion (booking OR lead). One test per channel. ──
  const channels = [...new Set(facts.map((f) => f.channel))];
  for (const ch of channels) {
    const t = { a: 0, b: 0, c: 0, d: 0 };
    for (const f of facts) {
      const isCh = f.channel === ch;
      const converted = f.booked || f.hasLead;
      if (isCh && converted) t.a++;
      else if (isCh && !converted) t.b++;
      else if (!isCh && converted) t.c++;
      else t.d++;
    }
    candidates.push({
      fingerprint: `channel-conv:${ch}:conversion`,
      splitLabel: channelLabel(ch),
      outcomeLabel: 'convert',
      ...t,
    });
  }

  // ── Pair 3: unresolved-gap ↔ abandonment. Skip if no open gaps in window. ──
  if (facts.some((f) => f.hitOpenGap)) {
    const median = medianMessageCount(facts);
    const t = { a: 0, b: 0, c: 0, d: 0 };
    for (const f of facts) {
      const abandoned =
        f.status === 'closed' && !f.booked && !f.hasLead && f.messageCount < median;
      if (f.hitOpenGap && abandoned) t.a++;
      else if (f.hitOpenGap && !abandoned) t.b++;
      else if (!f.hitOpenGap && abandoned) t.c++;
      else t.d++;
    }
    candidates.push({ fingerprint: 'gap-abandon:_:abandonment', splitLabel: 'unanswered topics', outcomeLabel: 'go unfinished', ...t });
  }

  // ── Gate: K = tests that meet the n-floor; Bonferroni over that family. ──
  const tested = candidates.filter((k) => k.a + k.b >= N_FLOOR && k.c + k.d >= N_FLOOR);
  const K = tested.length;
  const threshold = K > 0 ? ALPHA / K : ALPHA;

  const surviving = new Set<string>();
  for (const k of tested) {
    const p = fisherExactTwoSided(k.a, k.b, k.c, k.d);
    const rr = relativeRisk(k.a, k.b, k.c, k.d);
    if (rr === null) continue;
    if (p < threshold && (rr >= EFFECT_HI || rr <= EFFECT_LO)) {
      surviving.add(k.fingerprint);
      await upsertExperiment(tenantId, k, rr);
    }
  }

  // Prune correlations that no longer survive — keep dismissed rows.
  const existing = await AppDataSource.getRepository(InsightExperiment).find({
    where: { tenantId, kind: 'correlation' },
  });
  for (const e of existing) {
    if (!surviving.has(e.fingerprint) && e.state !== 'dismissed') {
      await AppDataSource.getRepository(InsightExperiment).remove(e);
    }
  }

  logger.info('[insights-correlation] aggregated', {
    tenantId,
    candidates: candidates.length,
    tested: K,
    surfaced: surviving.size,
  });
}

async function upsertExperiment(tenantId: string, k: Candidate, rr: number): Promise<void> {
  const repo = AppDataSource.getRepository(InsightExperiment);
  const rateA = pct(k.a, k.a + k.b);
  const rateNotA = pct(k.c, k.c + k.d);
  const direction = rr >= 1 ? 'more' : 'less';
  // Deterministic + NON-CAUSAL phrasing (D4): "tend to", never "because/causes".
  const title = `Chats ${k.splitLabel} tend to ${k.outcomeLabel} ${direction} often — ${rateA}% vs ${rateNotA}%`;
  const detail = `Worth a look — chats ${k.splitLabel} ${k.outcomeLabel} at ${rateA}% versus ${rateNotA}% otherwise. This is an observed pattern, not a proven cause.`;
  const severity = Math.abs(Math.log(rr)) >= Math.log(2) ? 'red' : 'orange';

  const existing = await repo.findOne({ where: { tenantId, kind: 'correlation', fingerprint: k.fingerprint } });
  const payload = { rateA, rateNotA, relativeRisk: Number(rr.toFixed(2)), a: k.a, b: k.b, c: k.c, d: k.d };
  if (existing) {
    existing.title = title;
    existing.detail = detail;
    existing.severity = severity;
    existing.payload = payload;
    existing.lastSeenAt = new Date();
    await repo.save(existing);
  } else {
    await repo.save(
      repo.create({
        tenantId, kind: 'correlation', fingerprint: k.fingerprint, severity,
        title, detail, payload, state: 'active', firstSeenAt: new Date(), lastSeenAt: new Date(),
      }),
    );
  }
}

function medianMessageCount(facts: SessionFact[]): number {
  if (facts.length === 0) return 0;
  const sorted = facts.map((f) => f.messageCount).sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function channelLabel(ch: string): string {
  const map: Record<string, string> = {
    widget: 'on the website widget',
    whatsapp: 'on WhatsApp',
    messenger: 'on Messenger',
    instagram: 'on Instagram',
    telegram: 'on Telegram',
  };
  return map[ch] ?? `on ${ch}`;
}
