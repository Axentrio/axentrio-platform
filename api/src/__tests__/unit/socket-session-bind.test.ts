import { describe, it, expect } from 'vitest';
import { assertSocketSession, authenticateSocket } from '../../websocket/socket.handler';
import { generateWidgetToken } from '../../middleware/auth.middleware';

function mockSocket(opts: { type?: 'agent' | 'widget'; boundSessionId?: string }) {
  const emitted: Array<[string, unknown]> = [];
  const socket = {
    id: 'sock-1',
    data: {
      user: opts.type ? { type: opts.type } : undefined,
      boundSessionId: opts.boundSessionId,
      tenantId: 'tenant-1',
    },
    emit: (ev: string, p: unknown) => { emitted.push([ev, p]); },
    _emitted: emitted,
  };
  return socket as never as Parameters<typeof assertSocketSession>[0] & { _emitted: typeof emitted };
}

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

describe('assertSocketSession — widget Socket.IO session binding (#19)', () => {
  it('agent socket may act on any session', () => {
    const s = mockSocket({ type: 'agent' });
    expect(assertSocketSession(s, A)).toBe(true);
    expect((s as never as { _emitted: unknown[] })._emitted).toHaveLength(0);
  });

  it('widget socket may act on its bound session', () => {
    const s = mockSocket({ type: 'widget', boundSessionId: A });
    expect(assertSocketSession(s, A)).toBe(true);
  });

  it('widget socket CANNOT act on another session (FORBIDDEN)', () => {
    const s = mockSocket({ type: 'widget', boundSessionId: A });
    expect(assertSocketSession(s, B)).toBe(false);
    const emitted = (s as never as { _emitted: Array<[string, { code: string }]> })._emitted;
    expect(emitted[0][0]).toBe('error');
    expect(emitted[0][1].code).toBe('FORBIDDEN');
  });

  it('widget socket with no bound session is rejected (fail closed)', () => {
    const s = mockSocket({ type: 'widget' });
    expect(assertSocketSession(s, A)).toBe(false);
  });

  it('unauthenticated socket is rejected', () => {
    const s = mockSocket({});
    expect(assertSocketSession(s, A)).toBe(false);
  });
});

function mockAuthSocket(query: Record<string, string> = {}, auth: Record<string, string> = {}) {
  const emitted: Array<[string, unknown]> = [];
  const socket = {
    id: 'sock-auth-1',
    handshake: { query, auth, headers: {} },
    data: {},
    emit: (ev: string, p: unknown) => { emitted.push([ev, p]); },
    _emitted: emitted,
  };
  return socket as never as Parameters<typeof assertSocketSession>[0] & {
    data: Record<string, unknown>;
    _emitted: typeof emitted;
  };
}

describe('authenticateSocket — widget token required', () => {
  it('rejects handshake with only query.apiKey (no widget token)', async () => {
    const socket = mockAuthSocket({ apiKey: 'bk_test', visitorId: 'v1' });
    await expect(authenticateSocket(socket)).rejects.toThrow('Authentication required');
  });

  it('binds boundSessionId from a real generateWidgetToken', async () => {
    const sessionId = A;
    const tenantId = B;
    const visitorId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    const widgetToken = generateWidgetToken(sessionId, tenantId, visitorId);

    const socket = mockAuthSocket({}, { widgetToken });
    await authenticateSocket(socket);

    expect(socket.data.boundSessionId).toBe(sessionId);
    expect(socket.data.tenantId).toBe(tenantId);
    expect(socket.data.user).toMatchObject({
      type: 'widget',
      tenantId,
      id: visitorId,
    });
    expect(assertSocketSession(socket, sessionId)).toBe(true);
    expect(assertSocketSession(socket, tenantId)).toBe(false);
  });
});
