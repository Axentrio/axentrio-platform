/**
 * PEFF-1: tenant switch leaked a Socket.IO client per switch.
 *
 * `reconnect()` used to `setTimeout(connectSocket, 1000)` after nulling
 * `socketRef`, so two switches inside the delay produced two live clients (each
 * with `reconnectionAttempts: Infinity`), and the timer outlived unmount.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act } from '@testing-library/react';

interface FakeSocket {
  id: string;
  connected: boolean;
  on: ReturnType<typeof vi.fn>;
  emit: ReturnType<typeof vi.fn>;
  removeAllListeners: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  io: { on: ReturnType<typeof vi.fn>; off: ReturnType<typeof vi.fn> };
}

const { ioMock, sockets, log } = vi.hoisted(() => {
  const sockets: FakeSocket[] = [];
  const log: string[] = [];
  const ioMock = vi.fn(() => {
    const socket: FakeSocket = {
      id: `s${sockets.length}`,
      connected: true,
      on: vi.fn(),
      emit: vi.fn(),
      removeAllListeners: vi.fn(),
      disconnect: vi.fn(() => {
        socket.connected = false;
        log.push(`disconnect:${socket.id}`);
      }),
      io: { on: vi.fn(), off: vi.fn() },
    };
    sockets.push(socket);
    log.push(`io:${socket.id}`);
    return socket;
  });
  return { ioMock, sockets, log };
});

vi.mock('socket.io-client', () => ({ io: ioMock }));

// Identities must be render-stable: `connectSocket` depends on `getToken`, so a
// fresh function per render would re-fire the connect effect and hide the leak.
const { clerkAuth, appAuth } = vi.hoisted(() => ({
  clerkAuth: { isSignedIn: true, getToken: async () => 'jwt' },
  appAuth: {
    user: { id: 'agent-1' },
    isAuthenticated: true,
    tenantId: 'tenant-1',
    notificationPreferences: { push: false, handoffRequest: false },
  },
}));

vi.mock('@clerk/clerk-react', () => ({ useAuth: () => clerkAuth }));

vi.mock('@auth/useAppAuth', () => ({ useAppAuth: () => appAuth }));

import { SocketProvider, useSocket } from './SocketContext';

let api: { reconnect: () => void } | null = null;

function Probe() {
  api = useSocket();
  return null;
}

const tree = (
  <SocketProvider>
    <Probe />
  </SocketProvider>
);

const liveSockets = () => sockets.filter((s) => s.connected);

describe('SocketProvider reconnect', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    sockets.length = 0;
    log.length = 0;
    ioMock.mockClear();
    api = null;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps exactly one live client across back-to-back tenant switches', () => {
    render(tree);
    expect(liveSockets()).toHaveLength(1);

    act(() => {
      api!.reconnect();
      api!.reconnect();
    });
    act(() => {
      vi.advanceTimersByTime(5000);
    });

    expect(liveSockets()).toHaveLength(1);
    // Every new client is preceded by the teardown of the previous one.
    expect(log).toEqual(['io:s0', 'disconnect:s0', 'io:s1', 'disconnect:s1', 'io:s2']);
    expect(sockets[0].removeAllListeners).toHaveBeenCalled();
    expect(sockets[0].io.off).toHaveBeenCalledWith('reconnect_attempt');
  });

  it('leaves no pending connect timer after reconnect or unmount', () => {
    const view = render(tree);

    act(() => {
      api!.reconnect();
    });
    expect(vi.getTimerCount()).toBe(0);

    const created = ioMock.mock.calls.length;
    act(() => {
      view.unmount();
    });
    act(() => {
      vi.advanceTimersByTime(5000);
    });

    expect(ioMock.mock.calls.length).toBe(created);
    expect(liveSockets()).toHaveLength(0);
  });
});
