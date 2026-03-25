/**
 * WidgetTest — Standalone chat test page
 * Uses widget API key auth (NOT Clerk).
 * URL: /widget-test?apiKey={tenant-api-key}
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import axios from 'axios';
import { io, Socket } from 'socket.io-client';
import { Send, Wifi, WifiOff, Bot, User, MessageCircle } from 'lucide-react';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const API_BASE_URL =
  import.meta.env.VITE_API_URL || 'http://localhost:5000/api';
const WS_BASE_URL =
  import.meta.env.VITE_WS_URL || 'http://localhost:5000';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
interface ChatMessage {
  id: string;
  content: string;
  sender: 'visitor' | 'bot' | 'agent';
  timestamp: Date;
}

type SessionStatus = 'bot' | 'waiting' | 'agent' | 'closed';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function generateVisitorId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    // Fallback for environments without crypto.randomUUID
    return 'v-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
  }
}

function statusLabel(status: SessionStatus): string {
  switch (status) {
    case 'bot':
      return 'Connected to bot';
    case 'waiting':
      return 'Waiting for agent';
    case 'agent':
      return 'Connected to agent';
    case 'closed':
      return 'Session closed';
    default:
      return '';
  }
}

function statusColor(status: SessionStatus): string {
  switch (status) {
    case 'bot':
      return 'text-indigo-400';
    case 'waiting':
      return 'text-yellow-400';
    case 'agent':
      return 'text-emerald-400';
    case 'closed':
      return 'text-red-400';
    default:
      return 'text-[#9ca3bf]';
  }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------
const WidgetTest: React.FC = () => {
  // --- URL params ---
  const apiKey = new URLSearchParams(window.location.search).get('apiKey');

  // --- State ---
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [connected, setConnected] = useState(false);
  const [sessionStatus, setSessionStatus] = useState<SessionStatus>('bot');
  const [isTyping, setIsTyping] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [_tenantId, setTenantId] = useState<string | null>(null);
  const [input, setInput] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [initialising, setInitialising] = useState(true);

  const socketRef = useRef<Socket | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const visitorIdRef = useRef<string>(generateVisitorId());

  // --- Auto-scroll ---
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isTyping]);

  // --- Init & Socket ---
  useEffect(() => {
    if (!apiKey) {
      setInitialising(false);
      return;
    }

    let socket: Socket | null = null;
    let cancelled = false;

    const init = async () => {
      try {
        // 1. Widget init
        const { data } = await axios.post(`${API_BASE_URL}/v1/widget/init`, {
          apiKey,
          visitorId: visitorIdRef.current,
          metadata: {},
        });

        if (cancelled) return;

        const { token, sessionId: sid, tenantId: tid } = data;
        setSessionId(sid);
        setTenantId(tid);

        // 2. Connect Socket.io
        socket = io(WS_BASE_URL, {
          query: {
            apiKey,
            visitorId: visitorIdRef.current,
            tenantId: tid,
          },
          auth: token ? { token } : undefined,
          transports: ['websocket', 'polling'],
        });

        socketRef.current = socket;

        socket.on('connect', () => {
          if (cancelled) return;
          setConnected(true);

          // 3. Join session
          socket!.emit('session:join', { sessionId: sid });

          // Default welcome message
          setMessages((prev) => [
            ...prev,
            {
              id: generateVisitorId(),
              content:
                "You're in the queue, an agent will be with you shortly.",
              sender: 'bot',
              timestamp: new Date(),
            },
          ]);
        });

        socket.on('disconnect', () => {
          if (!cancelled) setConnected(false);
        });

        // 4. Listeners
        socket.on(
          'message:receive',
          (payload: { id?: string; content: string; sender?: string }) => {
            if (cancelled) return;
            setIsTyping(false);
            setMessages((prev) => [
              ...prev,
              {
                id: payload.id || generateVisitorId(),
                content: payload.content,
                sender:
                  (payload.sender as ChatMessage['sender']) || 'bot',
                timestamp: new Date(),
              },
            ]);
          },
        );

        socket.on('typing:indicator', (payload: { isTyping?: boolean }) => {
          if (!cancelled) setIsTyping(payload?.isTyping ?? true);
        });

        socket.on('handoff:accepted', () => {
          if (cancelled) return;
          setSessionStatus('agent');
          setMessages((prev) => [
            ...prev,
            {
              id: generateVisitorId(),
              content: 'An agent has joined the conversation.',
              sender: 'bot',
              timestamp: new Date(),
            },
          ]);
        });

        socket.on(
          'session:closed',
          () => {
            if (cancelled) return;
            setSessionStatus('closed');
            setMessages((prev) => [
              ...prev,
              {
                id: generateVisitorId(),
                content: 'This session has been closed.',
                sender: 'bot',
                timestamp: new Date(),
              },
            ]);
          },
        );
      } catch (err: any) {
        if (!cancelled) {
          setError(
            err?.response?.data?.message ||
              err?.message ||
              'Failed to initialise chat session.',
          );
        }
      } finally {
        if (!cancelled) setInitialising(false);
      }
    };

    init();

    return () => {
      cancelled = true;
      if (socket) {
        socket.disconnect();
        socketRef.current = null;
      }
    };
  }, [apiKey]);

  // --- Send message ---
  const handleSend = useCallback(() => {
    const trimmed = input.trim();
    if (!trimmed || !socketRef.current || !sessionId) return;

    const msg: ChatMessage = {
      id: generateVisitorId(),
      content: trimmed,
      sender: 'visitor',
      timestamp: new Date(),
    };

    setMessages((prev) => [...prev, msg]);
    socketRef.current.emit('message:send', {
      sessionId,
      content: trimmed,
      type: 'text',
    });
    setInput('');
  }, [input, sessionId]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  // -----------------------------------------------------------------------
  // Render helpers
  // -----------------------------------------------------------------------
  if (!apiKey) {
    return (
      <div className="flex items-center justify-center h-screen bg-[#0d0f17]">
        <div className="bg-[#161821] border border-[#2a2d3e] rounded-2xl p-8 max-w-md text-center">
          <MessageCircle className="mx-auto mb-4 text-indigo-400" size={40} />
          <h2 className="text-xl font-semibold text-[#f1f3f9] mb-2">
            API Key Required
          </h2>
          <p className="text-[#9ca3bf] text-sm">
            Please provide an API key via the URL query parameter:
          </p>
          <code className="mt-3 block text-xs text-indigo-300 bg-[#1e2030] px-4 py-2 rounded-lg break-all">
            /widget-test?apiKey=YOUR_TENANT_API_KEY
          </code>
        </div>
      </div>
    );
  }

  if (initialising) {
    return (
      <div className="flex items-center justify-center h-screen bg-[#0d0f17]">
        <div className="flex flex-col items-center gap-3">
          <div className="w-8 h-8 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin" />
          <span className="text-[#9ca3bf] text-sm">Connecting...</span>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-screen bg-[#0d0f17]">
        <div className="bg-[#161821] border border-[#2a2d3e] rounded-2xl p-8 max-w-md text-center">
          <WifiOff className="mx-auto mb-4 text-red-400" size={40} />
          <h2 className="text-xl font-semibold text-[#f1f3f9] mb-2">
            Connection Error
          </h2>
          <p className="text-red-400 text-sm">{error}</p>
        </div>
      </div>
    );
  }

  // --- Main chat UI ---
  return (
    <div className="flex flex-col h-screen bg-[#0d0f17]">
      {/* Header */}
      <header className="flex items-center justify-between px-4 py-3 bg-[#161821] border-b border-[#2a2d3e]">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 bg-indigo-600 rounded-xl flex items-center justify-center">
            <MessageCircle size={16} className="text-white" />
          </div>
          <span className="font-semibold text-[#f1f3f9]">HandsOff Chat</span>
        </div>
        <div className="flex items-center gap-2">
          {connected ? (
            <Wifi size={16} className="text-emerald-400" />
          ) : (
            <WifiOff size={16} className="text-red-400" />
          )}
          <span
            className={`w-2 h-2 rounded-full ${
              connected ? 'bg-emerald-400' : 'bg-red-400'
            }`}
          />
        </div>
      </header>

      {/* Session status bar */}
      <div className="flex items-center justify-center gap-2 px-4 py-1.5 bg-[#161821] border-b border-[#2a2d3e]">
        {sessionStatus === 'bot' && <Bot size={14} className="text-indigo-400" />}
        {sessionStatus === 'agent' && <User size={14} className="text-emerald-400" />}
        <span className={`text-xs font-medium ${statusColor(sessionStatus)}`}>
          {statusLabel(sessionStatus)}
        </span>
      </div>

      {/* Message list */}
      <div className="flex-1 overflow-y-auto px-4 py-4">
        <div className="max-w-lg mx-auto flex flex-col gap-3">
          {messages.map((msg) => {
            const isVisitor = msg.sender === 'visitor';
            return (
              <div
                key={msg.id}
                className={`flex ${isVisitor ? 'justify-end' : 'justify-start'}`}
              >
                {/* Avatar for bot/agent */}
                {!isVisitor && (
                  <div className="flex-shrink-0 w-7 h-7 rounded-full bg-[#1e2030] flex items-center justify-center mr-2 mt-1">
                    {msg.sender === 'agent' ? (
                      <User size={14} className="text-emerald-400" />
                    ) : (
                      <Bot size={14} className="text-indigo-400" />
                    )}
                  </div>
                )}

                <div
                  className={`rounded-2xl px-4 py-2 max-w-[80%] break-words text-sm leading-relaxed ${
                    isVisitor
                      ? 'bg-indigo-600 text-white'
                      : 'bg-[#161821] text-[#f1f3f9]'
                  }`}
                >
                  {msg.content}
                  <div
                    className={`text-[10px] mt-1 ${
                      isVisitor ? 'text-indigo-200' : 'text-[#9ca3bf]'
                    }`}
                  >
                    {msg.timestamp.toLocaleTimeString([], {
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </div>
                </div>

                {/* Avatar for visitor */}
                {isVisitor && (
                  <div className="flex-shrink-0 w-7 h-7 rounded-full bg-indigo-600/20 flex items-center justify-center ml-2 mt-1">
                    <User size={14} className="text-indigo-300" />
                  </div>
                )}
              </div>
            );
          })}

          {/* Typing indicator */}
          {isTyping && (
            <div className="flex justify-start">
              <div className="flex-shrink-0 w-7 h-7 rounded-full bg-[#1e2030] flex items-center justify-center mr-2 mt-1">
                <Bot size={14} className="text-indigo-400" />
              </div>
              <div className="bg-[#161821] rounded-2xl px-4 py-3 flex items-center gap-1">
                <span className="w-2 h-2 bg-[#9ca3bf] rounded-full animate-bounce [animation-delay:0ms]" />
                <span className="w-2 h-2 bg-[#9ca3bf] rounded-full animate-bounce [animation-delay:150ms]" />
                <span className="w-2 h-2 bg-[#9ca3bf] rounded-full animate-bounce [animation-delay:300ms]" />
              </div>
            </div>
          )}

          <div ref={messagesEndRef} />
        </div>
      </div>

      {/* Input bar */}
      <div className="px-4 py-3 bg-[#161821] border-t border-[#2a2d3e]">
        <div className="max-w-lg mx-auto flex items-center gap-2">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={
              sessionStatus === 'closed'
                ? 'Session closed'
                : 'Type a message...'
            }
            disabled={sessionStatus === 'closed'}
            className="flex-1 bg-[#1e2030] border border-[#2a2d3e] text-[#f1f3f9] rounded-xl px-4 py-2.5 text-sm placeholder-[#9ca3bf] focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed transition"
          />
          <button
            onClick={handleSend}
            disabled={!input.trim() || sessionStatus === 'closed'}
            className="bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 disabled:cursor-not-allowed text-white rounded-xl p-2.5 transition"
          >
            <Send size={18} />
          </button>
        </div>
      </div>
    </div>
  );
};

export default WidgetTest;
