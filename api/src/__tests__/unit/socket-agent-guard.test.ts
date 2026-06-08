import { describe, it, expect } from 'vitest';
import { denyIfNotAgent } from '../../websocket/socket.handler';

function mockSocket(type?: 'agent' | 'widget') {
  const emitted: Array<[string, unknown]> = [];
  const socket = {
    id: 'sock-1',
    data: { user: type ? { type } : undefined, tenantId: 'tenant-1' },
    emit: (ev: string, payload: unknown) => { emitted.push([ev, payload]); },
    _emitted: emitted,
  };
  return socket as never as Parameters<typeof denyIfNotAgent>[0] & { _emitted: typeof emitted };
}

describe('denyIfNotAgent — agent-only socket events (#19)', () => {
  it('allows an agent socket (no deny, no error)', () => {
    const s = mockSocket('agent');
    expect(denyIfNotAgent(s, 'agent:join')).toBe(false);
    expect((s as never as { _emitted: unknown[] })._emitted).toHaveLength(0);
  });

  it('denies a widget socket and emits FORBIDDEN', () => {
    const s = mockSocket('widget');
    expect(denyIfNotAgent(s, 'handoff:accept')).toBe(true);
    const emitted = (s as never as { _emitted: Array<[string, { code: string; event: string }]> })._emitted;
    expect(emitted[0][0]).toBe('error');
    expect(emitted[0][1].code).toBe('FORBIDDEN');
    expect(emitted[0][1].event).toBe('handoff:accept');
  });

  it('denies an unauthenticated socket (no user)', () => {
    const s = mockSocket(undefined);
    expect(denyIfNotAgent(s, 'agent:leave')).toBe(true);
  });
});
