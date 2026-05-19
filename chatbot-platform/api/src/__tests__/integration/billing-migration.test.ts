/**
 * Migration + schema integrity tests.
 *
 * Plan: .scratch/plan-billing.md § Implementation outline step 14 → Migration:
 *   - Backfill creates one manual row per pre-existing tenant with matching tier.
 *   - Partial unique indexes on (provider, customer_id) and
 *     (provider, subscription_id) reject duplicate inserts.
 *   - `raw_provider_data` defaults to `'{}'::jsonb`.
 *   - `down()` throws (irreversible migration).
 *
 * Plus the round-5 #8 SQL primary-switch ordering invariant (single-statement
 * promotion/demotion never violates the partial unique index on
 * (tenant_id) WHERE is_primary).
 *
 * The schema is created by `synchronize()` in setup.ts. The migration class
 * isn't run, so we test its `down()` directly via a fresh instance and
 * verify the schema-shape invariants on the synchronize'd DB.
 */

import { describe, it, expect } from 'vitest';
import { AppDataSource } from '../../database/data-source';
import { TenantBillingAccount } from '../../database/entities/TenantBillingAccount';
import { AddBillingTables1780400000000 } from '../../database/migrations/1780400000000-AddBillingTables';
import { createTestTenant, createTestBillingAccount } from '../helpers/factories';

describe('Migration AddBillingTables', () => {
  it('down() throws — migration is irreversible by design', async () => {
    const migration = new AddBillingTables1780400000000();
    // queryRunner argument is ignored — the throw happens before any work.
    await expect(
      migration.down(AppDataSource.createQueryRunner()),
    ).rejects.toThrow(/irreversible/i);
  });
});

describe('TenantBillingAccount schema invariants', () => {
  it('raw_provider_data defaults to {}::jsonb when omitted from INSERT', async () => {
    const tenant = await createTestTenant({ tier: 'pro' });
    await AppDataSource.query(
      `INSERT INTO tenant_billing_accounts
         (tenant_id, provider, status, current_plan_id, is_primary, cancel_at_period_end)
       VALUES ($1, 'manual', 'active', 'pro', true, false)`,
      [tenant.id],
    );
    const rows: Array<{ raw_provider_data: Record<string, unknown> }> =
      await AppDataSource.query(
        `SELECT raw_provider_data FROM tenant_billing_accounts WHERE tenant_id = $1`,
        [tenant.id],
      );
    expect(rows[0].raw_provider_data).toEqual({});
  });

  it('partial unique index on (provider, customer_id) rejects duplicates', async () => {
    const tenantA = await createTestTenant({ tier: 'pro' });
    const tenantB = await createTestTenant({ tier: 'pro' });
    await createTestBillingAccount(tenantA.id, {
      provider: 'stripe',
      status: 'active',
      currentPlanId: 'pro',
      isPrimary: false,
      customerId: 'cus_clash',
      subscriptionId: null,
    });
    // Manual on tenant A is primary by default (from factory); demote.
    await AppDataSource.getRepository(TenantBillingAccount).update(
      { tenantId: tenantA.id, provider: 'manual' },
      { isPrimary: false },
    );

    await expect(
      createTestBillingAccount(tenantB.id, {
        provider: 'stripe',
        status: 'active',
        currentPlanId: 'pro',
        isPrimary: false,
        customerId: 'cus_clash', // same customer_id on a different tenant
        subscriptionId: null,
      }),
    ).rejects.toMatchObject({
      message: expect.stringMatching(/duplicate key|unique/i),
    });
  });

  it('partial unique index on (provider, subscription_id) rejects duplicates', async () => {
    const tenantA = await createTestTenant({ tier: 'pro' });
    const tenantB = await createTestTenant({ tier: 'pro' });
    await createTestBillingAccount(tenantA.id, {
      provider: 'stripe',
      status: 'active',
      currentPlanId: 'pro',
      isPrimary: false,
      customerId: 'cus_a',
      subscriptionId: 'sub_clash',
    });

    await expect(
      createTestBillingAccount(tenantB.id, {
        provider: 'stripe',
        status: 'active',
        currentPlanId: 'pro',
        isPrimary: false,
        customerId: 'cus_b',
        subscriptionId: 'sub_clash', // same sub on a different tenant
      }),
    ).rejects.toMatchObject({
      message: expect.stringMatching(/duplicate key|unique/i),
    });
  });

  it('partial unique index on (tenant_id) WHERE is_primary blocks two primaries per tenant', async () => {
    const tenant = await createTestTenant({ tier: 'pro' });
    await createTestBillingAccount(tenant.id, {
      provider: 'manual',
      status: 'trialing',
      currentPlanId: 'pro',
      isPrimary: true,
    });
    // Second row also is_primary=true would violate the partial unique index.
    await expect(
      createTestBillingAccount(tenant.id, {
        provider: 'stripe',
        status: 'active',
        currentPlanId: 'pro',
        isPrimary: true,
        customerId: 'cus_other',
      }),
    ).rejects.toMatchObject({
      message: expect.stringMatching(/duplicate key|unique/i),
    });
  });

  it('partial unique index on (tenant_id, provider) blocks two rows for the same provider', async () => {
    const tenant = await createTestTenant({ tier: 'pro' });
    await createTestBillingAccount(tenant.id, {
      provider: 'manual',
      isPrimary: true,
    });
    await expect(
      createTestBillingAccount(tenant.id, {
        provider: 'manual',
        isPrimary: false,
      }),
    ).rejects.toMatchObject({
      message: expect.stringMatching(/duplicate key|unique/i),
    });
  });
});

describe('Single-statement primary-switch SQL ordering (round-5 #8)', () => {
  it("the documented UPDATE … CASE pattern flips is_primary without violating the partial unique index", async () => {
    const tenant = await createTestTenant({ tier: 'pro' });
    const manual = await createTestBillingAccount(tenant.id, {
      provider: 'manual',
      status: 'trialing',
      currentPlanId: 'pro',
      isPrimary: true,
    });
    const stripeRow = await createTestBillingAccount(tenant.id, {
      provider: 'stripe',
      status: 'active',
      currentPlanId: 'pro',
      isPrimary: false,
      customerId: 'cus_switch',
      subscriptionId: 'sub_switch',
    });

    // Apply the same single-statement pattern documented in events.ts ::
    // promotePrimaryAndCascadeTier. The case-when expression demotes the
    // current primary and promotes the target in one go — no transient
    // state where two rows have is_primary=true.
    await AppDataSource.query(
      `UPDATE tenant_billing_accounts
          SET is_primary = CASE
            WHEN id = $1 THEN true
            WHEN tenant_id = $2 AND is_primary = true AND id <> $1 THEN false
            ELSE is_primary
          END
        WHERE tenant_id = $2
          AND (id = $1 OR is_primary = true)`,
      [stripeRow.id, tenant.id],
    );

    const rows = await AppDataSource.getRepository(TenantBillingAccount).find({
      where: { tenantId: tenant.id },
    });
    const primary = rows.filter((r) => r.isPrimary === true);
    expect(primary.length).toBe(1);
    expect(primary[0].id).toBe(stripeRow.id);
    const manualAfter = rows.find((r) => r.id === manual.id)!;
    expect(manualAfter.isPrimary).toBe(false);
  });
});

describe('raw_provider_data JSONB merge semantics', () => {
  it('jsonb_set on {stripe,scheduleId} preserves sibling keys', async () => {
    const tenant = await createTestTenant({ tier: 'pro' });
    const row = await createTestBillingAccount(tenant.id, {
      provider: 'stripe',
      status: 'active',
      currentPlanId: 'pro',
      isPrimary: false,
      customerId: 'cus_jsonb',
      subscriptionId: 'sub_jsonb',
    });
    // Pre-populate a sibling key under stripe.* to verify it survives.
    await AppDataSource.query(
      `UPDATE tenant_billing_accounts
          SET raw_provider_data = raw_provider_data || jsonb_build_object(
            'stripe',
            COALESCE(raw_provider_data->'stripe', '{}'::jsonb)
              || jsonb_build_object('siblingKey', 'should_survive'::text)
          )
        WHERE id = $1`,
      [row.id],
    );

    // Now write scheduleId via the same merge pattern used in events.ts.
    await AppDataSource.query(
      `UPDATE tenant_billing_accounts
          SET raw_provider_data = raw_provider_data || jsonb_build_object(
            'stripe',
            COALESCE(raw_provider_data->'stripe', '{}'::jsonb)
              || jsonb_build_object('scheduleId', $1::text)
          )
        WHERE id = $2`,
      ['sub_sched_test', row.id],
    );

    const fresh = await AppDataSource.getRepository(
      TenantBillingAccount,
    ).findOneByOrFail({ id: row.id });
    const stripeMeta = fresh.rawProviderData.stripe as Record<string, string>;
    expect(stripeMeta.siblingKey).toBe('should_survive');
    expect(stripeMeta.scheduleId).toBe('sub_sched_test');
  });

  it('clear via #- removes scheduleId but preserves siblings', async () => {
    const tenant = await createTestTenant({ tier: 'pro' });
    const row = await createTestBillingAccount(tenant.id, {
      provider: 'stripe',
      status: 'active',
      currentPlanId: 'pro',
      isPrimary: false,
      customerId: 'cus_clear',
      subscriptionId: 'sub_clear',
      rawProviderData: {
        stripe: {
          scheduleId: 'sub_sched_doomed',
          siblingKey: 'should_survive',
        },
      },
    });

    await AppDataSource.query(
      `UPDATE tenant_billing_accounts
          SET raw_provider_data = raw_provider_data #- '{stripe,scheduleId}'
        WHERE id = $1`,
      [row.id],
    );

    const fresh = await AppDataSource.getRepository(
      TenantBillingAccount,
    ).findOneByOrFail({ id: row.id });
    const stripeMeta = fresh.rawProviderData.stripe as Record<string, string>;
    expect(stripeMeta.scheduleId).toBeUndefined();
    expect(stripeMeta.siblingKey).toBe('should_survive');
  });
});
