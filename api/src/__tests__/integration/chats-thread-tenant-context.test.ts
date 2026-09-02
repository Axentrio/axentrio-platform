/**
 * Super-admin tenant switching on chat thread and detail.
 *
 * GET /chats/:id/thread and GET /chats/:id read req.user.tenantId.
 * Before resolveTenantContext also set that field, a super admin who
 * viewed another tenant got 404 Session not found for a chat that
 * the list (req.tenantId) already showed.
 *
 * Deliberately NOT createAuthMocks(): that helper stubs resolveTenantContext.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const auth = vi.hoisted(() => ({ userId: '', tenantId: '', role: 'admin' }));

vi.mock('@clerk/express', () => ({
  clerkMiddleware: () => (_req: any, _res: any, next: any) => next(),
}));

vi.mock('../../middleware/clerk.middleware', () => ({
  requireClerkAuth: (req: any, _res: any, next: any) => {
    req.userId = auth.userId;
    req.tenantId = auth.tenantId;
    req.userRole = auth.role;
    req.user = { id: auth.userId, email: 'test@example.com', role: auth.role, tenantId: auth.tenantId, type: 'agent' };
    next();
  },
  autoProvision: (_req: any, _res: any, next: any) => next(),
  invalidateProvisionCache: () => {},
  resolveClerkIds: () => ({}),
}));

vi.mock('../../websocket/socket.handler', () => ({
  emitToSession: vi.fn(),
  emitToTenantAgents: vi.fn(),
  emitToAgent: vi.fn(),
  emitToUser: vi.fn(),
}));

import request from 'supertest';
import { app } from '../../server';
import {
  createTestTenant,
  createTestUser,
  createTestSession,
  createTestParticipant,
  createTestMessage,
} from '../helpers/factories';

let homeTenantId: string;
let targetTenantId: string;
let targetSessionId: string;
const MARKER = 'thread-context-marker';

beforeEach(async () => {
  const home = await createTestTenant();
  const target = await createTestTenant();
  homeTenantId = home.id;
  targetTenantId = target.id;

  const session = await createTestSession(targetTenantId, { status: 'bot' });
  targetSessionId = session.id;
  const participant = await createTestParticipant(session.id);
  await createTestMessage(session.id, targetTenantId, participant.id, { content: MARKER });
});

describe('chat thread and detail — X-Tenant-Context', () => {
  it('a SUPER ADMIN reads the target session thread and detail', async () => {
    const user = await createTestUser(homeTenantId, { role: 'super_admin' });
    Object.assign(auth, { userId: user.id, tenantId: homeTenantId, role: 'super_admin' });

    const thread = await request(app)
      .get(`/api/v1/chats/${targetSessionId}/thread`)
      .set('x-tenant-context', targetTenantId);

    expect(thread.status).toBe(200);
    expect(thread.body.data.sessionId).toBe(targetSessionId);

    const detail = await request(app)
      .get(`/api/v1/chats/${targetSessionId}`)
      .set('x-tenant-context', targetTenantId);

    expect(detail.status).toBe(200);
    expect(detail.body.data.id).toBe(targetSessionId);
    expect(detail.body.data.tenantId).toBe(targetTenantId);
  });

  it('a NON-super-admin cannot use the header to read another tenant session', async () => {
    const user = await createTestUser(homeTenantId, { role: 'admin' });
    Object.assign(auth, { userId: user.id, tenantId: homeTenantId, role: 'admin' });

    const thread = await request(app)
      .get(`/api/v1/chats/${targetSessionId}/thread`)
      .set('x-tenant-context', targetTenantId);

    expect(thread.status).toBe(404);

    const detail = await request(app)
      .get(`/api/v1/chats/${targetSessionId}`)
      .set('x-tenant-context', targetTenantId);

    expect(detail.status).toBe(404);
  });
});
