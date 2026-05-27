import { describe, it, expect, vi } from 'vitest';
import { createAuthMocks } from '../helpers/auth';

createAuthMocks();

// Mock @clerk/express global middleware (clerkMiddleware) to be a no-op
vi.mock('@clerk/express', () => ({
  clerkMiddleware: () => (_req: any, _res: any, next: any) => next(),
}));

// Mock socket handler to avoid real WebSocket operations
vi.mock('../../websocket/socket.handler', () => ({
  emitToSession: vi.fn(),
  emitToTenantAgents: vi.fn(),
}));

// Mock audit logging
vi.mock('../../utils/audit', () => ({
  logAudit: vi.fn().mockResolvedValue(undefined),
}));

import request from 'supertest';
import { app } from '../../server';

describe('Auth Routes', () => {
  describe('POST /api/v1/auth/widget', () => {
    it('should return 422 when apiKey is missing', async () => {
      const res = await request(app)
        .post('/api/v1/auth/widget')
        .send({});

      expect(res.status).toBe(422);
      expect(res.body.error).toBeDefined();
    });

    it('should return 401 for an invalid apiKey', async () => {
      const res = await request(app)
        .post('/api/v1/auth/widget')
        .send({ apiKey: 'nonexistent-key' });

      expect(res.status).toBe(401);
      expect(res.body.error.message).toBe('Invalid API key');
    });
  });
});
