import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { app } from '../../server';

describe('Auth Routes', () => {
  describe('POST /api/v1/auth/widget', () => {
    it('should return 400 when apiKey is missing', async () => {
      const res = await request(app)
        .post('/api/v1/auth/widget')
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('API key is required');
    });

    it('should return 401 for an invalid apiKey', async () => {
      const res = await request(app)
        .post('/api/v1/auth/widget')
        .send({ apiKey: 'nonexistent-key' });

      expect(res.status).toBe(401);
      expect(res.body.error).toBe('Invalid API key');
    });
  });

  describe('GET /api/v1/auth/me', () => {
    it('should return 401 when no Clerk auth is provided', async () => {
      const res = await request(app).get('/api/v1/auth/me');

      expect(res.status).toBe(401);
      expect(res.body.error).toContain('Unauthorized');
    });
  });
});
