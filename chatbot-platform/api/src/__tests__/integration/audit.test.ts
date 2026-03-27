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

vi.mock('../../utils/audit', () => ({
  logAudit: vi.fn().mockResolvedValue(undefined),
}));

import request from 'supertest';
import { app } from '../../server';
import {
  createTestTenant,
  createTestUser,
  createTestAuditLog,
} from '../helpers/factories';

describe('Audit Log Routes', () => {
  let tenantId: string;

  beforeEach(async () => {
    const tenant = await createTestTenant();
    tenantId = tenant.id;

    const admin = await createTestUser(tenantId, { role: 'super_admin' });

    configureMockAuth(auth, {
      userId: admin.id,
      tenantId,
      role: 'super_admin',
    });
  });

  describe('GET /api/v1/admin/audit-logs', () => {
    it('should include tenantName in audit log entries', async () => {
      const tenant = await createTestTenant({ name: 'Acme Corp' });
      await createTestAuditLog({ tenantId: tenant.id, action: 'test.action' });

      const res = await request(app).get('/api/v1/admin/audit-logs');

      expect(res.status).toBe(200);
      const entry = res.body.data.find(
        (e: any) => e.tenantId === tenant.id,
      );
      expect(entry).toBeDefined();
      expect(entry.tenantName).toBe('Acme Corp');
    });

    it('should include logs up to end-of-day when filtering by "to" date', async () => {
      await createTestAuditLog({
        tenantId,
        action: 'eod.test',
        createdAt: new Date('2026-03-27T15:00:00Z'),
      });

      const res = await request(app)
        .get('/api/v1/admin/audit-logs')
        .query({ to: '2026-03-27' });

      expect(res.status).toBe(200);
      const found = res.body.data.some((e: any) => e.action === 'eod.test');
      expect(found).toBe(true);
    });
  });

  describe('GET /api/v1/admin/audit-logs/export', () => {
    it('should export CSV with tenant_name column', async () => {
      const tenant = await createTestTenant({ name: 'Export Tenant' });
      await createTestAuditLog({ tenantId: tenant.id, action: 'csv.test' });

      const res = await request(app).get('/api/v1/admin/audit-logs/export');

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('text/csv');

      const csv = res.text;
      const lines = csv.split('\n');
      expect(lines[0]).toContain('tenant_name');

      const dataLine = lines.find((l: string) => l.includes('csv.test'));
      expect(dataLine).toBeDefined();
      expect(dataLine).toContain('Export Tenant');
    });
  });

  describe('Pagination', () => {
    it('should return correct pagination meta for audit logs', async () => {
      const promises = [];
      for (let i = 0; i < 30; i++) {
        promises.push(createTestAuditLog({ tenantId, action: `bulk.${i}` }));
      }
      await Promise.all(promises);

      const res = await request(app)
        .get('/api/v1/admin/audit-logs')
        .query({ page: 1, limit: 10 });

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(10);
      expect(res.body.meta.pagination.total).toBe(30);
      expect(res.body.meta.pagination.totalPages).toBe(3);
    });
  });
});
