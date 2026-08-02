/**
 * Repeat-customer detection — the nightly identity-resolution pass.
 *
 * The problem it solves is structural, not a bug: `chatbot_leads` holds one row per
 * IDENTITY (`dedupe_key` = channel handle, else email, else phone), so the same human
 * on WhatsApp and later in the widget owns two rows. Every counter that lives on a row
 * therefore counts a HANDLE, not a person, and undercounts exactly the returning
 * customers the feature is meant to find. `person_key` is the grouping key that spans
 * the rows; this pass computes it and caches the group's answer onto each member.
 *
 * Four decisions carry the design:
 *
 * **1. Recompute in full, every run.** `person_key` is a pure function of two columns
 * and the aggregates are a pure function of the live rows carrying a key, so a full
 * pass is self-healing: a bad row, a missed write or a rule change is corrected by the
 * next run with no repair script. An incremental watermark would need a dirty-key set
 * (a new row joining an existing person changes every other member's counts) for no
 * measurable win at SMB lead volumes. The per-tenant cap below is a guard rail against
 * a pathological tenant, not a policy.
 *
 * **2. Only this file writes the five `person_*` columns.** The capture path is
 * deliberately not a second writer: `upsertLead`'s `ON CONFLICT DO UPDATE` COALESCEs
 * phone and email, so the identity of the row AFTER the merge is not the identity the
 * caller passed in, and a key computed from the input would disagree with the row it
 * sits on. One writer means one implementation of the identity rule and nothing to keep
 * in step. The cost is up to a day of latency on a brand-new lead, which is acceptable
 * for a property that is historical by definition and triggers nothing automatically.
 *
 * **3. Every statement is tenant-scoped, and the grouping happens INSIDE that scope.**
 * Two tenants whose customers share a phone number are two different people as far as
 * this platform is concerned; a `GROUP BY person_key` that forgot the tenant predicate
 * would show one tenant another tenant's customer history.
 *
 * **4. Erased rows are invisible here.** Filtered on `deleted_at IS NULL` AND on the
 * `erased:` tombstone namespace — two independent conditions, because a person who
 * exercised Art 17 must not be counted, grouped, or made to raise someone else's
 * repeat count. `eraseLead` additionally clears the erased row's own `person_*`
 * columns, so nothing survives on the husk.
 *
 * Idempotent by construction: both write steps only touch rows whose value actually
 * changes, so a second run in the same night updates zero rows.
 */
import { AppDataSource } from '../database/data-source';
import { getEntitlements } from '../billing/entitlements';
import { computePersonKey } from './person-key';
import { ERASED_PREFIX } from './lead-tombstone';
import { returningRows } from '../utils/raw-sql';
import { logger } from '../utils/logger';

/**
 * Rows keyed per tenant per run. High enough that no real tenant reaches it — it exists
 * so one tenant with a pathological lead table cannot monopolise a run that every other
 * tenant is waiting behind. Exported so the boundary can be tested without seeding 50k
 * rows; production never passes an override.
 */
export const MAX_LEADS_PER_TENANT_PER_RUN = 50_000;

let running = false;

export interface RepeatSweepResult {
  /** Tenants that had live leads AND the entitlement. */
  tenantsConsidered: number;
  /** Rows whose `person_key` changed — 0 on a steady-state re-run. */
  keysWritten: number;
  /** Rows whose cached aggregates changed — 0 on a steady-state re-run. */
  aggregatesWritten: number;
  /** Tenants whose lead table exceeded the per-run cap. */
  tenantsCapped: number;
}

/**
 * Group live leads by person and cache the answer on every row of the group.
 *
 * Sequential across tenants on purpose: this is a background pass competing with live
 * traffic for the same connection pool, and there is no deadline on it.
 */
export async function sweepRepeatCustomers(
  opts: { batchLimit?: number } = {},
): Promise<RepeatSweepResult> {
  const batchLimit = opts.batchLimit ?? MAX_LEADS_PER_TENANT_PER_RUN;
  const result: RepeatSweepResult = {
    tenantsConsidered: 0,
    keysWritten: 0,
    aggregatesWritten: 0,
    tenantsCapped: 0,
  };
  // Re-entrancy guard, matching the retention sweep: a run that outlasts its interval
  // must not overlap itself and write the same rows twice.
  if (running) return result;
  running = true;

  try {
    // Only tenants that actually have leads. The EXISTS semi-join keeps a platform full
    // of tenants who never enabled lead capture off the hot path entirely — the
    // alternative (iterate every tenant, ask entitlements, query) pays a round trip per
    // tenant to learn there is nothing to do.
    const tenants: Array<{ id: string }> = await AppDataSource.query(
      `SELECT t.id
         FROM tenants t
        WHERE t.status <> 'suspended'
          AND EXISTS (
            SELECT 1 FROM chatbot_leads l
             WHERE l.tenant_id = t.id AND l.deleted_at IS NULL
          )`,
    );

    for (const tenant of tenants) {
      // Gated on `leadEnrichment` — the flag that already governs every DERIVED lead
      // field (`wide` in leads.routes.ts). Repeat detection is listed under Enterprise
      // in the epic, but the readiness score from the same slice shipped on this flag
      // and the leads list gates its whole derived block on it: computing a value the
      // read path will not expose, or minting a third lead flag for one boolean, both
      // make the tier story harder to reason about than following the precedent.
      // Fail closed — an entitlement lookup we cannot complete is not a licence to run.
      let entitled = false;
      try {
        entitled = (await getEntitlements(tenant.id)).features.leadEnrichment === true;
      } catch (error) {
        logger.warn('[lead-repeat] entitlement resolution failed — skipping tenant', {
          tenantId: tenant.id,
          error: error instanceof Error ? error.message : String(error),
        });
        continue;
      }
      if (!entitled) continue;
      result.tenantsConsidered += 1;

      try {
        const perTenant = await sweepTenant(tenant.id, batchLimit);
        result.keysWritten += perTenant.keysWritten;
        result.aggregatesWritten += perTenant.aggregatesWritten;
        if (perTenant.capped) result.tenantsCapped += 1;
      } catch (error) {
        // One tenant's failure must not abandon the rest of the platform's run.
        logger.error('[lead-repeat] tenant sweep failed', {
          tenantId: tenant.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (result.tenantsConsidered > 0) {
      logger.info('[lead-repeat] sweep complete', result);
    }
    return result;
  } finally {
    running = false;
  }
}

/**
 * One tenant's pass. Exported so tests can exercise a single tenant in isolation.
 *
 * It does NOT check the entitlement — that gate belongs to `sweepRepeatCustomers`,
 * which is the only production caller. Anything else that reaches for this function
 * has to apply the gate itself.
 */
export async function sweepTenant(
  tenantId: string,
  batchLimit = MAX_LEADS_PER_TENANT_PER_RUN,
): Promise<{ keysWritten: number; aggregatesWritten: number; capped: boolean }> {
  // ── 1. Assign keys ────────────────────────────────────────────────────────
  // The rule lives in TypeScript (`computePersonKey`) and is read back here rather
  // than re-expressed in SQL. Two implementations of "is this the same person" is the
  // one drift this feature cannot survive: a divergence merges people who are not the
  // same, which is the failure the whole design is ordered around avoiding.
  const rows: Array<{ id: string; phone: string | null; email: string | null; person_key: string | null }> =
    await AppDataSource.query(
      `SELECT id, phone, email, person_key
         FROM chatbot_leads
        WHERE tenant_id = $1
          AND deleted_at IS NULL
          -- Belt-and-braces on erasure: the tombstone namespace is excluded on its own
          -- merit, not only via deleted_at, so a husk that somehow kept a NULL
          -- deleted_at still cannot be grouped or counted.
          AND COALESCE(dedupe_key, '') NOT LIKE $2
        ORDER BY created_at ASC, id ASC
        LIMIT $3`,
      [tenantId, `${ERASED_PREFIX}%`, batchLimit],
    );
  const capped = rows.length >= batchLimit;
  if (capped) {
    logger.warn('[lead-repeat] tenant hit the per-run lead cap — counts may lag', {
      tenantId,
      batchLimit,
    });
  }

  // Only rows whose key actually MOVED are written. This is what makes a second run
  // in the same night cost zero writes, and it keeps the WAL quiet on a table that is
  // read on every page of the leads inbox.
  const changedIds: string[] = [];
  const changedKeys: Array<string | null> = [];
  for (const row of rows) {
    const next = computePersonKey({ phone: row.phone, email: row.email });
    if (next !== (row.person_key ?? null)) {
      changedIds.push(row.id);
      changedKeys.push(next);
    }
  }

  let keysWritten = 0;
  if (changedIds.length > 0) {
    keysWritten = returningRows<{ id: string }>(
      await AppDataSource.query(
        // `updated_at` is deliberately NOT bumped: it is the operator-visible "last
        // touched" timestamp, and a background recompute is not a touch. Bumping it
        // would make every lead look edited the night this ships.
        // The erasure predicates are repeated HERE, not just on the SELECT that fed
        // this list. A lead erased in the window between the two statements would
        // otherwise have its key written back onto the tombstone — and `person_key` is
        // a normalised copy of a phone number, so that is plaintext personal data
        // restored onto a row whose whole purpose is that it no longer holds any.
        // Nothing would ever remove it: step 1 never re-reads tombstoned rows.
        `UPDATE chatbot_leads l
            SET person_key = v.person_key
           FROM (SELECT * FROM unnest($3::uuid[], $4::varchar[]) AS t(id, person_key)) v
          WHERE l.id = v.id AND l.tenant_id = $1
            AND l.deleted_at IS NULL
            AND COALESCE(l.dedupe_key, '') NOT LIKE $2
          RETURNING l.id`,
        [tenantId, `${ERASED_PREFIX}%`, changedIds, changedKeys],
      ),
    ).length;
  }

  // ── 2. Cache the group's answer on every member ───────────────────────────
  // Done in SQL over the tenant's FULL live set, not over the batch above, so a capped
  // run still produces correct counts for the rows it did key — a partial aggregate
  // computed from a partial batch would silently under-report a repeat.
  const aggregated = returningRows<{ id: string }>(
    await AppDataSource.query(
      `WITH agg AS (
         SELECT l.person_key,
                count(DISTINCT l.id)::int AS lead_count,
                -- One conversation row per (tenant, session) is DB-enforced, so a
                -- straight count over the person's rows is already distinct
                -- conversations; the LEFT JOIN keeps leads with none (manual entry,
                -- CSV import) in the group at zero rather than dropping them.
                count(lc.id)::int AS conversation_count,
                min(l.created_at) AS first_seen,
                max(GREATEST(l.created_at, COALESCE(lc.created_at, l.created_at))) AS last_seen
           FROM chatbot_leads l
           LEFT JOIN chatbot_lead_conversations lc
             ON lc.lead_id = l.id AND lc.tenant_id = l.tenant_id
          WHERE l.tenant_id = $1
            AND l.deleted_at IS NULL
            -- Same belt-and-braces as step 1. Previously this relied on person_key
            -- being NULL on a husk, which made the tombstone predicate untested and
            -- let an erased row be aggregated into a living person's counts the
            -- moment a key survived on it.
            AND COALESCE(l.dedupe_key, '') NOT LIKE $2
            AND l.person_key IS NOT NULL
          GROUP BY l.person_key
       )
       UPDATE chatbot_leads t
          SET person_lead_count = agg.lead_count,
              person_conversation_count = agg.conversation_count,
              person_first_seen_at = agg.first_seen,
              person_last_seen_at = agg.last_seen
         FROM agg
        WHERE t.tenant_id = $1
          AND t.deleted_at IS NULL
          AND t.person_key = agg.person_key
          -- Idempotence: a steady-state re-run matches nothing here and writes no rows.
          AND (t.person_lead_count, t.person_conversation_count,
               t.person_first_seen_at, t.person_last_seen_at)
              IS DISTINCT FROM
              (agg.lead_count, agg.conversation_count, agg.first_seen, agg.last_seen)
        RETURNING t.id`,
      [tenantId, `${ERASED_PREFIX}%`],
    ),
  ).length;

  // ── 3. Clear stale aggregates from rows that no longer belong to a group ──
  // A row that lost its key (its phone was corrected to an unusable value, or it was
  // erased and the husk kept its cached counts) must not keep reporting a person it is
  // no longer part of. Deliberately NOT filtered on `deleted_at` — cleaning the
  // tombstones is half the reason this statement exists.
  const cleared = returningRows<{ id: string }>(
    await AppDataSource.query(
      `UPDATE chatbot_leads
          SET person_key = NULL,
              person_lead_count = NULL,
              person_conversation_count = NULL,
              person_first_seen_at = NULL,
              person_last_seen_at = NULL
        WHERE tenant_id = $1
          AND (
            -- lost its key (a phone corrected to an unusable value)
            person_key IS NULL
            -- …or is erased and is still carrying residue. person_key is included in
            -- the SET because it is a normalised copy of a phone or email: leaving it
            -- on a husk keeps the subject linkable, which is the thing erasure exists
            -- to prevent. This statement is the sweep's self-heal for any residue that
            -- reached a tombstone by any route, including a race with erasure.
            OR deleted_at IS NOT NULL
            OR COALESCE(dedupe_key, '') LIKE $2
          )
          AND (person_key IS NOT NULL
               OR person_lead_count IS NOT NULL
               OR person_conversation_count IS NOT NULL
               OR person_first_seen_at IS NOT NULL
               OR person_last_seen_at IS NOT NULL)
        RETURNING id`,
      [tenantId, `${ERASED_PREFIX}%`],
    ),
  ).length;

  return { keysWritten, aggregatesWritten: aggregated + cleared, capped };
}
