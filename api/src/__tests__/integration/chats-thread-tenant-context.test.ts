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
let otherTenantId: string;
let homeSessionId: string;
let targetSessionId: string;
let otherSessionId: string;
const MARKER = 'thread-context-marker';

beforeEach(async () => {
  const home = await createTestTenant();
  const target = await createTestTenant();
  const other = await createTestTenant();
  homeTenantId = home.id;
  targetTenantId = target.id;
  otherTenantId = other.id;

  const homeSession = await createTestSession(homeTenantId, { status: 'bot' });
  homeSessionId = homeSession.id;
  const homeParticipant = await createTestParticipant(homeSession.id);
  await createTestMessage(homeSession.id, homeTenantId, homeParticipant.id, { content: 'home-marker' });

  const session = await createTestSession(targetTenantId, { status: 'bot' });
  targetSessionId = session.id;
  const participant = await createTestParticipant(session.id);
  await createTestMessage(session.id, targetTenantId, participant.id, { content: MARKER });

  const otherSession = await createTestSession(otherTenantId, { status: 'bot' });
  otherSessionId = otherSession.id;
  const otherParticipant = await createTestParticipant(otherSession.id);
  await createTestMessage(otherSession.id, otherTenantId, otherParticipant.id, { content: 'other-marker' });
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

  it('a SUPER ADMIN without the header cannot read the target session', async () => {
    const user = await createTestUser(homeTenantId, { role: 'super_admin' });
    Object.assign(auth, { userId: user.id, tenantId: homeTenantId, role: 'super_admin' });

    const targetThread = await request(app).get(`/api/v1/chats/${targetSessionId}/thread`);
    expect(targetThread.status).toBe(404);

    const homeThread = await request(app).get(`/api/v1/chats/${homeSessionId}/thread`);
    expect(homeThread.status).toBe(200);
    expect(homeThread.body.data.sessionId).toBe(homeSessionId);
  });

  it('a SUPER ADMIN with the header cannot read a third tenant session', async () => {
    const user = await createTestUser(homeTenantId, { role: 'super_admin' });
    Object.assign(auth, { userId: user.id, tenantId: homeTenantId, role: 'super_admin' });

    const res = await request(app)
      .get(`/api/v1/chats/${otherSessionId}/thread`)
      .set('x-tenant-context', targetTenantId);

    expect(res.status).toBe(404);
  });

  it('a SUPER ADMIN does not keep the viewed tenant on the next request', async () => {
    const user = await createTestUser(homeTenantId, { role: 'super_admin' });
    Object.assign(auth, { userId: user.id, tenantId: homeTenantId, role: 'super_admin' });

    const viewed = await request(app)
      .get(`/api/v1/chats/${targetSessionId}/thread`)
      .set('x-tenant-context', targetTenantId);
    expect(viewed.status).toBe(200);

    const later = await request(app).get(`/api/v1/chats/${targetSessionId}/thread`);
    expect(later.status).toBe(404);

    const home = await request(app).get(`/api/v1/chats/${homeSessionId}/thread`);
    expect(home.status).toBe(200);
    expect(home.body.data.sessionId).toBe(homeSessionId);
  });

  it('a SUPER ADMIN with a non-UUID header gets 400, not 500', async () => {
    const user = await createTestUser(homeTenantId, { role: 'super_admin' });
    Object.assign(auth, { userId: user.id, tenantId: homeTenantId, role: 'super_admin' });

    const res = await request(app)
      .get(`/api/v1/chats/${targetSessionId}/thread`)
      .set('x-tenant-context', 'not-a-uuid');

    expect(res.status).toBe(400);
    expect(res.body.error?.message).toBe('Invalid tenant context');
  });

  it('a SUPER ADMIN cannot view a cancelled tenant', async () => {
    const cancelled = await createTestTenant({ status: 'cancelled' });
    const user = await createTestUser(homeTenantId, { role: 'super_admin' });
    Object.assign(auth, { userId: user.id, tenantId: homeTenantId, role: 'super_admin' });

    const res = await request(app)
      .get(`/api/v1/chats/${targetSessionId}/thread`)
      .set('x-tenant-context', cancelled.id);

    expect(res.status).toBe(403);
    expect(res.body.error?.message).toBe('Tenant is cancelled');
  });
});
