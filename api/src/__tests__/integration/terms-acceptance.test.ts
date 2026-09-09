/**
 * Accepted terms, against a real DB.
 *
 * The property that matters is that the row is EVIDENCE: one per person per
 * version, never overwritten, and tied to the version the customer actually saw.
 */
import { describe, it, expect } from 'vitest';
import { AppDataSource } from '../../database/data-source';
import { getTermsStatus, recordTermsAcceptance } from '../../compliance/terms.service';
import { CURRENT_TERMS_VERSION } from '../../config/terms';
import { createTestTenant, createTestUser } from '../helpers/factories';

describe('terms acceptance', () => {
  it('records who accepted which version, and when', async () => {
    const tenant = await createTestTenant({ tier: 'pro' });
    const user = await createTestUser(tenant.id, { role: 'admin' });

    const row = await recordTermsAcceptance({
      tenantId: tenant.id,
      userId: user.id,
      ipAddress: '203.0.113.9',
      userAgent: 'Mozilla/5.0',
    });

    expect(row.termsVersion).toBe(CURRENT_TERMS_VERSION);
    expect(row.acceptedAt).toBeInstanceOf(Date);
    const status = await getTermsStatus(tenant.id, user.id);
    expect(status.upToDate).toBe(true);
    expect(status.acceptedAt).not.toBeNull();
  });

  it('is idempotent for the same version — one row, not two', async () => {
    const tenant = await createTestTenant({ tier: 'pro' });
    const user = await createTestUser(tenant.id, { role: 'agent' });

    await recordTermsAcceptance({ tenantId: tenant.id, userId: user.id });
    await recordTermsAcceptance({ tenantId: tenant.id, userId: user.id });

    const rows = await AppDataSource.query(
      `SELECT id FROM terms_acceptances WHERE tenant_id = $1 AND user_id = $2`,
      [tenant.id, user.id],
    );
    expect(rows).toHaveLength(1);
  });

  it('keeps the old acceptance when a NEW version arrives', async () => {
    const tenant = await createTestTenant({ tier: 'pro' });
    const user = await createTestUser(tenant.id, { role: 'admin' });

    await recordTermsAcceptance({ tenantId: tenant.id, userId: user.id, version: '2020-01-01' });

    // The old row is history; the current version is still outstanding.
    const status = await getTermsStatus(tenant.id, user.id);
    expect(status.upToDate).toBe(false);
    expect(status.acceptedVersion).toBeNull();

    const rows = await AppDataSource.query(
      `SELECT terms_version FROM terms_acceptances WHERE user_id = $1 ORDER BY terms_version`,
      [user.id],
    );
    expect(rows.map((r: { terms_version: string }) => r.terms_version)).toEqual(['2020-01-01']);
  });

  it('is per person — one seat accepting does not accept for the team', async () => {
    const tenant = await createTestTenant({ tier: 'pro' });
    const admin = await createTestUser(tenant.id, { role: 'admin' });
    const agent = await createTestUser(tenant.id, { role: 'agent' });

    await recordTermsAcceptance({ tenantId: tenant.id, userId: admin.id });

    expect((await getTermsStatus(tenant.id, admin.id)).upToDate).toBe(true);
    expect((await getTermsStatus(tenant.id, agent.id)).upToDate).toBe(false);
  });
});
