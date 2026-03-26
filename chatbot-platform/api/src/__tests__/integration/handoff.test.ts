import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { app } from '../../server';

describe('Handoff Routes', () => {
  describe('POST /api/v1/handoffs/request', () => {
    it('should reject unauthenticated requests', async () => {
      const res = await request(app)
        .post('/api/v1/handoffs/request')
        .send({ sessionId: '00000000-0000-0000-0000-000000000000' });

      expect(res.status).toBe(401);
    });
  });

  describe('POST /api/v1/handoffs/accept', () => {
    it('should reject unauthenticated requests', async () => {
      const res = await request(app)
        .post('/api/v1/handoffs/accept')
        .send({ handoffId: '00000000-0000-0000-0000-000000000000' });

      expect(res.status).toBe(401);
    });
  });

  describe('GET /api/v1/handoffs/pending', () => {
    it('should reject unauthenticated requests', async () => {
      const res = await request(app).get('/api/v1/handoffs/pending');
      expect(res.status).toBe(401);
    });
  });
});
