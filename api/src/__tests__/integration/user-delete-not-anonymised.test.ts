/**
 * The portal copy for the super-admin user deletion no longer promises
 * anonymisation (GDPR Tier 1, item 1). This test drives the endpoint the copy
 * describes and records what it actually leaves behind: the person stays
 * identifiable, because the row keeps its id and every other row still joins to
 * it. If the endpoint ever truly anonymises the person, this test fails and the
 * copy must be revisited.
 *
 * Driven end to end — the real Express app, the real route and the real audit
 * writer against the test database. Only Clerk is stubbed.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createAuthMocks, configureMockAuth } from '../helpers/auth';

const { auth } = createAuthMocks();

vi.mock('@clerk/express', () => ({
  clerkMiddleware: () => (_req: any, _res: any, next: any) => next(),
}));

vi.mock('../../websocket/socket.handler', () => ({
  emitToSession: vi.fn(),
  emitToTenantAgents: vi.fn(),
  emitToAgent: vi.fn(),
}));

import request from 'supertest';
import { app } from '../../server';
import { AppDataSource } from '../../database/data-source';
import { User } from '../../database/entities/User';
import { Agent } from '../../database/entities/Agent';
import { AuditLog } from '../../database/entities/AuditLog';
import { logAudit } from '../../utils/audit';
import { createTestTenant, createTestUser, createTestAgent } from '../helpers/factories';

let tenantId: string;
let actorId: string;

beforeEach(async () => {
  const tenant = await createTestTenant({});
  tenantId = tenant.id;
  const actor = await createTestUser(tenantId, { role: 'super_admin' });
  actorId = actor.id;
  configureMockAuth(auth, { userId: actor.id, tenantId, role: 'super_admin' });
});

describe('DELETE /api/v1/admin/users/:id — what the deletion really does', () => {
  it('removes the account details and the login, and leaves the person identifiable', async () => {
    const target = await createTestUser(tenantId, {
      name: 'Jane Doe',
      email: 'jane.doe@acme.com',
      isActive: false,
      password: '$2b$10$notarealhash',
      lastLoginIp: '203.0.113.9',
      passwordChangedAt: new Date('2026-01-01T00:00:00Z'),
      notificationPreferences: { email: true },
    });
    await createTestAgent(tenantId, target.id);
    // An action the person took before the deletion.
    await logAudit(target.id, 'bot.updated', 'bot', target.id, tenantId);

    const res = await request(app).delete(`/api/v1/admin/users/${target.id}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ deleted: true });

    // The account details and the login are gone.
    const stored = await AppDataSource.getRepository(User).findOne({
      where: { id: target.id },
      withDeleted: true,
    });
    expect(stored).not.toBeNull();
    expect(stored!.name).toBe('Deleted User');
    expect(stored!.email).toBe(`deleted_${target.id}@removed.local`);
    expect(stored!.clerkUserId).toBeNull();
    expect(stored!.deletedAt).not.toBeNull();

    // Nothing personal may survive on the husk either. It stays only so audit rows
    // and agents can join to it — an IP address and a password hash are still the
    // person's, and the row is the one thing left pointing at them.
    expect(stored!.password).toBeNull();
    expect(stored!.lastLoginIp).toBeNull();
    expect(stored!.passwordChangedAt).toBeNull();
    expect(stored!.notificationPreferences).toBeNull();

    // The person is NOT anonymised: the id survives, so every earlier action
    // still joins back to this one person.
    expect(stored!.id).toBe(target.id);
    const earlier = await AppDataSource.getRepository(AuditLog).findOne({
      where: { actorId: target.id, action: 'bot.updated' },
    });
    expect(earlier).not.toBeNull();
    const agent = await AppDataSource.getRepository(Agent).findOne({
      where: { userId: target.id },
      withDeleted: true,
    });
    expect(agent?.userId).toBe(target.id);

    // The deletion itself is recorded against the same id by the same actor.
    const deletionRow = await AppDataSource.getRepository(AuditLog).findOne({
      where: { actorId, action: 'user.deleted', entityId: target.id },
    });
    expect(deletionRow).not.toBeNull();
  });

  it('refuses to delete a user who is still active', async () => {
    const target = await createTestUser(tenantId, { name: 'Still Active', isActive: true });

    const res = await request(app).delete(`/api/v1/admin/users/${target.id}`);

    expect(res.status).toBe(400);
    const stored = await AppDataSource.getRepository(User).findOne({ where: { id: target.id } });
    expect(stored?.name).toBe('Still Active');
    expect(stored?.deletedAt).toBeNull();
  });
});
