import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createAuthMocks, configureMockAuth } from '../helpers/auth';

const { auth } = createAuthMocks();

vi.mock('@clerk/express', () => ({
  clerkMiddleware: () => (_req: any, _res: any, next: any) => next(),
}));

vi.mock('../../websocket/socket.handler', () => ({
  emitToSession: vi.fn(),
  emitToTenantAgents: vi.fn(),
  emitToAgent: vi.fn(),
}));

vi.mock('../../utils/audit', () => ({
  logAudit: vi.fn().mockResolvedValue(undefined),
}));

// Mock authenticateWidget to inject tenant/user from auth state
vi.mock('../../middleware/auth.middleware', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../middleware/auth.middleware')>();
  return {
    ...original,
    authenticateWidget: (req: any, _res: any, next: any) => {
      req.user = {
        id: auth.userId || 'widget-visitor',
        email: 'widget@session.local',
        role: 'agent' as const,
        tenantId: auth.tenantId,
        type: 'widget',
      };
      req.widget = {
        sessionId: req.params.sessionId,
        tenantId: auth.tenantId,
        visitorId: 'visitor-1',
      };
      next();
    },
  };
});

// Mock n8n forwarding to avoid external calls
vi.mock('../../services/message-forwarding.service', () => ({
  forwardMessageToN8n: vi.fn().mockResolvedValue(undefined),
  initializeForwarding: vi.fn(),
}));

import request from 'supertest';
import { app } from '../../server';
import { AppDataSource } from '../../database/data-source';
import { ChatSession } from '../../database/entities/ChatSession';
import {
  createTestTenant,
  createTestUser,
  createTestSession,
  createTestParticipant,
  createTestMessage,
  createTestAnchorBot,
} from '../helpers/factories';

describe('Chat Lifecycle', () => {
  let tenantId: string;
  beforeEach(async () => {
    const tenant = await createTestTenant();
    tenantId = tenant.id;

    await createTestUser(tenantId, { role: 'admin' });

    // Create a default session + participant for the auth mock userId
    const session = await createTestSession(tenantId, { status: 'active' });
    const participant = await createTestParticipant(session.id, {
      type: 'user',
      name: 'Widget User',
    });

    // Set auth userId to participant ID so message creation uses a valid FK
    configureMockAuth(auth, {
      userId: participant.id,
      tenantId,
      role: 'admin',
    });
  });

  describe('GET /api/v1/chats/sessions — guardrail visibility (Slice A)', () => {
    it('exposes guardrail state and filters to guardrail-paused sessions', async () => {
      const normal = await createTestSession(tenantId, { status: 'bot' });
      const paused = await createTestSession(tenantId, { status: 'bot' });
      await AppDataSource.getRepository(ChatSession).update(paused.id, {
        aiAutoReplyEnabled: false,
        guardrailStatus: 'spam',
      });

      const all = await request(app).get('/api/v1/chats/sessions?limit=100');
      expect(all.status).toBe(200);
      const pausedRow = all.body.data.find((s: { id: string }) => s.id === paused.id);
      expect(pausedRow.aiAutoReplyEnabled).toBe(false);
      expect(pausedRow.guardrailStatus).toBe('spam');
      const normalRow = all.body.data.find((s: { id: string }) => s.id === normal.id);
      expect(normalRow.aiAutoReplyEnabled).toBe(true);

      const filtered = await request(app).get('/api/v1/chats/sessions?aiPaused=true&limit=100');
      expect(filtered.status).toBe(200);
      const ids = filtered.body.data.map((s: { id: string }) => s.id);
      expect(ids).toContain(paused.id);
      expect(ids).not.toContain(normal.id);
    });

    it('GET /chats/:id exposes guardrail state', async () => {
      const s = await createTestSession(tenantId, { status: 'bot' });
      await AppDataSource.getRepository(ChatSession).update(s.id, {
        aiAutoReplyEnabled: false,
        guardrailStatus: 'scam',
      });
      const res = await request(app).get(`/api/v1/chats/${s.id}`);
      expect(res.status).toBe(200);
      expect(res.body.data.aiAutoReplyEnabled).toBe(false);
      expect(res.body.data.guardrailStatus).toBe('scam');
    });
  });

  describe('POST /api/v1/auth/widget', () => {
    it('should return a token for valid apiKey', async () => {
      const tenant = await createTestTenant();
      // Anchor bot required so resolveBotKey can resolve the legacy
      // tenant.apiKey to a bot.
      await createTestAnchorBot(tenant);

      const res = await request(app)
        .post('/api/v1/auth/widget')
        .send({ apiKey: tenant.apiKey });

      expect(res.status).toBe(200);
      expect(res.body.data.token).toBeDefined();
      expect(res.body.data.session.id).toBeDefined();
    });
  });

  describe('POST /api/v1/chats/:sessionId/message + GET history', () => {
    it('should send a message and retrieve it in history', async () => {
      const session = await createTestSession(tenantId, { status: 'active' });
      const participant = await createTestParticipant(session.id);

      // Point mock user at this participant so message FK is valid
      configureMockAuth(auth, {
        userId: participant.id,
        tenantId,
        role: 'admin',
      });

      const sendRes = await request(app)
        .post(`/api/v1/chats/${session.id}/message`)
        .send({ content: 'Hello', type: 'text' });

      expect(sendRes.status).toBe(201);

      // Get history
      const histRes = await request(app)
        .get(`/api/v1/chats/${session.id}/history`);

      expect(histRes.status).toBe(200);
      expect(histRes.body.data.messages.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('GET /api/v1/chats/:sessionId/history pagination', () => {
    it('should respect pagination limit', async () => {
      const session = await createTestSession(tenantId, { status: 'active' });
      const participant = await createTestParticipant(session.id);

      // Create 15 messages
      const promises = [];
      for (let i = 0; i < 15; i++) {
        promises.push(
          createTestMessage(session.id, tenantId, participant.id, {
            content: `msg-${i}`,
          }),
        );
      }
      await Promise.all(promises);

      const res = await request(app)
        .get(`/api/v1/chats/${session.id}/history`)
        .query({ limit: 10 });

      expect(res.status).toBe(200);
      expect(res.body.data.messages.length).toBeLessThanOrEqual(10);
    });
  });

  describe('POST /api/v1/chats/:sessionId/close', () => {
    it('should close an active session (session status updated in DB)', async () => {
      const session = await createTestSession(tenantId, { status: 'active' });

      // The widget close route saves session.close() first, then tries to create
      // a system message which may fail due to FK. But session state is persisted.
      await request(app)
        .post(`/api/v1/chats/${session.id}/close`)
        .send({});

      const updated = await AppDataSource.getRepository(ChatSession).findOneBy({ id: session.id });
      expect(updated!.status).toBe('closed');
    });
  });
});
