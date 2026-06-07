/**
 * Server-side contract for the widget's reconnect backfill (widget.js syncHistory).
 *
 * On (re)connect the widget calls GET /widget/history with the JWT from
 * /widget/init and renders any messages it missed while disconnected. This
 * locks down that contract: init returns a usable token, and history returns
 * persisted messages (including bot replies) with the id / content / sender.type
 * / createdAt shape the widget dedupes and renders on. (The browser-side render
 * is verified manually — widget.js is a static IIFE with no unit harness.)
 */
import { describe, it, expect, vi } from 'vitest';
import { createAuthMocks } from '../helpers/auth';

createAuthMocks();

vi.mock('@clerk/express', () => ({
  clerkMiddleware: () => (_req: any, _res: any, next: any) => next(),
}));
vi.mock('../../websocket/socket.handler', () => ({
  emitToSession: vi.fn(),
  emitToTenantAgents: vi.fn(),
  emitToAgent: vi.fn(),
  emitToRoom: vi.fn(),
}));
vi.mock('../../utils/audit', () => ({ logAudit: vi.fn().mockResolvedValue(undefined) }));

import request from 'supertest';
import { app } from '../../server';
import { createTestTenant, createTestAnchorBot, createTestParticipant, createTestMessage } from '../helpers/factories';

describe('Widget reconnect backfill — /widget/history contract', () => {
  it('returns persisted bot replies so the widget can backfill on reconnect', async () => {
    const tenant = await createTestTenant();
    await createTestAnchorBot(tenant); // publicKey === tenant.apiKey (the widget key)

    // 1. The widget initialises a session and gets its JWT.
    const init = await request(app)
      .post('/api/v1/widget/init')
      .send({ apiKey: tenant.apiKey, visitorId: `v-${Date.now()}` });
    expect(init.status).toBe(200);
    const token: string = init.body.data.token;
    const sessionId: string = init.body.data.session.id;
    expect(token).toBeTruthy();

    // 2. A bot reply is persisted while the widget is "offline" (the case that
    //    was silently lost before the syncHistory fix).
    const bot = await createTestParticipant(sessionId, { type: 'bot', name: 'Bot' });
    await createTestMessage(sessionId, tenant.id, bot.id, {
      type: 'text',
      content: 'Our hours are 9am to 6pm.',
    });

    // 3. The widget calls /widget/history on reconnect.
    const hist = await request(app)
      .get('/api/v1/widget/history')
      .set('Authorization', `Bearer ${token}`);
    expect(hist.status).toBe(200);

    const messages = hist.body.data as Array<{
      id: string;
      content: string;
      sender?: { type?: string };
      createdAt: string;
    }>;
    const reply = messages.find((m) => m.sender?.type === 'bot');
    expect(reply).toBeTruthy();
    expect(reply!.content).toBe('Our hours are 9am to 6pm.');
    expect(reply!.id).toBeTruthy();
    expect(reply!.createdAt).toBeTruthy();
  });

  it('rejects history without a widget token (401)', async () => {
    const res = await request(app).get('/api/v1/widget/history');
    expect(res.status).toBe(401);
  });
});
