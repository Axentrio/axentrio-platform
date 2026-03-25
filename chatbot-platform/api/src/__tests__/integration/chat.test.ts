import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { app } from '../../server';

describe('Chat Routes', () => {
  describe('GET /api/v1/chats/sessions', () => {
    it('should reject unauthenticated requests', async () => {
      const res = await request(app).get('/api/v1/chats/sessions');

      expect(res.status).toBe(401);
      expect(res.body.error).toContain('Unauthorized');
    });
  });

  describe('GET /api/v1/chats/:sessionId/history (widget)', () => {
    it('should return 401 without a widget token', async () => {
      const res = await request(app).get(
        '/api/v1/chats/00000000-0000-0000-0000-000000000000/history',
      );

      expect(res.status).toBe(401);
      expect(res.body.error).toContain('Unauthorized');
    });
  });

  describe('POST /api/v1/chats/:sessionId/message', () => {
    it('should return 401 without a widget token', async () => {
      const res = await request(app)
        .post('/api/v1/chats/00000000-0000-0000-0000-000000000000/message')
        .send({ content: 'hello' });

      expect(res.status).toBe(401);
      expect(res.body.error).toContain('Unauthorized');
    });
  });

  describe('GET /api/v1/chats/:sessionId/status', () => {
    it('should return 401 without a widget token', async () => {
      const res = await request(app).get(
        '/api/v1/chats/00000000-0000-0000-0000-000000000000/status',
      );

      expect(res.status).toBe(401);
      expect(res.body.error).toContain('Unauthorized');
    });
  });

  describe('POST /api/v1/chats/:sessionId/close (widget)', () => {
    it('should return 401 without a widget token', async () => {
      const res = await request(app)
        .post('/api/v1/chats/00000000-0000-0000-0000-000000000000/close')
        .send({});

      expect(res.status).toBe(401);
      expect(res.body.error).toContain('Unauthorized');
    });
  });

  describe('POST /api/v1/chats/:id/transfer', () => {
    it('should reject unauthenticated requests', async () => {
      const res = await request(app)
        .post('/api/v1/chats/00000000-0000-0000-0000-000000000000/transfer')
        .send({ agentId: 'some-agent' });

      expect(res.status).toBe(401);
      expect(res.body.error).toContain('Unauthorized');
    });
  });

  describe('POST /api/v1/chats/:id/read', () => {
    it('should reject unauthenticated requests', async () => {
      const res = await request(app).post(
        '/api/v1/chats/00000000-0000-0000-0000-000000000000/read',
      );

      expect(res.status).toBe(401);
      expect(res.body.error).toContain('Unauthorized');
    });
  });

  describe('DELETE /api/v1/chats/:sessionId/participants/:participantId', () => {
    it('should reject unauthenticated requests', async () => {
      const res = await request(app).delete(
        '/api/v1/chats/00000000-0000-0000-0000-000000000000/participants/p1',
      );

      expect(res.status).toBe(401);
      expect(res.body.error).toContain('Unauthorized');
    });
  });
});
