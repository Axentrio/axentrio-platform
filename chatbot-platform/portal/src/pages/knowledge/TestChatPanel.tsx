import React, { useState, useRef, useEffect } from 'react';
import { X, Send, Bot, User } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { CompactTypingIndicator } from '@/components/TypingIndicator';
import { useTestChat, type TestChatResponse } from '@/queries/useKnowledgeQueries';

interface TestChatPanelProps {
  isOpen: boolean;
  onClose: () => void;
  botName: string;
  provider: string;
  model: string;
  hasIndexedDocs: boolean;
}

interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

const TestChatPanel: React.FC<TestChatPanelProps> = ({
  isOpen,
  onClose,
  botName,
  provider,
  model,
  hasIndexedDocs,
}) => {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [useKB, setUseKB] = useState(hasIndexedDocs);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const testChat = useTestChat();

  // Reset on open
  useEffect(() => {
    if (isOpen) {
      setMessages([]);
      setInput('');
      setUseKB(hasIndexedDocs);
      setTimeout(() => inputRef.current?.focus(), 100);
    }
  }, [isOpen, hasIndexedDocs]);

  // Auto-scroll to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, testChat.isPending]);

  const handleSend = () => {
    const trimmed = input.trim();
    if (!trimmed || testChat.isPending) return;

    const userMsg: ChatMessage = { role: 'user', content: trimmed };
    const updatedMessages = [...messages, userMsg];
    setMessages(updatedMessages);
    setInput('');

    const history = updatedMessages
      .filter((m) => m.role !== 'system')
      .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }))
      .slice(-20);

    testChat.mutate(
      {
        message: trimmed,
        history: history.slice(0, -1),
        useKnowledgeBase: useKB,
      },
      {
        onSuccess: (data) => {
          const resp = data as TestChatResponse;
          const content = resp.response || '(No response — check your brand voice and guardrails configuration)';
          const botMsg: ChatMessage = { role: 'assistant', content };
          setMessages((prev) => [...prev, botMsg]);
        },
        onError: () => {
          const errMsg: ChatMessage = {
            role: 'system',
            content: 'Something went wrong. Check your API key and model configuration.',
          };
          setMessages((prev) => [...prev, errMsg]);
        },
      },
    );
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  if (!isOpen) return null;

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/30 z-40"
        onClick={onClose}
      />

      {/* Panel */}
      <div className="fixed top-0 right-0 h-full w-full max-w-[400px] bg-surface-0 border-l border-edge z-50 flex flex-col shadow-2xl animate-in slide-in-from-right duration-200">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-edge">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-8 h-8 rounded-full bg-primary-600/20 flex items-center justify-center flex-shrink-0">
              <Bot className="w-4 h-4 text-primary-400" />
            </div>
            <div className="min-w-0">
              <p className="text-sm font-medium text-text-primary truncate">{botName || 'AI Assistant'}</p>
              <p className="text-xs text-text-muted">{provider} / {model}</p>
            </div>
          </div>
          <Button variant="ghost" size="icon" onClick={onClose} className="flex-shrink-0">
            <X className="w-4 h-4" />
          </Button>
        </div>

        {/* KB Toggle */}
        <div className="flex items-center justify-between px-4 py-2 border-b border-edge bg-surface-1">
          <span className={`text-xs ${hasIndexedDocs ? 'text-text-muted' : 'text-text-muted/60'}`}>
            Use Knowledge Base
          </span>
          <div className="flex items-center gap-2">
            {!hasIndexedDocs && (
              <span className="text-xs text-amber-400">No indexed docs</span>
            )}
            <Switch
              checked={useKB && hasIndexedDocs}
              onCheckedChange={setUseKB}
              disabled={!hasIndexedDocs}
            />
          </div>
        </div>

        {/* Messages */}
        <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
          {messages.length === 0 && (
            <div className="flex flex-col items-center justify-center h-full text-center">
              <div className="w-12 h-12 rounded-full bg-surface-2 flex items-center justify-center mb-3">
                <Bot className="w-6 h-6 text-text-muted" />
              </div>
              <p className="text-sm text-text-muted">Send a message to test your bot</p>
              <p className="text-xs text-text-muted mt-1">Using saved AI settings</p>
            </div>
          )}

          {messages.map((msg, i) => {
            if (msg.role === 'system') {
              return (
                <div key={i} className="flex justify-center">
                  <p className="text-xs text-red-400 bg-red-400/10 px-3 py-1.5 rounded-lg">
                    {msg.content}
                  </p>
                </div>
              );
            }

            const isUser = msg.role === 'user';
            return (
              <div key={i} className={`flex gap-2 ${isUser ? 'flex-row-reverse' : 'flex-row'}`}>
                <div className={`w-7 h-7 rounded-full flex items-center justify-center flex-shrink-0 ${
                  isUser
                    ? 'bg-surface-3 text-text-secondary'
                    : 'bg-primary-600/20 text-primary-400'
                }`}>
                  {isUser ? <User className="w-3.5 h-3.5" /> : <Bot className="w-3.5 h-3.5" />}
                </div>
                <div className={`max-w-[80%] px-3 py-2 rounded-2xl text-sm whitespace-pre-wrap ${
                  isUser
                    ? 'bg-primary-600 text-white rounded-br-md'
                    : 'bg-surface-3 text-text-primary rounded-bl-md'
                }`}>
                  {msg.content}
                </div>
              </div>
            );
          })}

          {testChat.isPending && (
            <div className="flex gap-2 flex-row">
              <div className="w-7 h-7 rounded-full bg-primary-600/20 flex items-center justify-center flex-shrink-0">
                <Bot className="w-3.5 h-3.5 text-primary-400" />
              </div>
              <CompactTypingIndicator />
            </div>
          )}

          <div ref={messagesEndRef} />
        </div>

        {/* Input */}
        <div className="px-4 py-3 border-t border-edge">
          <div className="flex gap-2">
            <Input
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Type a message..."
              disabled={testChat.isPending}
              className="flex-1"
            />
            <Button
              onClick={handleSend}
              disabled={!input.trim() || testChat.isPending}
              size="icon"
            >
              <Send className="w-4 h-4" />
            </Button>
          </div>
        </div>
      </div>
    </>
  );
};

export default TestChatPanel;
