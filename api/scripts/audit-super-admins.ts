/**
 * Inventory every super_admin and say where each one came from.
 *
 *   npx ts-node scripts/audit-super-admins.ts
 *
 * Why this exists: until `createTenantUser` grew a role allowlist, any tenant
 * admin could mint a `super_admin` in their own tenant — a role that reads every
 * other tenant through `X-Tenant-Context`. Closing the hole leaves no trace in
 * the code; a hole that was open leaves rows. This is the check for those rows.
 *
 * Provenance is established from the two legitimate routes:
 *   - `SUPER_ADMIN_EMAILS`        → promoted automatically at login (clerk.middleware)
 *   - an audit row `user.promoted` → promoted deliberately through the admin API
 * Anything else is REVIEW: either it predates audit coverage of the promote path,
 * or it arrived through the escalation path.
 *
 * Exits 1 when anything needs review, so it can gate a deploy or a release.
 */
import 'reflect-metadata';
import { AppDataSource } from '../src/database/data-source';
import { config } from '../src/config/environment';

interface SuperAdminRow {
  id: string;
  email: string | null;
  tenant_id: string | null;
  tenant_name: string | null;
  created_at: Date;
  last_login_at: Date | null;
}

async function main(): Promise<void> {
  // READ-ONLY. The default data source runs pending migrations on initialize,
  // which is fine for the app and wrong for an audit: pointing this at a database
  // should never change it.
  AppDataSource.setOptions({ migrationsRun: false, logging: false });

  await AppDataSource.initialize();
  try {
    const rows: SuperAdminRow[] = await AppDataSource.query(
      `SELECT u.id, u.email, u.tenant_id, t.name AS tenant_name, u.created_at, u.last_login_at
         FROM users u
         LEFT JOIN tenants t ON t.id = u.tenant_id
        WHERE u.role = 'super_admin' AND u.deleted_at IS NULL
        ORDER BY u.created_at ASC`,
    );

    const envEmails = new Set(config.superAdmin.emails.map((e) => e.toLowerCase()));
    let needsReview = 0;

    for (const row of rows) {
      const email = (row.email ?? '').toLowerCase();
      const inEnv = envEmails.has(email);

      const promoted = inEnv
        ? []
        : await AppDataSource.query(
            `SELECT id FROM audit_logs
              WHERE action = 'user.promoted' AND entity_id = $1
              LIMIT 1`,
            [row.id],
          );

      const provenance = inEnv
        ? 'SUPER_ADMIN_EMAILS'
        : promoted.length > 0
          ? 'promoted via admin API (audited)'
          : 'UNKNOWN';

      if (provenance === 'UNKNOWN') needsReview += 1;

      const flag = provenance === 'UNKNOWN' ? 'REVIEW' : 'ok    ';
      const tenant = row.tenant_name ?? row.tenant_id ?? '(none)';
      const lastLogin = row.last_login_at ? new Date(row.last_login_at).toISOString() : 'never';
      console.log(
        `${flag}  ${row.email ?? '(no email)'}  tenant=${tenant}  created=${new Date(
          row.created_at,
        ).toISOString()}  lastLogin=${lastLogin}  provenance=${provenance}`,
      );
    }

    console.log(`\n${rows.length} super_admin(s); ${needsReview} need review.`);
    if (needsReview > 0) {
      console.log(
        'A REVIEW row has no legitimate provenance on record. Check its tenant and its\n' +
          'creation time against the tenant-members API before deciding anything.',
      );
      process.exitCode = 1;
    }
  } finally {
    await AppDataSource.destroy();
  }
}

main().catch((error) => {
  console.error('audit-super-admins failed:', error);
  process.exit(1);
});
