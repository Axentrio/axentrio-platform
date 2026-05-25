/**
 * Dev helper: set a tenant's tier without going through Stripe.
 *
 *   npx ts-node scripts/set-tier.ts <tenant-name-or-id> <tier>
 *   npx ts-node scripts/set-tier.ts list
 *
 * Tier values: free | essential | pro | enterprise
 *
 * `tier` rewrites `Tenant.tier` directly. The entitlements endpoint reflects
 * this on the next request (5-min React Query staleTime in the portal), so
 * hard-refresh the browser to see locked/unlocked state change immediately.
 *
 * Does NOT touch billing rows or Stripe — purely local UX testing.
 */
import 'reflect-metadata';
import { AppDataSource } from '../src/database/data-source';
import { Tenant } from '../src/database/entities/Tenant';

const VALID_TIERS = ['free', 'essential', 'pro', 'enterprise'] as const;

async function main() {
  const [, , arg1, arg2] = process.argv;

  await AppDataSource.initialize();
  const repo = AppDataSource.getRepository(Tenant);

  if (arg1 === 'list' || !arg1) {
    const rows: Array<{ id: string; name: string; tier: string; status: string }> =
      await AppDataSource.query(
        `SELECT id, name, tier, status FROM tenants WHERE deleted_at IS NULL ORDER BY name`,
      );
    console.log('');
    console.log('tier         status     name (id)');
    console.log('────         ──────     ─────────');
    for (const r of rows) {
      console.log(
        `${r.tier.padEnd(12)} ${r.status.padEnd(10)} ${r.name}  (${r.id.slice(0, 8)})`,
      );
    }
    console.log('');
    await AppDataSource.destroy();
    return;
  }

  if (!arg2 || !VALID_TIERS.includes(arg2 as typeof VALID_TIERS[number])) {
    console.error(`usage: set-tier <tenant-name-or-id> <${VALID_TIERS.join('|')}>`);
    console.error(`       set-tier list`);
    process.exit(1);
  }

  // Lookup by exact id first, then name match (case-insensitive contains).
  // Guard the id query: Postgres throws on malformed UUIDs before reaching the
  // name fallback, so only try the id lookup when arg1 is UUID-shaped.
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  let tenant: Tenant | null = null;
  if (UUID_RE.test(arg1)) {
    tenant = await repo.findOne({ where: { id: arg1 } });
  }
  if (!tenant) {
    const all = await repo.find({ where: { status: 'active' as const } });
    tenant = all.find((t) => t.name.toLowerCase().includes(arg1.toLowerCase())) ?? null;
  }
  if (!tenant) {
    console.error(`No tenant matching "${arg1}". Run \`set-tier list\` for all tenants.`);
    process.exit(2);
  }

  const before = tenant.tier;
  tenant.tier = arg2 as Tenant['tier'];
  await repo.save(tenant);

  console.log(`✓ ${tenant.name} (${tenant.id})`);
  console.log(`  ${before}  →  ${tenant.tier}`);
  console.log('');
  console.log('Hard-refresh your portal browser to see the new entitlements (Cmd+Shift+R).');

  await AppDataSource.destroy();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
