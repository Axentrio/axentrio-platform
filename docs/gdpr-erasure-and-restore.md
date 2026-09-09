# Erasure, retention and restore

Operational notes for the data-deletion controls. Written because the deletion
paths shipped before anyone wrote down what they do NOT cover, and a restore is
the one moment where "we deleted it" stops being true.

Not legal advice. The two periods in here (the 30-day dormancy, the compliance
event retention) are engineering defaults pending a decision.

## What deletes what

| Control | Scope | Trigger |
|---|---|---|
| Lead erasure (`eraseLead`) | One person across the lead row, the transcript, the channel binding, judgments, bookings, handoffs, sent emails and guardrail logs | Admin/supervisor, or lead retention |
| Conversation retention | Whole conversations idle past the tenant's period, including judgments (no FK, so deleted explicitly) | Daily sweep, per-tenant, **off by default** |
| Account deletion | The whole workspace's content, then the tenant row is anonymised | Admin, after a 30-day dormancy |
| Upload expiry | Chat uploads and their S3 objects | 30-day `UploadSession` expiry |

**Legal holds suspend the sweeps.** `legal_holds` names the rows it protects
(`{ all }`, `{ sessionIds }`, `{ leadIds }`) and requires a review date. Both
retention sweeps ask the same predicate. Release a hold and the rows become
eligible again on the next run.

## What is deliberately NOT deleted

- `legal_invoices`, `billing_events`, `tenant_billing_accounts`,
  `chatbot_stripe_webhook_events` — statutory accounting retention (Art 17(3)(b)).
  They keep the tenant id, which is why account deletion anonymises the tenant row
  instead of deleting it: a hard delete would cascade them away.
- `compliance_events` — the proof that a deletion happened.
- `audit_logs` — the security trail, swept at `AUDIT_RETENTION_DAYS` (90).
- The lead **husk** — it holds the `erased:<leadId>` tombstone that stops an erased
  identity being re-created by the next inbound message. It carries no personal
  data; that is the point.
- `chatbot_stripe_webhook_events` holds raw Stripe payloads, which include the
  customer's email. It is retained with the invoices it backs. If a customer asks
  what we still hold after deletion, this is the answer that surprises them.

## Backups: a deletion does not propagate

Production dumps are `pg_dump` snapshots in R2 with a **30-day** retention. A
`pg_dump` is immutable, so a person erased today remains inside every dump taken
before the erasure, for up to 30 more days. This is normal and accepted — but it
has to be *said*, in the privacy notice and the DPA, with the statement that
restored data is re-erased.

### Re-erasing after a restore

A restore rolls the database back to the dump's timestamp. Everything erased
between the dump and now comes back — including data subjects who asked to be
forgotten. That is the failure this section exists for.

1. Note the dump's `created_at` (R2 object metadata) — the point the restore
   rewinds to.
2. List the deletions that happened after it, which are the events kept for
   exactly this reason:

   ```sql
   SELECT event_type, tenant_id, subject_id, details, created_at
     FROM compliance_events
    WHERE event_type IN ('leads.erased', 'tenant.deleted')
      AND created_at > '<dump timestamp>'
    ORDER BY created_at;
   ```

3. Replay them:
   - `leads.erased` → `eraseLead(dataSource, tenant_id, subject_id)` per row.
   - `tenant.deleted` → `executeTenantDeletion(tenant_id)` per row.
4. Re-check: the query in step 2 should now describe rows that are erased again.
5. Record the replay itself as a compliance event (`erasure.replayed`) with the
   dump timestamp and the number of subjects, so the next person can see it was
   done.

`compliance_events` survives a restore only if the dump predates the events — a
restore to before an event loses the record of it. If the window matters, export
the table before restoring.

## Restore drill

`db-restore-drill.yml` runs weekly and asserts the schema restores. It does **not**
run the re-erase replay above. A restore that passes the drill can still resurrect
erased people, so the replay is a manual step on purpose.
