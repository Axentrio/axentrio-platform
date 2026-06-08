/**
 * WidgetTest — Chat widget preview & test page
 * Uses widget API key auth (NOT Clerk).
 * URL: /widget-test?apiKey={tenant-api-key}
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import axios from 'axios';
import { io, Socket } from 'socket.io-client';
import {
  Send,
  WifiOff,
  Bot,
  User,
  MessageCircle,
  ChevronDown,
  ChevronUp,
  Copy,
  Check,
  X,
  ArrowUpRight,
  Minus,
  Code2,
  Zap,
  Shield,
  Palette,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { extractApiErrorMessage } from '@services/apiClient';

const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:5000/api';
const WS_BASE_URL = import.meta.env.VITE_WS_URL || 'http://localhost:5000';

interface ChatMessage {
  id: string;
  content: string;
  sender: 'visitor' | 'bot' | 'agent';
  timestamp: Date;
  metadata?: { quickReplies?: string[] } | null;
}

interface LogEntry {
  id: string;
  timestamp: Date;
  type: 'info' | 'send' | 'receive' | 'error' | 'socket';
  message: string;
}

type SessionStatus = 'bot' | 'waiting' | 'agent' | 'closed';

function uid(): string {
  try { return crypto.randomUUID(); }
  catch { return 'v-' + Math.random().toString(36).slice(2) + Date.now().toString(36); }
}

function statusLabel(s: SessionStatus): string {
  return { bot: 'Online', waiting: 'Waiting for agent', agent: 'Speaking with agent', closed: 'Closed' }[s] ?? '';
}

function timeStr(d: Date): string {
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function logTime(d: Date): string {
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

// ==========================================================================
// Chat Widget
// ==========================================================================
function ChatWidget({
  messages, setMessages, input, setInput, onSend, onKeyDown, connected, sessionStatus,
  isTyping, messagesEndRef, isOpen, onToggle, onClose,
}: {
  messages: ChatMessage[]; setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>;
  input: string; setInput: (v: string) => void;
  onSend: (_e?: any, text?: string) => void; onKeyDown: (e: React.KeyboardEvent) => void;
  connected: boolean; sessionStatus: SessionStatus; isTyping: boolean;
  messagesEndRef: React.RefObject<HTMLDivElement>;
  isOpen: boolean; onToggle: () => void; onClose: () => void;
}) {
  if (!isOpen) {
    return (
      <button
        type="button"
        onClick={onToggle}
        aria-label="Open chat"
        className="group w-14 h-14 rounded-full bg-[#4338ca] text-white flex items-center justify-center shadow-[0_4px_24px_rgba(67,56,202,0.35)] transition-transform duration-200 hover:scale-[1.06] active:scale-95 cursor-pointer"
      >
        <MessageCircle size={22} strokeWidth={2.2} />
      </button>
    );
  }

  return (
    <div className="w-[370px] h-[520px] rounded-[18px] overflow-hidden flex flex-col shadow-[0_8px_48px_rgba(0,0,0,0.12),0_1px_4px_rgba(0,0,0,0.06)] border border-[#e8e5de]/60 bg-[#fcfbf9]">
      {/* Header — warm, not saturated */}
      <div className="relative px-4 py-3.5 bg-[#4338ca] flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-[10px] bg-white/[0.14] flex items-center justify-center backdrop-blur-sm">
            <MessageCircle size={17} className="text-white/90" strokeWidth={2} />
          </div>
          <div>
            <div className="text-[14px] font-semibold text-white tracking-[-0.01em]">
              Support
            </div>
            <div className="flex items-center gap-1.5 mt-px">
              <span className={cn(
                'w-[5px] h-[5px] rounded-full',
                connected ? 'bg-emerald-300' : 'bg-red-300',
              )} />
              <span className="text-[11px] text-white/60 font-medium">
                {connected ? statusLabel(sessionStatus) : 'Reconnecting...'}
              </span>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-0.5">
          <button type="button" onClick={onClose} aria-label="Minimize" className="w-7 h-7 rounded-lg hover:bg-white/10 flex items-center justify-center transition-colors cursor-pointer">
            <Minus size={13} className="text-white/60" />
          </button>
          <button type="button" onClick={onClose} aria-label="Close" className="w-7 h-7 rounded-lg hover:bg-white/10 flex items-center justify-center transition-colors cursor-pointer">
            <X size={13} className="text-white/60" />
          </button>
        </div>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-4 py-4">
        <div className="flex flex-col gap-3.5">
          {messages.length === 0 && (
            <div className="flex flex-col items-center justify-center py-10 text-center">
              <div className="w-10 h-10 rounded-xl bg-[#4338ca]/[0.07] flex items-center justify-center mb-3">
                <MessageCircle size={18} className="text-[#4338ca]/60" />
              </div>
              <p className="text-[13px] font-medium text-[#3d3929]">
                How can we help?
              </p>
              <p className="text-[12px] text-[#9c9584] mt-0.5 max-w-[200px]">
                Ask us anything — we typically reply in under a minute.
              </p>
            </div>
          )}

          {messages.map((msg, idx) => {
            const isVisitor = msg.sender === 'visitor';
            const quickReplies = (!isVisitor && msg.metadata?.quickReplies) || [];
            const isLastBotMsg = !isVisitor && idx === messages.length - 1;
            return (
              <React.Fragment key={msg.id}>
                <div className={cn('flex gap-2', isVisitor ? 'justify-end' : 'justify-start')}>
                  {!isVisitor && (
                    <div className="flex-shrink-0 w-6 h-6 rounded-lg bg-[#4338ca]/[0.08] flex items-center justify-center mt-0.5">
                      {msg.sender === 'agent'
                        ? <User size={11} className="text-[#4338ca]" strokeWidth={2.5} />
                        : <Bot size={11} className="text-[#4338ca]" strokeWidth={2.5} />
                      }
                    </div>
                  )}
                  <div className={cn(
                    'max-w-[78%] text-[13px] leading-[1.55] px-3.5 py-2.5 whitespace-pre-wrap',
                    isVisitor
                      ? 'bg-[#4338ca] text-white rounded-[14px] rounded-br-[4px]'
                      : 'bg-[#f0ede6] text-[#2d2a23] rounded-[14px] rounded-bl-[4px]',
                  )}>
                    {msg.content}
                    <div className={cn('text-[10px] mt-1 leading-none', isVisitor ? 'text-white/50' : 'text-[#b5ae9e]')}>
                      {timeStr(msg.timestamp)}
                    </div>
                  </div>
                </div>
                {isLastBotMsg && quickReplies.length > 0 && (
                  <div className="flex flex-wrap gap-2 pl-8 mt-1">
                    {quickReplies.map((qr: string) => (
                      <button
                        type="button"
                        key={qr}
                        onClick={() => {
                          // Remove quick replies after click
                          setMessages(prev => prev.map(m => m.id === msg.id ? { ...m, metadata: null } : m));
                          onSend(null, qr);
                        }}
                        className="text-[12px] font-medium px-3 py-1.5 rounded-full border-[1.5px] border-[#4338ca] text-[#4338ca] bg-white hover:bg-[#4338ca] hover:text-white transition-colors cursor-pointer"
                      >
                        {qr}
                      </button>
                    ))}
                  </div>
                )}
              </React.Fragment>
            );
          })}

          {isTyping && (
            <div className="flex gap-2 justify-start">
              <div className="flex-shrink-0 w-6 h-6 rounded-lg bg-[#4338ca]/[0.08] flex items-center justify-center mt-0.5">
                <Bot size={11} className="text-[#4338ca]" strokeWidth={2.5} />
              </div>
              <div className="bg-[#f0ede6] rounded-[14px] rounded-bl-[4px] px-4 py-3 flex items-center gap-[5px]">
                {[0, 150, 300].map((delay) => (
                  <span key={delay} className="w-[5px] h-[5px] bg-[#b5ae9e] rounded-full animate-bounce" style={{ animationDelay: `${delay}ms` }} />
                ))}
              </div>
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>
      </div>

      {/* Input */}
      <div className="px-3.5 py-3 border-t border-[#e8e5de]/80">
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            aria-label="Write a message"
            placeholder={sessionStatus === 'closed' ? 'Session closed' : 'Write a message...'}
            disabled={sessionStatus === 'closed'}
            className="flex-1 bg-[#f5f3ee] text-[#2d2a23] text-[13px] rounded-xl px-3.5 py-2.5 border border-[#e8e5de] placeholder:text-[#b5ae9e] focus:outline-none focus:border-[#4338ca]/40 focus:ring-2 focus:ring-[#4338ca]/10 disabled:opacity-40 transition-all"
          />
          <button
            type="button"
            onClick={onSend}
            disabled={!input.trim() || sessionStatus === 'closed'}
            aria-label="Send message"
            className="w-9 h-9 rounded-xl bg-[#4338ca] hover:bg-[#3730a3] disabled:bg-[#e8e5de] disabled:cursor-not-allowed text-white flex items-center justify-center transition-colors cursor-pointer active:scale-95"
          >
            <Send size={14} strokeWidth={2.2} />
          </button>
        </div>
        <div className="text-center mt-2">
          <span className="text-[10px] text-[#c7c1b4] tracking-wide">
            Powered by <span className="font-medium text-[#b5ae9e]">Axentrio</span>
          </span>
        </div>
      </div>
    </div>
  );
}

// ==========================================================================
// Developer Panel
// ==========================================================================
function CopyBtn({
  text,
  label,
  copied,
  copyText,
}: {
  text: string;
  label: string;
  copied: string | null;
  copyText: (text: string, label: string) => void;
}) {
  return (
    <button type="button" onClick={() => copyText(text, label)} className="flex items-center gap-1 text-[#78716c] hover:text-[#44403c] transition-colors cursor-pointer group" aria-label={`Copy ${label}`}>
      <span className="font-mono text-[11px] truncate max-w-[140px]">{text.slice(0, 20)}...</span>
      {copied === label
        ? <Check size={10} className="text-emerald-500 shrink-0" />
        : <Copy size={10} className="shrink-0 opacity-0 group-hover:opacity-100 transition-opacity" />
      }
    </button>
  );
}

function DevPanel({
  sessionId, tenantId, connected, sessionStatus, logs, apiKey,
}: {
  sessionId: string | null; tenantId: string | null; connected: boolean;
  sessionStatus: SessionStatus; logs: LogEntry[]; apiKey: string;
}) {
  const [copied, setCopied] = useState<string | null>(null);
  const [showEmbed, setShowEmbed] = useState(false);
  const logEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => { logEndRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [logs]);

  const copyText = (text: string, label: string) => {
    navigator.clipboard.writeText(text);
    setCopied(label);
    setTimeout(() => setCopied(null), 1500);
  };

  const embedSnippet = `<script\n  src="${window.location.origin}/widget.js"\n  data-api-key="${apiKey}"\n  async\n></script>`;

  const logColors: Record<LogEntry['type'], string> = {
    info: 'text-[#6366f1]',
    send: 'text-[#059669]',
    receive: 'text-[#7c3aed]',
    error: 'text-[#dc2626]',
    socket: 'text-[#d97706]',
  };

  const logDots: Record<LogEntry['type'], string> = {
    info: 'bg-[#6366f1]',
    send: 'bg-[#059669]',
    receive: 'bg-[#7c3aed]',
    error: 'bg-[#dc2626]',
    socket: 'bg-[#d97706]',
  };

  return (
    <div className="h-full flex flex-col bg-[#faf9f7] border-l border-[#e8e5de]">
      {/* Header */}
      <div className="flex items-center gap-2 px-5 py-3.5 border-b border-[#e8e5de]">
        <Code2 size={14} className="text-[#a8a29e]" strokeWidth={2.2} />
        <span className="text-[12px] font-semibold text-[#78716c] tracking-wide uppercase">
          Inspector
        </span>
      </div>

      {/* Session info */}
      <div className="px-5 py-3.5 border-b border-[#e8e5de] space-y-2.5">
        <div className="flex items-center justify-between">
          <span className="text-[11px] text-[#a8a29e] font-medium uppercase tracking-wider">Status</span>
          <div className="flex items-center gap-1.5">
            <span className={cn('w-[6px] h-[6px] rounded-full', connected ? 'bg-emerald-400' : 'bg-red-400')} />
            <span className={cn('text-[12px] font-medium', connected ? 'text-emerald-600' : 'text-red-500')}>
              {connected ? 'Connected' : 'Disconnected'}
            </span>
          </div>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-[11px] text-[#a8a29e] font-medium uppercase tracking-wider">Mode</span>
          <span className="text-[12px] text-[#57534e] font-medium capitalize">{sessionStatus}</span>
        </div>
        {sessionId && (
          <div className="flex items-center justify-between">
            <span className="text-[11px] text-[#a8a29e] font-medium uppercase tracking-wider">Session</span>
            <CopyBtn text={sessionId} label="session" copied={copied} copyText={copyText} />
          </div>
        )}
        {tenantId && (
          <div className="flex items-center justify-between">
            <span className="text-[11px] text-[#a8a29e] font-medium uppercase tracking-wider">Tenant</span>
            <CopyBtn text={tenantId} label="tenant" copied={copied} copyText={copyText} />
          </div>
        )}
      </div>

      {/* Embed snippet */}
      <div className="px-5 py-3 border-b border-[#e8e5de]">
        <button
          type="button"
          onClick={() => setShowEmbed(!showEmbed)}
          className="flex items-center justify-between w-full text-[#78716c] hover:text-[#44403c] transition-colors cursor-pointer"
        >
          <span className="text-[11px] font-semibold uppercase tracking-wider">Embed Code</span>
          {showEmbed ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
        </button>
        {showEmbed && (
          <div className="mt-2.5 relative">
            <pre className="bg-[#292524] rounded-lg p-3 text-[10.5px] text-[#a8a29e] overflow-x-auto leading-relaxed font-mono">
              {embedSnippet}
            </pre>
            <button
              type="button"
              onClick={() => copyText(embedSnippet, 'embed')}
              className="absolute top-2 right-2 w-6 h-6 rounded-md bg-white/10 hover:bg-white/20 flex items-center justify-center transition-colors cursor-pointer"
              aria-label="Copy embed code"
            >
              {copied === 'embed' ? <Check size={10} className="text-emerald-400" /> : <Copy size={10} className="text-[#a8a29e]" />}
            </button>
          </div>
        )}
      </div>

      {/* Event log */}
      <div className="flex-1 overflow-y-auto px-5 py-3">
        <div className="space-y-1.5">
          {logs.map((log) => (
            <div key={log.id} className="flex items-start gap-2 text-[11px] leading-relaxed">
              <span className="text-[#c4c0b8] shrink-0 font-mono tabular-nums w-[65px]">{logTime(log.timestamp)}</span>
              <span className={cn('w-[5px] h-[5px] rounded-full shrink-0 mt-[5px]', logDots[log.type])} />
              <span className={cn('shrink-0 font-medium w-[52px]', logColors[log.type])}>
                {log.type}
              </span>
              <span className="text-[#78716c] break-all">{log.message}</span>
            </div>
          ))}
          {logs.length === 0 && (
            <div className="text-[#c4c0b8] py-8 text-center text-[12px]">
              Waiting for events...
            </div>
          )}
          <div ref={logEndRef} />
        </div>
      </div>
    </div>
  );
}

// ==========================================================================
// Mock Website
// ==========================================================================
function MockWebsite() {
  return (
    <div className="h-full bg-[#fcfbf9] overflow-hidden">
      {/* Nav */}
      <div className="bg-white/80 backdrop-blur-sm border-b border-[#e8e5de]/60 px-10 py-4 flex items-center justify-between">
        <div className="flex items-center gap-10">
          <div className="text-[15px] font-bold text-[#2d2a23] tracking-tight">
            acme<span className="text-[#4338ca]">.</span>co
          </div>
          <nav className="flex items-center gap-7">
            {['Product', 'Pricing', 'Changelog'].map((item) => (
              <span key={item} className="text-[13px] text-[#9c9584] hover:text-[#57534e] transition-colors cursor-default font-medium">
                {item}
              </span>
            ))}
          </nav>
        </div>
        <div className="flex items-center gap-4">
          <span className="text-[13px] text-[#9c9584] cursor-default font-medium">Log in</span>
          <div className="px-4 py-[7px] bg-[#2d2a23] text-white text-[13px] font-medium rounded-lg cursor-default">
            Get started
          </div>
        </div>
      </div>

      {/* Hero — asymmetric, editorial */}
      <div className="px-10 pt-24 pb-20 max-w-[640px]">
        <div className="inline-flex items-center gap-2 text-[12px] font-medium text-[#4338ca] mb-8">
          <Zap size={12} strokeWidth={2.5} />
          <span>Now with AI-powered responses</span>
        </div>
        <h1 className="text-[44px] font-bold text-[#1c1917] leading-[1.1] tracking-[-0.025em]">
          Customer support
          <br />
          <span className="text-[#a8a29e]">that runs itself.</span>
        </h1>
        <p className="text-[15px] text-[#78716c] mt-5 leading-relaxed max-w-[440px]">
          AI handles conversations. Humans step in when it matters.
          Every interaction visible in one dashboard.
        </p>
        <div className="flex items-center gap-3 mt-10">
          <div className="px-5 py-2.5 bg-[#4338ca] text-white text-[13px] font-semibold rounded-lg cursor-default hover:bg-[#3730a3] transition-colors">
            Start free trial
          </div>
          <div className="px-5 py-2.5 text-[#57534e] text-[13px] font-medium rounded-lg border border-[#e8e5de] flex items-center gap-1.5 cursor-default hover:border-[#d6d3cc] transition-colors">
            See it work
            <ArrowUpRight size={13} strokeWidth={2.2} />
          </div>
        </div>
      </div>

      {/* Features — varied layout, not identical cards */}
      <div className="px-10 flex gap-8 max-w-[640px]">
        <div className="flex items-start gap-3">
          <div className="w-8 h-8 rounded-lg bg-[#4338ca]/[0.06] flex items-center justify-center shrink-0 mt-0.5">
            <Zap size={14} className="text-[#4338ca]" strokeWidth={2.2} />
          </div>
          <div>
            <div className="text-[13px] font-semibold text-[#2d2a23]">AI-first</div>
            <div className="text-[12px] text-[#a8a29e] mt-0.5 leading-relaxed">Resolves 80% of queries without human intervention.</div>
          </div>
        </div>
        <div className="flex items-start gap-3">
          <div className="w-8 h-8 rounded-lg bg-emerald-500/[0.06] flex items-center justify-center shrink-0 mt-0.5">
            <Shield size={14} className="text-emerald-600" strokeWidth={2.2} />
          </div>
          <div>
            <div className="text-[13px] font-semibold text-[#2d2a23]">Handoff</div>
            <div className="text-[12px] text-[#a8a29e] mt-0.5 leading-relaxed">Seamless escalation to human agents when needed.</div>
          </div>
        </div>
        <div className="flex items-start gap-3">
          <div className="w-8 h-8 rounded-lg bg-amber-500/[0.06] flex items-center justify-center shrink-0 mt-0.5">
            <Palette size={14} className="text-amber-600" strokeWidth={2.2} />
          </div>
          <div>
            <div className="text-[13px] font-semibold text-[#2d2a23]">White-label</div>
            <div className="text-[12px] text-[#a8a29e] mt-0.5 leading-relaxed">Your brand, your colors, your domain.</div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ==========================================================================
// Main
// ==========================================================================
const WidgetTest: React.FC = () => {
  const apiKey = new URLSearchParams(window.location.search).get('apiKey');

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [connected, setConnected] = useState(false);
  const [sessionStatus, setSessionStatus] = useState<SessionStatus>('bot');
  const [isTyping, setIsTyping] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [tenantId, setTenantId] = useState<string | null>(null);
  const [input, setInput] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [initialising, setInitialising] = useState(true);
  const [widgetOpen, setWidgetOpen] = useState(true);
  const [logs, setLogs] = useState<LogEntry[]>([]);

  const socketRef = useRef<Socket | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const visitorIdRef = useRef<string>(uid());

  const addLog = useCallback((type: LogEntry['type'], message: string) => {
    setLogs((prev) => [...prev, { id: uid(), timestamp: new Date(), type, message }]);
  }, []);

  useEffect(() => { messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages, isTyping]);

  useEffect(() => {
    if (!apiKey) { setInitialising(false); return; }

    let socket: Socket | null = null;
    let cancelled = false;

    const init = async () => {
      try {
        addLog('info', 'Initializing session...');

        const { data: resp } = await axios.post(`${API_BASE_URL}/widget/init`, {
          apiKey, visitorId: visitorIdRef.current, metadata: {},
        });

        if (cancelled) return;

        const { session, token } = resp.data ?? resp;
        const sid = session?.id ?? resp.sessionId;

        let tid: string | undefined;
        try { const p = JSON.parse(atob(token.split('.')[1])); tid = p.tenantId; } catch { /* */ }

        setSessionId(sid);
        setTenantId(tid ?? null);
        addLog('info', `Session created: ${sid?.slice(0, 8)}...`);

        // Load existing messages (greeting + history)
        try {
          const { data: histResp } = await axios.get(`${API_BASE_URL}/widget/history`, {
            headers: { Authorization: `Bearer ${token}` },
          });
          const histMsgs = (histResp?.data ?? histResp ?? []) as Array<{ id: string; content: string; metadata?: any; createdAt: string; sender?: { type?: string } }>;
          if (histMsgs.length > 0 && !cancelled) {
            setMessages(histMsgs.map(m => ({
              id: m.id,
              content: m.content,
              sender: (m.sender?.type === 'bot' ? 'bot' : m.sender?.type === 'user' ? 'visitor' : 'bot') as ChatMessage['sender'],
              timestamp: new Date(m.createdAt),
              metadata: m.metadata,
            })));
          }
        } catch { /* history load failed, continue without */ }

        socket = io(WS_BASE_URL, {
          query: { apiKey, visitorId: visitorIdRef.current },
          transports: ['websocket', 'polling'],
        });

        socketRef.current = socket;

        socket.on('connect_error', (err) => {
          addLog('error', `Connection failed: ${err.message}`);
          if (!cancelled) setError(`WebSocket: ${err.message}`);
        });

        socket.on('connect', () => {
          if (cancelled) return;
          setConnected(true);
          addLog('socket', `Connected (${socket!.id})`);
          socket!.emit('session:join', { sessionId: sid });
          addLog('socket', `Joined session ${sid?.slice(0, 8)}...`);
        });

        socket.on('disconnect', (reason) => {
          if (!cancelled) { setConnected(false); addLog('socket', `Disconnected: ${reason}`); }
        });

        socket.on('message:receive', (payload: { id?: string; content: string; sender?: string; senderType?: string; metadata?: any }) => {
          if (cancelled) return;
          if (payload.senderType === 'user' || payload.sender === 'visitor') return;
          setIsTyping(false);
          const sender = (payload.sender as ChatMessage['sender']) || 'bot';
          addLog('receive', `${payload.content.slice(0, 60)}${payload.content.length > 60 ? '...' : ''}`);
          setMessages((prev) => [...prev, { id: payload.id || uid(), content: payload.content, sender, timestamp: new Date(), metadata: payload.metadata }]);
        });

        socket.on('typing:indicator', (p: { isTyping?: boolean }) => {
          if (!cancelled) setIsTyping(p?.isTyping ?? true);
        });

        socket.on('handoff:accepted', () => {
          if (cancelled) return;
          setSessionStatus('agent');
          addLog('info', 'Agent joined');
          setMessages((prev) => [...prev, { id: uid(), content: 'An agent has joined the conversation.', sender: 'bot', timestamp: new Date() }]);
        });

        socket.on('session:closed', () => {
          if (cancelled) return;
          setSessionStatus('closed');
          addLog('info', 'Session closed');
          setMessages((prev) => [...prev, { id: uid(), content: 'This session has been closed.', sender: 'bot', timestamp: new Date() }]);
        });
      } catch (err: any) {
        if (!cancelled) {
          const msg =
            extractApiErrorMessage(err) ??
            (err instanceof Error ? err.message : undefined) ??
            'Failed to initialise.';
          addLog('error', msg);
          setError(msg);
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
        if (socketRef.current === socket) socketRef.current = null;
      }
    };
  }, [apiKey, addLog]);

  const handleSend = useCallback((_e?: any, overrideText?: string) => {
    const trimmed = (overrideText || input).trim();
    if (!trimmed || !socketRef.current || !sessionId) return;
    setMessages((prev) => [...prev, { id: uid(), content: trimmed, sender: 'visitor', timestamp: new Date() }]);
    setIsTyping(true);
    socketRef.current.emit('message:send', { sessionId, content: trimmed, type: 'text' });
    addLog('send', trimmed.slice(0, 80) + (trimmed.length > 80 ? '...' : ''));
    setInput('');
  }, [input, sessionId, addLog]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); }
  };

  if (!apiKey) {
    return (
      <div className="flex items-center justify-center h-screen bg-[#fcfbf9]">
        <div className="max-w-xs text-center">
          <div className="w-11 h-11 rounded-xl bg-[#4338ca]/[0.07] flex items-center justify-center mx-auto mb-4">
            <MessageCircle size={20} className="text-[#4338ca]/60" />
          </div>
          <h2 className="text-[16px] font-semibold text-[#1c1917] mb-1">API Key Required</h2>
          <p className="text-[13px] text-[#78716c] mb-4">Add your tenant API key to the URL to begin.</p>
          <code className="block text-[11px] text-[#4338ca] bg-[#4338ca]/[0.04] border border-[#4338ca]/10 px-4 py-2.5 rounded-lg break-all font-mono">
            /widget-test?apiKey=YOUR_KEY
          </code>
        </div>
      </div>
    );
  }

  if (initialising) {
    return (
      <div className="flex items-center justify-center h-screen bg-[#fcfbf9]">
        <div className="flex flex-col items-center gap-3">
          <div className="w-7 h-7 border-2 border-[#4338ca] border-t-transparent rounded-full animate-spin" />
          <span className="text-[13px] text-[#78716c]">Connecting...</span>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-screen overflow-hidden bg-[#fcfbf9]">
      {/* Left: Mock website + widget */}
      <div className="flex-1 relative overflow-hidden">
        <MockWebsite />

        <div className="absolute bottom-6 right-6 z-10">
          <ChatWidget
            messages={messages} setMessages={setMessages} input={input} setInput={setInput}
            onSend={handleSend} onKeyDown={handleKeyDown}
            connected={connected} sessionStatus={sessionStatus}
            isTyping={isTyping} messagesEndRef={messagesEndRef}
            isOpen={widgetOpen}
            onToggle={() => setWidgetOpen(true)}
            onClose={() => setWidgetOpen(false)}
          />
        </div>

        {error && (
          <div className="absolute top-4 left-1/2 -translate-x-1/2 z-20 bg-red-50 border border-red-200 text-red-700 text-[12px] px-4 py-2 rounded-lg flex items-center gap-2">
            <WifiOff size={12} />
            {error}
            <button type="button" onClick={() => setError(null)} className="ml-1 hover:text-red-900 cursor-pointer"><X size={12} /></button>
          </div>
        )}
      </div>

      {/* Right: Inspector */}
      <div className="w-[340px] shrink-0">
        <DevPanel
          sessionId={sessionId} tenantId={tenantId}
          connected={connected} sessionStatus={sessionStatus}
          logs={logs} apiKey={apiKey}
        />
      </div>
    </div>
  );
};

export default WidgetTest;
