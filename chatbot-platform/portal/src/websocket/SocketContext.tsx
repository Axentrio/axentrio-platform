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
import type { 
  Chat, 
  Message, 
  HandoffRequest, 
  TypingIndicator, 
  Agent,
  DashboardMetrics,
  Notification 
} from '@app-types/index';

// Event handler types
interface SocketEventHandlers {
  onChatNew?: (chat: Chat) => void;
  onChatUpdate?: (chat: Chat) => void;
  onMessageReceived?: (message: Message) => void;
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
  sendMessage: (chatId: string, message: Partial<Message>) => void;
  sendTyping: (chatId: string, isTyping: boolean) => void;
  acceptHandoff: (handoffId: string) => void;
  declineHandoff: (handoffId: string, reason?: string) => void;
  updateStatus: (status: Agent['status']) => void;
  reconnect: () => void;
}

const SocketContext = createContext<SocketContextType | null>(null);

// Generate unique handler ID
const generateHandlerId = () => `handler_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

export const SocketProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const socketRef = useRef<Socket | null>(null);
  const handlersRef = useRef<Map<string, SocketEventHandlers>>(new Map());
  const { getToken, isSignedIn, orgId } = useAuth();
  const { user, isAuthenticated } = useAppAuth();
  const tokenRef = useRef<string | null>(null);
  
  const [isConnected, setIsConnected] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [connectionError, setConnectionError] = useState<string | null>(null);

  // Initialize socket connection
  const connectSocket = useCallback(async () => {
    if (!isSignedIn || !isAuthenticated || !orgId) return;

    setIsConnecting(true);
    setConnectionError(null);

    // Get fresh Clerk token with org claim for socket auth
    const token = await getToken({ template: undefined });
    tokenRef.current = token;

    const socket = io(WS_CONFIG.url, {
      ...WS_CONFIG.options,
      auth: {
        token,
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
      setIsConnecting(false);
      
      handlersRef.current.forEach((handlers) => {
        handlers.onDisconnect?.(reason);
      });
    });

    socket.on(WS_EVENTS.CONNECT_ERROR, (error) => {
      console.error('Socket connection error:', error);
      setIsConnected(false);
      setIsConnecting(false);
      setConnectionError(error.message);
      
      handlersRef.current.forEach((handlers) => {
        handlers.onError?.(error);
      });
    });

    // Chat events
    socket.on(WS_EVENTS.CHAT_NEW, (chat: Chat) => {
      handlersRef.current.forEach((handlers) => {
        handlers.onChatNew?.(chat);
      });
    });

    socket.on(WS_EVENTS.CHAT_UPDATE, (chat: Chat) => {
      handlersRef.current.forEach((handlers) => {
        handlers.onChatUpdate?.(chat);
      });
    });

    socket.on(WS_EVENTS.CHAT_MESSAGE_RECEIVED, (message: Message) => {
      handlersRef.current.forEach((handlers) => {
        handlers.onMessageReceived?.(message);
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

  }, [isSignedIn, isAuthenticated, orgId, getToken, user?.id]);

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
    if (isAuthenticated && isSignedIn && orgId) {
      connectSocket();
    } else {
      disconnectSocket();
    }

    return () => {
      disconnectSocket();
    };
  }, [isAuthenticated, isSignedIn, orgId, connectSocket, disconnectSocket]);

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

  // Join a chat room
  const joinChat = useCallback((chatId: string) => {
    if (socketRef.current && isConnected) {
      socketRef.current.emit(WS_EVENTS.CHAT_JOIN, { chatId, agentId: user?.id });
    }
  }, [isConnected, user?.id]);

  // Leave a chat room
  const leaveChat = useCallback((chatId: string) => {
    if (socketRef.current && isConnected) {
      socketRef.current.emit(WS_EVENTS.CHAT_LEAVE, { chatId, agentId: user?.id });
    }
  }, [isConnected, user?.id]);

  // Send a message
  const sendMessage = useCallback((chatId: string, message: Partial<Message>) => {
    if (socketRef.current && isConnected) {
      socketRef.current.emit(WS_EVENTS.CHAT_MESSAGE, { chatId, message });
    }
  }, [isConnected]);

  // Send typing indicator
  const sendTyping = useCallback((chatId: string, isTyping: boolean) => {
    if (socketRef.current && isConnected) {
      socketRef.current.emit(WS_EVENTS.CHAT_TYPING, { chatId, isTyping });
    }
  }, [isConnected]);

  // Accept handoff
  const acceptHandoff = useCallback((handoffId: string) => {
    if (socketRef.current && isConnected) {
      socketRef.current.emit(WS_EVENTS.HANDOFF_ACCEPT, { handoffId, agentId: user?.id });
    }
  }, [isConnected, user?.id]);

  // Decline handoff
  const declineHandoff = useCallback((handoffId: string, reason?: string) => {
    if (socketRef.current && isConnected) {
      socketRef.current.emit(WS_EVENTS.HANDOFF_DECLINE, { handoffId, agentId: user?.id, reason });
    }
  }, [isConnected, user?.id]);

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
    sendMessage,
    sendTyping,
    acceptHandoff,
    declineHandoff,
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

export default SocketContext;
