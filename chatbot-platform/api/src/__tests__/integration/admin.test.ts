import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { app } from '../../server';

describe('Admin Routes', () => {
  describe('GET /api/v1/admin/tenants', () => {
    it('should reject unauthenticated requests', async () => {
      const res = await request(app).get('/api/v1/admin/tenants');
      expect(res.status).toBe(401);
    });
  });

  describe('POST /api/v1/admin/tenants', () => {
    it('should reject unauthenticated requests', async () => {
      const res = await request(app)
        .post('/api/v1/admin/tenants')
        .send({ name: 'New Tenant' });
      expect(res.status).toBe(401);
    });
  });

  describe('GET /api/v1/admin/tenants/:id', () => {
    it('should reject unauthenticated requests', async () => {
      const res = await request(app).get(
        '/api/v1/admin/tenants/00000000-0000-0000-0000-000000000000',
      );
      expect(res.status).toBe(401);
    });
  });

  describe('GET /api/v1/admin/audit-logs', () => {
    it('should reject unauthenticated requests', async () => {
      const res = await request(app).get('/api/v1/admin/audit-logs');
      expect(res.status).toBe(401);
    });
  });

  describe('GET /api/v1/admin/audit-logs/export', () => {
    it('should reject unauthenticated requests', async () => {
      const res = await request(app).get('/api/v1/admin/audit-logs/export');
      expect(res.status).toBe(401);
    });
  });

  describe('POST /api/v1/admin/users/:id/deactivate', () => {
    it('should reject unauthenticated requests', async () => {
      const res = await request(app).post(
        '/api/v1/admin/users/00000000-0000-0000-0000-000000000000/deactivate',
      );
      expect(res.status).toBe(401);
    });
  });

  describe('POST /api/v1/admin/tenants/:id/pending-invites/:inviteId/resend', () => {
    it('should reject unauthenticated requests', async () => {
      const res = await request(app).post(
        '/api/v1/admin/tenants/00000000-0000-0000-0000-000000000000/pending-invites/00000000-0000-0000-0000-000000000001/resend',
      );
      expect(res.status).toBe(401);
    });
  });

  describe('DELETE /api/v1/admin/tenants/:id/pending-invites/:inviteId', () => {
    it('should reject unauthenticated requests', async () => {
      const res = await request(app).delete(
        '/api/v1/admin/tenants/00000000-0000-0000-0000-000000000000/pending-invites/00000000-0000-0000-0000-000000000001',
      );
      expect(res.status).toBe(401);
    });
  });
});
