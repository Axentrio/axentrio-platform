/**
 * Lead demand — Story 3's Enterprise "AI Lead Intelligence".
 *
 * The story asks for statements like "Most plumbing leads this week are related to
 * blocked drains." Two decisions shape this file:
 *
 * **1. It is a DESCRIPTIVE frequency, not an inferential experiment.**
 * It deliberately does NOT become a new `chatbot_insight_experiments` kind. That table
 * is for hypotheses that passed a significance + effect-size bar (Fisher, Bonferroni),
 * and it is CHECK-constrained to `correlation|sentiment` precisely so a count cannot be
 * dressed up as a finding. "24 of your 60 leads asked for drain unblocking" is a fact
 * about a denominator, not evidence of anything, and it is presented that way.
 *
 * **2. It is sourced from FACTS first, inference second.**
 * The primary signal is the requested service on the lead's booking, joined to the
 * tenant's own service catalogue — deterministic, available today, and true whether or
 * not Release B's LLM enrichment is switched on. Extracted tags/problem types are added
 * as a secondary view and clearly separated, because they are inferred and may be absent
 * for most rows (the extractor is fail-closed and abstains often, by design).
 *
 * Every response carries its denominator and a suppression flag. An SMB with four leads
 * must be told "not enough data yet", not shown "100% of your leads want X".
 */
import { AppDataSource } from '../database/data-source';

/** Below this, proportions are noise and are suppressed rather than displayed. */
export const MIN_LEADS_FOR_DEMAND = 5;
/** A single label needs this many distinct leads before it is worth naming. */
export const MIN_DISTINCT_PER_LABEL = 3;

export interface DemandSlice {
  label: string;
  leads: number;
  /** Share of CLASSIFIED leads, 0..1. Never of total — see `classifiedLeads`. */
  share: number;
}

export interface LeadDemandResult {
  window: { from: string; to: string; days: number };
  /** Every non-erased lead captured in the window. */
  totalLeads: number;
  /**
   * Leads we could attribute to a service. The honest denominator for `topServices` —
   * quoting a share of `totalLeads` would understate every figure, and quoting one
   * without publishing this number would overstate our confidence.
   */
  classifiedLeads: number;
  topServices: DemandSlice[];
  /** Secondary, INFERRED view. Empty unless enrichment has run. */
  topTags: DemandSlice[];
  taggedLeads: number;
  byUrgency: { emergency: number; urgent: number; routine: number; unknown: number };
  /** True when there is too little data to say anything responsibly. */
  suppressed: boolean;
  suppressionReason: string | null;
}

function share(n: number, of: number): number {
  return of > 0 ? Math.round((n / of) * 1000) / 1000 : 0;
}

/**
 * Aggregate demand for one tenant over a window.
 *
 * Reads only non-erased leads. Cancelled bookings still count toward demand: the
 * customer asked for that service, which is what "demand" means — whether it converted
 * is a different question the outcomes timeseries already answers.
 */
export async function aggregateLeadDemand(
  tenantId: string,
  windowDays: number,
  now: Date = new Date(),
): Promise<LeadDemandResult> {
  const to = now;
  const from = new Date(now.getTime() - windowDays * 86_400_000);
  const win = { from: from.toISOString(), to: to.toISOString(), days: windowDays };

  const [{ total }]: Array<{ total: number }> = await AppDataSource.query(
    `SELECT count(*)::int AS total
       FROM chatbot_leads
      WHERE tenant_id = $1 AND deleted_at IS NULL
        AND created_at >= $2 AND created_at < $3`,
    [tenantId, from, to],
  );

  if (total < MIN_LEADS_FOR_DEMAND) {
    return {
      window: win,
      totalLeads: total,
      classifiedLeads: 0,
      topServices: [],
      topTags: [],
      taggedLeads: 0,
      byUrgency: { emergency: 0, urgent: 0, routine: 0, unknown: total },
      suppressed: true,
      suppressionReason: `Not enough leads yet (${total} in the last ${windowDays} days; need ${MIN_LEADS_FOR_DEMAND}).`,
    };
  }

  // PRIMARY signal: the service the customer actually booked/requested. DISTINCT on
  // lead so a customer with three bookings for one service counts once — otherwise a
  // single indecisive customer would dominate the tenant's "demand".
  const serviceRows: Array<{ label: string; leads: number }> = await AppDataSource.query(
    `SELECT st.name AS label, count(DISTINCT l.id)::int AS leads
       FROM chatbot_leads l
       JOIN chatbot_bookings b ON b.lead_id = l.id AND b.tenant_id = l.tenant_id
       JOIN chatbot_service_types st ON st.id = b.event_type_id
      WHERE l.tenant_id = $1 AND l.deleted_at IS NULL
        AND l.created_at >= $2 AND l.created_at < $3
      GROUP BY st.name
      ORDER BY leads DESC, st.name ASC`,
    [tenantId, from, to],
  );

  const [{ classified }]: Array<{ classified: number }> = await AppDataSource.query(
    `SELECT count(DISTINCT l.id)::int AS classified
       FROM chatbot_leads l
       JOIN chatbot_bookings b ON b.lead_id = l.id AND b.tenant_id = l.tenant_id
       JOIN chatbot_service_types st ON st.id = b.event_type_id
      WHERE l.tenant_id = $1 AND l.deleted_at IS NULL
        AND l.created_at >= $2 AND l.created_at < $3`,
    [tenantId, from, to],
  );

  // SECONDARY, inferred: extracted tags. Sparse by design — the extractor abstains
  // whenever grounding fails, and it is default-OFF — so this is reported separately
  // with its own denominator rather than blended into the service figures.
  const tagRows: Array<{ label: string; leads: number }> = await AppDataSource.query(
    `SELECT tag AS label, count(DISTINCT lc.lead_id)::int AS leads
       FROM chatbot_lead_conversations lc
       JOIN chatbot_leads l ON l.id = lc.lead_id AND l.deleted_at IS NULL
       CROSS JOIN LATERAL unnest(COALESCE(lc.tags, ARRAY[]::text[])) AS tag
      WHERE lc.tenant_id = $1
        AND l.created_at >= $2 AND l.created_at < $3
      GROUP BY tag
      ORDER BY leads DESC, tag ASC`,
    [tenantId, from, to],
  );

  const [{ tagged }]: Array<{ tagged: number }> = await AppDataSource.query(
    `SELECT count(DISTINCT lc.lead_id)::int AS tagged
       FROM chatbot_lead_conversations lc
       JOIN chatbot_leads l ON l.id = lc.lead_id AND l.deleted_at IS NULL
      WHERE lc.tenant_id = $1 AND lc.tags IS NOT NULL AND array_length(lc.tags, 1) > 0
        AND l.created_at >= $2 AND l.created_at < $3`,
    [tenantId, from, to],
  );

  const urgencyRows: Array<{ urgency: string | null; leads: number }> = await AppDataSource.query(
    `SELECT lc.urgency, count(DISTINCT lc.lead_id)::int AS leads
       FROM chatbot_lead_conversations lc
       JOIN chatbot_leads l ON l.id = lc.lead_id AND l.deleted_at IS NULL
      WHERE lc.tenant_id = $1
        AND l.created_at >= $2 AND l.created_at < $3
      GROUP BY lc.urgency`,
    [tenantId, from, to],
  );

  const byUrgency = { emergency: 0, urgent: 0, routine: 0, unknown: 0 };
  let urgencyKnown = 0;
  for (const r of urgencyRows) {
    if (r.urgency === 'emergency' || r.urgency === 'urgent' || r.urgency === 'routine') {
      byUrgency[r.urgency] = r.leads;
      urgencyKnown += r.leads;
    }
  }
  byUrgency.unknown = Math.max(0, total - urgencyKnown);

  // Only name a label backed by enough distinct leads. A one-off request is not demand.
  const keep = (rows: Array<{ label: string; leads: number }>, denom: number) =>
    rows
      .filter((r) => r.leads >= MIN_DISTINCT_PER_LABEL)
      .slice(0, 8)
      .map((r) => ({ label: r.label, leads: r.leads, share: share(r.leads, denom) }));

  return {
    window: win,
    totalLeads: total,
    classifiedLeads: classified,
    topServices: keep(serviceRows, classified),
    topTags: keep(tagRows, tagged),
    taggedLeads: tagged,
    byUrgency,
    suppressed: false,
    suppressionReason: null,
  };
}
