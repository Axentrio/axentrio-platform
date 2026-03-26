import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { app } from '../../server';

describe('File Routes', () => {
  describe('POST /api/v1/files/upload-url', () => {
    it('should reject unauthenticated requests', async () => {
      const res = await request(app)
        .post('/api/v1/files/upload-url')
        .send({ fileName: 'test.png', fileType: 'image/png' });

      expect(res.status).toBe(401);
    });
  });

  describe('GET /api/v1/files/:id', () => {
    it('should reject unauthenticated requests', async () => {
      const res = await request(app).get(
        '/api/v1/files/00000000-0000-0000-0000-000000000000',
      );
      expect(res.status).toBe(401);
    });
  });
});
