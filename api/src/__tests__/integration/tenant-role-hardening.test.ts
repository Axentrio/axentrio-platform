/**
 * Tenant-role hardening: one allowlist, and a trail for every change.
 *
 * The escalation fix stopped `super_admin` being CREATED through the tenant-members
 * API. Two things still needed doing, and this suite pins both:
 *
 *   1. the allowlist lived in two copies (create + update), so a later edit to one
 *      silently reopens the hole in the other;
 *   2. neither path wrote an audit row, so "who gave this seat its access?" had no
 *      answer after the fact.
 *
 * Real DB, real handlers: the interesting part is what lands in `audit_logs`.
 */
import { describe, it, expect } from 'vitest';
import { AppDataSource } from '../../database/data-source';
import {
  createTenantUser,
  updateTenantUserRole,
} from '../../routes/tenant-members.handlers';
import { isTenantAssignableRole, TENANT_ASSIGNABLE_ROLES } from '../../database/entities/User';
import { createTestTenant, createTestUser } from '../helpers/factories';

interface FakeRes {
  statusCode: number;
  body?: unknown;
  status(code: number): FakeRes;
  json(payload: unknown): FakeRes;
}

function fakeRes(): FakeRes {
  const res: FakeRes = {
    statusCode: 200,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
  return res;
}

/**
 * `asyncHandler` returns `void`, NOT the promise — so awaiting the handler proves
 * nothing. Settle on the first response or `next(err)` instead.
 */
async function call(
  handler: (req: never, res: never, next: (e?: unknown) => void) => unknown,
  req: Record<string, unknown>,
): Promise<{ status: number; body?: unknown; error?: unknown }> {
  const res = fakeRes();
  let error: unknown;
  let settle!: () => void;
  const settled = new Promise<void>((resolve) => {
    settle = resolve;
  });

  const json = res.json.bind(res);
  res.json = (payload: unknown) => {
    json(payload);
    settle();
    return res;
  };

  (
    handler as unknown as (a: unknown, b: unknown, c: (e?: unknown) => void) => void
  )(req, res, (e?: unknown) => {
    error = e;
    settle();
  });

  await settled;
  return { status: res.statusCode, body: res.body, error };
}

const auditRows = async (action: string, entityId: string) =>
  AppDataSource.query(
    `SELECT actor_id, tenant_id, metadata FROM audit_logs
      WHERE action = $1 AND entity_id = $2`,
    [action, entityId],
  );

describe('tenant role allowlist', () => {
  it('never contains super_admin, in either direction', () => {
    expect(TENANT_ASSIGNABLE_ROLES).not.toContain('super_admin');
    expect(isTenantAssignableRole('super_admin')).toBe(false);
    expect(isTenantAssignableRole('admin')).toBe(true);
    expect(isTenantAssignableRole(undefined)).toBe(false);
  });

  it('refuses to CREATE a super_admin and saves nothing', async () => {
    const tenant = await createTestTenant({ tier: 'pro' });
    const admin = await createTestUser(tenant.id, { role: 'admin' });

    const { error } = await call(createTenantUser, {
      user: { tenantId: tenant.id, id: admin.id },
      userId: admin.id,
      body: { email: 'escalate@user.com', name: 'Escalate', role: 'super_admin' },
    });

    expect(error).toMatchObject({ message: 'Invalid role' });
    const rows = await AppDataSource.query(
      `SELECT id FROM users WHERE tenant_id = $1 AND email = 'escalate@user.com'`,
      [tenant.id],
    );
    expect(rows).toHaveLength(0);
  });

  it('refuses to PROMOTE an existing seat to super_admin', async () => {
    const tenant = await createTestTenant({ tier: 'pro' });
    const admin = await createTestUser(tenant.id, { role: 'admin' });
    const target = await createTestUser(tenant.id, { role: 'agent' });

    const { error } = await call(updateTenantUserRole, {
      user: { tenantId: tenant.id, id: admin.id },
      userId: admin.id,
      body: { role: 'super_admin' },
      params: { userId: target.id },
    });

    expect(error).toMatchObject({ message: 'Invalid role' });
    const [row] = await AppDataSource.query(`SELECT role FROM users WHERE id = $1`, [target.id]);
    expect(row.role).toBe('agent');
  });

  it('records user.created with the role that was granted', async () => {
    const tenant = await createTestTenant({ tier: 'pro' });
    const admin = await createTestUser(tenant.id, { role: 'admin' });

    const { status } = await call(createTenantUser, {
      user: { tenantId: tenant.id, id: admin.id },
      userId: admin.id,
      body: { email: `seat-${Date.now()}@user.com`, name: 'New Seat', role: 'supervisor' },
    });
    expect(status).toBe(201);

    const [created] = await AppDataSource.query(
      `SELECT id FROM users WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [tenant.id],
    );
    const rows = await auditRows('user.created', created.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].actor_id).toBe(admin.id);
    expect(rows[0].tenant_id).toBe(tenant.id);
    expect(rows[0].metadata).toMatchObject({ role: 'supervisor' });
  });

  it('records user.role_changed with BOTH ends of the change', async () => {
    const tenant = await createTestTenant({ tier: 'pro' });
    const admin = await createTestUser(tenant.id, { role: 'admin' });
    const target = await createTestUser(tenant.id, { role: 'agent' });

    const { status } = await call(updateTenantUserRole, {
      user: { tenantId: tenant.id, id: admin.id },
      userId: admin.id,
      body: { role: 'supervisor' },
      params: { userId: target.id },
    });
    expect(status).toBe(200);

    const rows = await auditRows('user.role_changed', target.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].metadata).toMatchObject({ from: 'agent', to: 'supervisor' });
  });
});
