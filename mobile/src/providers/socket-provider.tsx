import { useAuth } from '@clerk/expo';
import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { io, type Socket } from 'socket.io-client';

import { env } from '@/lib/env';

const SocketContext = createContext<Socket | null>(null);

/**
 * Agent Socket.IO connection. The `auth` callback re-runs on every (re)connect,
 * so the socket always presents a fresh Clerk token. Connected only while
 * signed in; torn down on sign-out.
 */
export function SocketProvider({ children }: { children: ReactNode }) {
  const { isSignedIn, getToken } = useAuth();
  const [socket, setSocket] = useState<Socket | null>(null);
  // getToken is a fresh ref each render; keep it in a ref so the effect only
  // re-runs when sign-in state changes (not every render → infinite loop).
  const getTokenRef = useRef(getToken);
  getTokenRef.current = getToken;

  useEffect(() => {
    if (!isSignedIn) return;

    const s = io(env.wsUrl, {
      transports: ['websocket'],
      auth: (cb) => {
        getTokenRef.current()
          .then((token) => cb({ token: token ?? '' }))
          .catch(() => cb({ token: '' }));
      },
    });
    setSocket(s);

    return () => {
      s.disconnect();
      setSocket(null);
    };
  }, [isSignedIn]);

  return <SocketContext.Provider value={socket}>{children}</SocketContext.Provider>;
}

export function useSocket(): Socket | null {
  return useContext(SocketContext);
}

/** Subscribe to a socket event for the lifetime of the component. */
export function useSocketEvent<T = unknown>(event: string, handler: (payload: T) => void) {
  const socket = useSocket();
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => {
    if (!socket) return;
    const fn = (payload: T) => handlerRef.current(payload);
    socket.on(event, fn as (...args: unknown[]) => void);
    return () => {
      socket.off(event, fn as (...args: unknown[]) => void);
    };
  }, [socket, event]);
}
