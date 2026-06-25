import { describe, it, expect, beforeEach, vi } from 'vitest';

// ── Mocks (must come before imports) ────────────────────────────────────────

let mockRagSecret: string | undefined = 'test-secret';

vi.mock('../../config/environment', () => ({
  config: {
    n8n: {
      get ragInternalSecret() {
        return mockRagSecret;
      },
    },
  },
}));

const mockSearchKnowledge = vi.fn();
vi.mock('../../llm/rag.service', () => ({
  searchKnowledge: (...args: unknown[]) => mockSearchKnowledge(...args),
}));

vi.mock('../../database/data-source', () => ({
  AppDataSource: {
    query: vi.fn(),
    getRepository: vi.fn(),
  },
}));

vi.mock('../../utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// ── Imports (after mocks) ───────────────────────────────────────────────────

import express from 'express';
import request from 'supertest';
import ragSearchRoutes from '../../rag/rag-search.routes';

const VALID_UUID = '550e8400-e29b-41d4-a716-446655440000';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/internal/rag', ragSearchRoutes);
  return app;
}

describe('RAG Search Routes', () => {
  let app: express.Express;

  beforeEach(() => {
    vi.clearAllMocks();
    mockRagSecret = 'test-secret';
    app = createApp();
  });

  describe('verifyInternalAuth middleware', () => {
    it('should return 503 when RAG_INTERNAL_SECRET is not configured', async () => {
      mockRagSecret = undefined;

      const res = await request(app)
        .post('/internal/rag/search')
        .send({ tenantId: VALID_UUID, query: 'test' });

      expect(res.status).toBe(503);
      expect(res.body.error).toMatch(/not configured/);
    });

    it('should return 401 when Authorization header is missing', async () => {
      const res = await request(app)
        .post('/internal/rag/search')
        .send({ tenantId: VALID_UUID, query: 'test' });

      expect(res.status).toBe(401);
      expect(res.body.error).toBe('Unauthorized');
    });

    it('should return 401 when token is wrong', async () => {
      const res = await request(app)
        .post('/internal/rag/search')
        .set('Authorization', 'Bearer wrong-token')
        .send({ tenantId: VALID_UUID, query: 'test' });

      expect(res.status).toBe(401);
      expect(res.body.error).toBe('Unauthorized');
    });

    it('should return 200 with valid Bearer token', async () => {
      mockSearchKnowledge.mockResolvedValue({ chunks: [], response: '' });

      const res = await request(app)
        .post('/internal/rag/search')
        .set('Authorization', 'Bearer test-secret')
        .send({ tenantId: VALID_UUID, query: 'test query' });

      expect(res.status).toBe(200);
      expect(mockSearchKnowledge).toHaveBeenCalledWith(
        expect.anything(), // AppDataSource
        VALID_UUID,
        'test query',
        [],  // conversationHistory default
        5,   // maxChunks default
        undefined, // knowledgeBaseIds — undefined = tenant-wide (multi-bot Phase 3)
      );
    });
  });

  describe('request validation', () => {
    it('should return 400 when tenantId is missing', async () => {
      const res = await request(app)
        .post('/internal/rag/search')
        .set('Authorization', 'Bearer test-secret')
        .send({ query: 'test' });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Validation failed');
    });

    it('should return 400 when tenantId is not a valid UUID', async () => {
      const res = await request(app)
        .post('/internal/rag/search')
        .set('Authorization', 'Bearer test-secret')
        .send({ tenantId: 'not-a-uuid', query: 'test' });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Validation failed');
    });

    it('should return 400 when query is empty', async () => {
      const res = await request(app)
        .post('/internal/rag/search')
        .set('Authorization', 'Bearer test-secret')
        .send({ tenantId: VALID_UUID, query: '' });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Validation failed');
    });

    it('should return 400 when query is missing', async () => {
      const res = await request(app)
        .post('/internal/rag/search')
        .set('Authorization', 'Bearer test-secret')
        .send({ tenantId: VALID_UUID });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Validation failed');
    });
  });

  describe('search execution', () => {
    it('should pass conversationHistory and maxChunks when provided', async () => {
      mockSearchKnowledge.mockResolvedValue({ chunks: [], response: '' });
      const history = [{ role: 'user', content: 'hi' }];

      const res = await request(app)
        .post('/internal/rag/search')
        .set('Authorization', 'Bearer test-secret')
        .send({ tenantId: VALID_UUID, query: 'test', conversationHistory: history, maxChunks: 10 });

      expect(res.status).toBe(200);
      expect(mockSearchKnowledge).toHaveBeenCalledWith(
        expect.anything(),
        VALID_UUID,
        'test',
        history,
        10,
        undefined, // knowledgeBaseIds — undefined = tenant-wide (multi-bot Phase 3)
      );
    });

    it('should return 500 when searchKnowledge throws', async () => {
      mockSearchKnowledge.mockRejectedValue(new Error('DB down'));

      const res = await request(app)
        .post('/internal/rag/search')
        .set('Authorization', 'Bearer test-secret')
        .send({ tenantId: VALID_UUID, query: 'test' });

      expect(res.status).toBe(500);
      expect(res.body.error).toBe('Search failed');
    });
  });
});
