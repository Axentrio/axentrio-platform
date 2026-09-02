/**
 * WebSocket Context - Socket.io Integration
 * Provides real-time communication for chat events
 */

import React, { createContext, useContext, useEffect, useRef, useCallback, useState } from 'react';
import { io, Socket } from 'socket.io-client';
import { WS_CONFIG } from '@config/api.config';
import { WS_EVENTS } from '@config/constants';
import { useAuth } from '@clerk/clerk-react';
import { useAppAuth } from '@auth/useAppAuth';
import { isDesktopNotificationsEnabled } from '@utils/desktopNotificationPref';
import { useTenantContextStore } from '../stores/tenantContextStore';
import type {
  TypingIndicator,
  Agent,
  DashboardMetrics,
  Notification,
  HandoffRequest,
  ConversationUpsertEvent,
  MessageCreatedEvent,
} from '@app-types/index';

// Event handler types
interface SocketEventHandlers {
  /** Normalized B-PR3a events — the ONLY list/detail/message feed the portal
   *  consumes. The legacy chat:new/chat:update were never emitted, and
   *  message:receive is left to the widget (listening to both would
   *  double-handle every message). */
  onConversationUpsert?: (event: ConversationUpsertEvent) => void;
  onMessageCreated?: (event: MessageCreatedEvent) => void;
  onTypingUpdate?: (typing: TypingIndicator) => void;
  onHandoffNew?: (handoff: HandoffRequest) => void;
  onHandoffUpdate?: (handoff: HandoffRequest) => void;
  onAgentUpdate?: (agent: Agent) => void;
  onNotification?: (notification: Notification) => void;
  onMetricsUpdate?: (metrics: DashboardMetrics) => void;
  onConnect?: () => void;
  onDisconnect?: (reason: string) => void;
  onError?: (error: Error) => void;
}

interface SocketContextType {
  socket: Socket | null;
  isConnected: boolean;
  isConnecting: boolean;
  connectionError: string | null;
  registerHandlers: (handlers: SocketEventHandlers) => string;
  unregisterHandlers: (handlerId: string) => void;
  joinChat: (chatId: string) => void;
  leaveChat: (chatId: string) => void;
  sendTyping: (chatId: string, isTyping: boolean) => void;
  updateStatus: (status: Agent['status']) => void;
  reconnect: () => void;
}

const SocketContext = createContext<SocketContextType | null>(null);

// Generate unique handler ID
const generateHandlerId = () => `handler_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

export const SocketProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const socketRef = useRef<Socket | null>(null);
  const handlersRef = useRef<Map<string, SocketEventHandlers>>(new Map());
  const { getToken, isSignedIn } = useAuth();
  const { user, isAuthenticated, tenantId, notificationPreferences } = useAppAuth();
  const tokenRef = useRef<string | null>(null);
  const notificationPrefsRef = useRef(notificationPreferences);
  
  const [isConnected, setIsConnected] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [connectionError, setConnectionError] = useState<string | null>(null);

  useEffect(() => {
    notificationPrefsRef.current = notificationPreferences;
  }, [notificationPreferences]);

  // Connect after REST identity exists (/auth/me → tenantId). Clerk `orgId` is
  // NOT required: REST already works off the same session when orgId is late/unset.
  const canConnect = !!(isSignedIn && isAuthenticated && tenantId);

  const connectSocket = useCallback(async () => {
    if (!isSignedIn || !isAuthenticated || !tenantId) {
      console.debug('[socket] skip connect', {
        url: WS_CONFIG.url,
        isSignedIn,
        isAuthenticated,
        tenantId,
      });
      return;
    }

    setIsConnecting(true);
    setConnectionError(null);
    console.debug('[socket] connecting', { url: WS_CONFIG.url, tenantId });

    const socket = io(WS_CONFIG.url, {
      ...WS_CONFIG.options,
      // Fetch a FRESH Clerk token before every (re)connection attempt. Clerk
      // JWTs expire in ~60s, so a token captured once would make every
      // reconnect fail auth — the socket would then exhaust its retries and
      // never recover. Socket.IO invokes this callback on each connect.
      auth: async (cb: (data: { token: string | null; tenantContext?: string }) => void) => {
        const tenantContext = useTenantContextStore.getState().activeTenant?.tenantId;
        try {
          const token = await getToken({ template: undefined });
          tokenRef.current = token;
          cb({ token, tenantContext });
        } catch {
          cb({ token: tokenRef.current, tenantContext });
        }
      },
    });

    socketRef.current = socket;

    // Connection events
    socket.on(WS_EVENTS.CONNECT, () => {
      console.log('Socket connected:', socket.id);
      setIsConnected(true);
      setIsConnecting(false);
      setConnectionError(null);
      
      // Join as agent
      if (user?.id) {
        socket.emit(WS_EVENTS.AGENT_JOIN, { agentId: user.id });
      }
      
      // Notify all handlers
      handlersRef.current.forEach((handlers) => {
        handlers.onConnect?.();
      });
    });

    socket.on(WS_EVENTS.DISCONNECT, (reason) => {
      console.log('Socket disconnected:', reason);
      setIsConnected(false);

      // Socket.IO auto-reconnects on transport drops, but NOT when the server
      // forcibly disconnects us (idle/auth timeout, deploy). In that case we
      // must reconnect manually — the auth callback fetches a fresh token.
      if (reason === 'io server disconnect') {
        setIsConnecting(true);
        socket.connect();
      } else {
        setIsConnecting(false);
      }

      handlersRef.current.forEach((handlers) => {
        handlers.onDisconnect?.(reason);
      });
    });

    socket.on(WS_EVENTS.CONNECT_ERROR, (error) => {
      console.error('[socket] connect_error', { url: WS_CONFIG.url, message: error.message, tenantId });
      setIsConnected(false);
      setIsConnecting(false);
      setConnectionError(error.message);

      handlersRef.current.forEach((handlers) => {
        handlers.onError?.(error);
      });
    });

    // Manager-level reconnection lifecycle — keeps the "Reconnecting…" banner
    // accurate while Socket.IO retries automatically with backoff.
    socket.io.on('reconnect_attempt', () => setIsConnecting(true));
    socket.io.on('reconnect', () => setIsConnecting(false));

    // Normalized conversation events (B-PR3a) — list + detail + messages.
    socket.on(WS_EVENTS.CONVERSATION_UPSERT, (event: ConversationUpsertEvent) => {
      handlersRef.current.forEach((handlers) => {
        handlers.onConversationUpsert?.(event);
      });
    });

    socket.on(WS_EVENTS.MESSAGE_CREATED, (event: MessageCreatedEvent) => {
      handlersRef.current.forEach((handlers) => {
        handlers.onMessageCreated?.(event);
      });
    });

    socket.on(WS_EVENTS.CHAT_TYPING_UPDATE, (typing: TypingIndicator) => {
      handlersRef.current.forEach((handlers) => {
        handlers.onTypingUpdate?.(typing);
      });
    });

    // Handoff events
    socket.on(WS_EVENTS.HANDOFF_NEW, (handoff: HandoffRequest) => {
      handlersRef.current.forEach((handlers) => {
        handlers.onHandoffNew?.(handoff);
      });
      // Browser desktop notification
      if (
        'Notification' in window &&
        isDesktopNotificationsEnabled() &&
        Notification.permission === 'granted' &&
        notificationPrefsRef.current.handoffRequest &&
        notificationPrefsRef.current.push
      ) {
        new Notification('New handoff request', {
          body: `A visitor needs assistance (${handoff.reason || 'escalation'})`,
          icon: '/favicon.ico',
        });
      }
    });

    socket.on(WS_EVENTS.HANDOFF_UPDATE, (handoff: HandoffRequest) => {
      handlersRef.current.forEach((handlers) => {
        handlers.onHandoffUpdate?.(handoff);
      });
    });

    // Agent events
    socket.on(WS_EVENTS.AGENT_UPDATE, (agent: Agent) => {
      handlersRef.current.forEach((handlers) => {
        handlers.onAgentUpdate?.(agent);
      });
    });

    // Notification events
    socket.on(WS_EVENTS.NOTIFICATION, (notification: Notification) => {
      handlersRef.current.forEach((handlers) => {
        handlers.onNotification?.(notification);
      });
    });

    // Metrics events
    socket.on(WS_EVENTS.METRICS_UPDATE, (metrics: DashboardMetrics) => {
      handlersRef.current.forEach((handlers) => {
        handlers.onMetricsUpdate?.(metrics);
      });
    });

  }, [isSignedIn, isAuthenticated, tenantId, getToken, user?.id]);

  // Disconnect socket
  const disconnectSocket = useCallback(() => {
    if (socketRef.current) {
      if (user?.id) {
        socketRef.current.emit(WS_EVENTS.AGENT_LEAVE, { agentId: user.id });
      }
      socketRef.current.disconnect();
      socketRef.current = null;
      setIsConnected(false);
    }
  }, [user?.id]);

  // Connect on mount and when auth changes
  useEffect(() => {
    if (canConnect) {
      connectSocket();
    } else {
      disconnectSocket();
    }

    return () => {
      disconnectSocket();
    };
  }, [canConnect, connectSocket, disconnectSocket]);

  // Recover promptly when the network returns or the tab is re-focused —
  // nudges Socket.IO to reconnect now instead of waiting out the backoff
  // (covers laptop sleep/wake and long idle periods).
  useEffect(() => {
    const nudge = () => {
      const s = socketRef.current;
      if (s && !s.connected) s.connect();
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible') nudge();
    };
    window.addEventListener('online', nudge);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.removeEventListener('online', nudge);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  // Register event handlers
  const registerHandlers = useCallback((handlers: SocketEventHandlers): string => {
    const handlerId = generateHandlerId();
    handlersRef.current.set(handlerId, handlers);
    return handlerId;
  }, []);

  // Unregister event handlers
  const unregisterHandlers = useCallback((handlerId: string) => {
    handlersRef.current.delete(handlerId);
  }, []);

  // Join a chat room — backend expects { sessionId }
  const joinChat = useCallback((chatId: string) => {
    if (socketRef.current && isConnected) {
      socketRef.current.emit(WS_EVENTS.CHAT_JOIN, { sessionId: chatId, agentId: user?.id });
    }
  }, [isConnected, user?.id]);

  // Leave a chat room — backend expects { sessionId }
  const leaveChat = useCallback((chatId: string) => {
    if (socketRef.current && isConnected) {
      socketRef.current.emit(WS_EVENTS.CHAT_LEAVE, { sessionId: chatId, agentId: user?.id });
    }
  }, [isConnected, user?.id]);

  // Send typing indicator — backend expects { sessionId, isTyping }
  const sendTyping = useCallback((chatId: string, isTyping: boolean) => {
    if (socketRef.current && isConnected) {
      socketRef.current.emit(WS_EVENTS.CHAT_TYPING, { sessionId: chatId, isTyping });
    }
  }, [isConnected]);

  // Update agent status
  const updateStatus = useCallback((status: Agent['status']) => {
    if (socketRef.current && isConnected) {
      socketRef.current.emit(WS_EVENTS.AGENT_STATUS, { agentId: user?.id, status });
    }
  }, [isConnected, user?.id]);

  // Reconnect manually
  const reconnect = useCallback(() => {
    disconnectSocket();
    setTimeout(connectSocket, 1000);
  }, [connectSocket, disconnectSocket]);

  const value: SocketContextType = {
    socket: socketRef.current,
    isConnected,
    isConnecting,
    connectionError,
    registerHandlers,
    unregisterHandlers,
    joinChat,
    leaveChat,
    sendTyping,
    updateStatus,
    reconnect,
  };

  return (
    <SocketContext.Provider value={value}>
      {children}
    </SocketContext.Provider>
  );
};

// Custom hook to use socket context
export const useSocket = (): SocketContextType => {
  const context = useContext(SocketContext);
  if (!context) {
    throw new Error('useSocket must be used within a SocketProvider');
  }
  return context;
};
