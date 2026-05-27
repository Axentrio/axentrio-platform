import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { app } from '../../server';

describe('Clerk Webhook Routes', () => {
  describe('POST /api/v1/webhooks/clerk', () => {
    it('should reject requests without svix headers', async () => {
      const res = await request(app)
        .post('/api/v1/webhooks/clerk')
        .send({ type: 'user.created', data: {} });

      // Without proper Svix signature headers, should fail
      expect([400, 401, 403]).toContain(res.status);
    });
  });
});
