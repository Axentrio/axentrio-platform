import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { app } from '../../server';

describe('Tenant Routes', () => {
  describe('GET /api/v1/tenants/me', () => {
    it('should reject unauthenticated requests', async () => {
      const res = await request(app).get('/api/v1/tenants/me');
      expect(res.status).toBe(401);
    });
  });

  describe('PATCH /api/v1/tenants/me', () => {
    it('should reject unauthenticated requests', async () => {
      const res = await request(app)
        .patch('/api/v1/tenants/me')
        .send({ name: 'Updated' });
      expect(res.status).toBe(401);
    });
  });

  describe('POST /api/v1/tenants/me/invite', () => {
    it('should reject unauthenticated requests', async () => {
      const res = await request(app)
        .post('/api/v1/tenants/me/invite')
        .send({ email: 'new@test.com', role: 'agent' });
      expect(res.status).toBe(401);
    });
  });

  describe('GET /api/v1/tenants/me/pending-invites', () => {
    it('should reject unauthenticated requests', async () => {
      const res = await request(app).get('/api/v1/tenants/me/pending-invites');
      expect(res.status).toBe(401);
    });
  });

  describe('POST /api/v1/tenants/me/users/:userId/deactivate', () => {
    it('should reject unauthenticated requests', async () => {
      const res = await request(app).post(
        '/api/v1/tenants/me/users/00000000-0000-0000-0000-000000000000/deactivate',
      );
      expect(res.status).toBe(401);
    });
  });

  describe('POST /api/v1/tenants/me/users/:userId/reactivate', () => {
    it('should reject unauthenticated requests', async () => {
      const res = await request(app).post(
        '/api/v1/tenants/me/users/00000000-0000-0000-0000-000000000000/reactivate',
      );
      expect(res.status).toBe(401);
    });
  });
});
