import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { app } from '../../server';

describe('Agent Routes', () => {
  describe('GET /api/v1/agents', () => {
    it('should reject unauthenticated requests', async () => {
      const res = await request(app).get('/api/v1/agents');
      expect(res.status).toBe(401);
    });
  });

  describe('PATCH /api/v1/agents/:id/status', () => {
    it('should reject unauthenticated requests', async () => {
      const res = await request(app)
        .patch('/api/v1/agents/00000000-0000-0000-0000-000000000000/status')
        .send({ status: 'online' });
      expect(res.status).toBe(401);
    });
  });

  describe('GET /api/v1/agents/:id/metrics', () => {
    it('should reject unauthenticated requests', async () => {
      const res = await request(app).get(
        '/api/v1/agents/00000000-0000-0000-0000-000000000000/metrics',
      );
      expect(res.status).toBe(401);
    });
  });
});
