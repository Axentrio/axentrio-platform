/**
 * Read-only report: find tenants in the "split-brain" billing state, where the
 * app treats the tenant as one plan but Stripe is still billing a different,
 * now-demoted subscription.
 *
 *   npx ts-node scripts/find-split-brain-billing.ts
 *
 * How the state arises: a super-admin "Set tier (manual)" override (e.g. → Free)
 * demotes the live Stripe row to is_primary=false and makes a `manual` row the
 * primary, but does NOT cancel the Stripe subscription (documented decision in
 * billing/service.ts `setTierManual`). If nobody cancels it in the Stripe
 * dashboard, the customer keeps getting charged while the app shows them on the
 * manual plan.
 *
 * Detection rule: a `stripe` row that is NOT primary but is still in a billable
 * status (active/trialing/past_due) with a subscription id. Each hit is real
 * money potentially being charged against an entitlement the app no longer
 * grants — investigate and cancel in Stripe (or record an intentional comp).
 *
 * Purely SELECTs — touches nothing.
 */
import 'reflect-metadata';
import { AppDataSource } from '../src/database/data-source';

interface SplitBrainRow {
  tenant_id: string;
  tenant_name: string;
  tenant_tier: string;
  primary_provider: string | null;
  primary_plan: string | null;
  primary_status: string | null;
  customer_id: string | null;
  subscription_id: string | null;
  stripe_status: string;
  cancel_at_period_end: boolean;
  current_period_end: Date | null;
  stripe_updated_at: Date;
  last_override_at: Date | null;
}

function fmt(d: Date | null): string {
  return d ? new Date(d).toISOString().slice(0, 16).replace('T', ' ') : '—';
}

async function main() {
  await AppDataSource.initialize();

  const rows: SplitBrainRow[] = await AppDataSource.query(`
    SELECT
      t.id                   AS tenant_id,
      t.name                 AS tenant_name,
      t.tier                 AS tenant_tier,
      p.provider             AS primary_provider,
      p.current_plan_id      AS primary_plan,
      p.status               AS primary_status,
      s.customer_id          AS customer_id,
      s.subscription_id      AS subscription_id,
      s.status               AS stripe_status,
      s.cancel_at_period_end AS cancel_at_period_end,
      s.current_period_end   AS current_period_end,
      s.updated_at           AS stripe_updated_at,
      ovr.created_at         AS last_override_at
    FROM tenant_billing_accounts s
    JOIN tenants t ON t.id = s.tenant_id
    LEFT JOIN tenant_billing_accounts p
      ON p.tenant_id = s.tenant_id AND p.is_primary = true
    LEFT JOIN LATERAL (
      SELECT created_at
      FROM billing_events e
      WHERE e.tenant_id = s.tenant_id
        AND e.event_type = 'tier.manual_override'
      ORDER BY created_at DESC
      LIMIT 1
    ) ovr ON true
    WHERE s.provider = 'stripe'
      AND s.is_primary = false
      AND s.subscription_id IS NOT NULL
      AND s.status IN ('active', 'trialing', 'past_due')
    ORDER BY t.name
  `);

  if (rows.length === 0) {
    console.log('\n✓ No split-brain billing accounts found. Nothing is being charged behind a demoted subscription.\n');
    await AppDataSource.destroy();
    return;
  }

  console.log(
    `\n⚠ ${rows.length} tenant(s) with a demoted-but-still-billing Stripe subscription:\n`,
  );
  for (const r of rows) {
    console.log(`  ${r.tenant_name}  (${r.tenant_id})`);
    console.log(
      `    app says : tier=${r.tenant_tier} · primary=${r.primary_provider ?? 'none'}/${r.primary_plan ?? '—'} (${r.primary_status ?? '—'})`,
    );
    console.log(
      `    stripe   : ${r.stripe_status}${r.cancel_at_period_end ? ' (cancel@period_end)' : ''} · sub=${r.subscription_id} · cust=${r.customer_id ?? '—'}`,
    );
    console.log(
      `    period_end=${fmt(r.current_period_end)} · stripe_updated=${fmt(r.stripe_updated_at)} · last_override=${fmt(r.last_override_at)}`,
    );
    console.log('');
  }
  console.log(
    'Action: for each, cancel the subscription in the Stripe dashboard (or record an intentional comp). The demoted row keeps generating invoices until cancelled.\n',
  );

  await AppDataSource.destroy();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
