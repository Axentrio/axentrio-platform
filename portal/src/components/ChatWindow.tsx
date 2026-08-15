/**
 * ChatWindow Component
 * Active chat interface with message display and input
 */

import React, { useState, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Send,
  ArrowRightLeft,
  User,
  Users,
  Mail,
  Globe,
  Loader2,
  RotateCw,
  AlertTriangle,
  ChevronDown,
  ChevronRight,
} from 'lucide-react';
import { useChatDetail, useChatThread, type EarlierThreadSession } from '../queries/useChatQueries';
import { useNotificationSound } from '@websocket/notificationSound';
import { SlashCommandDropdown, CannedResponsePickerButton } from './CannedResponsePicker';
import { ChatStatusBadge } from './StatusBadge';
import { TypingIndicator, CompactTypingIndicator } from './TypingIndicator';
import { FileAttachment } from './FilePreview';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import type { Chat, Message } from '@app-types/index';

interface ChatWindowProps {
  chat: Chat;
  onClose?: () => void;
  onTransfer?: (chatId: string) => void;
  /** Open another session read-only from the possible-duplicates audit. */
  onOpenSession?: (sessionId: string) => void;
  className?: string;
}

/** Boundary/audit date label. Pure - hoisted to module scope. */
function formatBoundaryDate(iso: string): string {
  return new Date(iso).toLocaleDateString();
}

/** Auto-grow a textarea up to a max height. Pure — hoisted to module scope. */
function handleTextareaResize(e: React.ChangeEvent<HTMLTextAreaElement>): void {
  const textarea = e.target;
  textarea.style.height = 'auto';
  textarea.style.height = `${Math.min(textarea.scrollHeight, 120)}px`;
}

export const ChatWindow: React.FC<ChatWindowProps> = ({
  chat,
  onClose,
  onTransfer,
  onOpenSession,
  className = '',
}) => {
  const { t } = useTranslation();
  const [messageInput, setMessageInput] = useState('');
  const [isSending, setIsSending] = useState(false);
  // Non-destructive composer notice: 409 conflicts keep the typed draft.
  const [sendNotice, setSendNotice] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [slashQuery, setSlashQuery] = useState('');
  const [showSlashMenu, setShowSlashMenu] = useState(false);
  const slashKeyHandlerRef = useRef<((e: React.KeyboardEvent) => boolean) | null>(null);

  const { messages, typingUsers, sendMessage, retryMessage, sendTyping } = useChatDetail(chat.id);

  // B-PR4b: read-only customer-thread history - SEPARATE from the live detail
  // cache. Prior closed sessions render as collapsed boundary blocks ABOVE the
  // live thread; the current session stays the composable one. Expansion state
  // is keyed by `${chat.id}:${session.id}`, so switching chats naturally
  // starts collapsed again without a reset effect.
  const { earlierSessions, truncated, possibleDuplicates } = useChatThread(chat.id);
  const [expandedEarlier, setExpandedEarlier] = useState<Record<string, boolean>>({});

  useNotificationSound();

  // Auto-scroll to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Handle typing
  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value;
    setMessageInput(value);
    sendTyping(value.length > 0);

    // Slash command detection
    const match = value.match(/^\/(\S*)$/);
    if (match) {
      setSlashQuery(match[1]);
      setShowSlashMenu(true);
    } else {
      setShowSlashMenu(false);
    }
  };

  // Send message through the acknowledged command route. The draft stays in
  // the composer until the POST resolves:
  //  - sent     → clear the draft (the optimistic bubble was reconciled).
  //  - conflict → KEEP the draft + show a non-destructive notice (another
  //               agent owns the conversation / it closed); nothing is lost.
  //  - failed   → the bubble flips to FAILED with a Retry (same
  //               clientMessageId); the composer clears so retry is the one
  //               path (no accidental duplicate send with a new id).
  const handleSend = async () => {
    if (!messageInput.trim() || isSending) return;

    // Snapshot the draft being sent: the operator may keep typing during the
    // POST, and only THIS text may ever be cleared from the composer.
    const sentText = messageInput;

    setSendNotice(null);
    setIsSending(true);
    let result: Awaited<ReturnType<typeof sendMessage>>;
    try {
      result = await sendMessage(sentText.trim());
    } finally {
      setIsSending(false);
    }

    if (result.status === 'conflict') {
      setSendNotice(conflictNoticeFor(result.code));
      return; // keep the draft (and anything typed since)
    }

    // Clear ONLY the sent draft. If the composer changed while the POST was
    // in flight, the operator's newer text stays untouched (on a failure the
    // sent text itself stays recoverable via the bubble's Retry).
    if ((inputRef.current?.value ?? messageInput) === sentText) {
      setMessageInput('');
      sendTyping(false);
      // Reset textarea height
      if (inputRef.current) {
        inputRef.current.style.height = 'auto';
      }
    }
  };

  const conflictNoticeFor = (code?: string) =>
    code === 'conversation_closed'
      ? t('inbox.window.composer.conflictClosed')
      : t('inbox.window.composer.conflictTaken');

  // A retry that hits a 409 keeps the bubble (the hook holds it in the failed
  // state — the text is never lost) and surfaces the same non-destructive
  // notice as a first-send conflict.
  const handleRetry = async (clientMessageId: string) => {
    setSendNotice(null);
    const result = await retryMessage(clientMessageId);
    if (result.status === 'conflict') {
      setSendNotice(conflictNoticeFor(result.code));
    }
  };

  // Handle canned response selection
  const handleCannedResponseSelect = (content: string) => {
    setMessageInput(content);
    setShowSlashMenu(false);
    inputRef.current?.focus();
  };

  // Handle key press
  const handleKeyPress = (e: React.KeyboardEvent) => {
    // When slash menu is open, delegate to the dropdown's keyboard handler
    if (showSlashMenu && slashKeyHandlerRef.current) {
      const handled = slashKeyHandlerRef.current(e);
      if (handled) return;
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  // Auto-resize textarea
  const renderMessage = (message: Message) => {
    const isAgent = message.sender === 'agent';
    const isBot = message.sender === 'bot';
    const isVisitor = !isAgent && !isBot;
    const isPending = message.deliveryState === 'pending';
    const isFailed = message.deliveryState === 'failed';

    return (
      <div
        key={message.clientMessageId ?? message.id}
        className={`flex ${isVisitor ? 'justify-end' : 'justify-start'} mb-4`}
      >
        <div className={`flex max-w-[80%] ${isVisitor ? 'flex-row-reverse' : 'flex-row'} gap-2`}>
          {/* Avatar */}
          <div className={cn(
            'flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center text-sm font-medium',
            isAgent
              ? 'bg-primary-600/20 text-primary-400'
              : isBot
                ? 'bg-chat-bot/20 text-chat-bot'
                : 'bg-surface-3 text-text-secondary'
          )}>
            {isAgent ? 'A' : isBot ? 'B' : <User className="w-4 h-4" />}
          </div>

          {/* Message content */}
          <div className={`flex flex-col ${isVisitor ? 'items-end' : 'items-start'}`}>
            {/* Sender name */}
            <span className="text-xs text-text-muted mb-1">
              {message.senderName || (isAgent ? t('inbox.window.sender.agent') : isBot ? t('inbox.window.sender.bot') : t('inbox.window.sender.visitor'))}
            </span>

            {/* Message bubble */}
            <div
              className={cn(
                'px-4 py-2 rounded-2xl',
                isVisitor
                  ? 'bg-primary-600 text-white rounded-br-md'
                  : isBot
                    ? 'bg-chat-bot/10 text-text-primary rounded-bl-md'
                    : 'bg-surface-3 text-text-primary rounded-bl-md',
                isPending && 'opacity-60',
                isFailed && 'border border-red-500/50'
              )}
            >
              {message.type === 'text' ? (
                <p className="text-sm whitespace-pre-wrap">{message.content}</p>
              ) : message.type === 'image' ? (
                <img
                  src={message.fileUrl}
                  alt={message.fileName || t('inbox.window.message.image')}
                  className="max-w-48 max-h-48 rounded-lg object-cover"
                />
              ) : (
                <FileAttachment
                  fileName={message.fileName || t('inbox.window.message.file')}
                  fileType={message.fileType || 'application/octet-stream'}
                  fileSize={message.fileSize}
                  onClick={() => {
                    // Open file preview
                  }}
                />
              )}
            </div>

            {/* Timestamp / delivery state */}
            {isPending ? (
              <span className="text-xs text-text-muted mt-1">
                {t('inbox.window.message.sending')}
              </span>
            ) : isFailed ? (
              <span className="text-xs text-red-500 mt-1 flex items-center gap-1.5">
                {t('inbox.window.message.failed')}
                {message.clientMessageId && (
                  <button
                    type="button"
                    onClick={() => handleRetry(message.clientMessageId!)}
                    className="inline-flex items-center gap-1 font-medium text-red-500 hover:text-red-400 underline"
                  >
                    <RotateCw className="w-3 h-3" />
                    {t('inbox.window.message.retry')}
                  </button>
                )}
              </span>
            ) : (
              <span className="text-xs text-text-muted mt-1">
                {new Date(message.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              </span>
            )}
          </div>
        </div>
      </div>
    );
  };

  // B-PR4b: one prior session as a labelled boundary block - collapsed by
  // default, expandable, strictly read-only. Rendered ABOVE the live thread.
  const renderEarlierSession = (session: EarlierThreadSession) => {
    const expansionKey = `${chat.id}:${session.id}`;
    const isExpanded = !!expandedEarlier[expansionKey];
    const label =
      session.status === 'closed'
        ? t('inbox.thread.boundaryClosed', { date: formatBoundaryDate(session.boundary.endedAt ?? session.boundary.startedAt) })
        : t('inbox.thread.boundaryOpen', { date: formatBoundaryDate(session.boundary.startedAt) });

    return (
      <div key={session.id} className="mb-4" data-testid={`earlier-session-${session.id}`}>
        <button
          type="button"
          onClick={() =>
            setExpandedEarlier((prev) => ({ ...prev, [expansionKey]: !prev[expansionKey] }))
          }
          aria-expanded={isExpanded}
          className="w-full flex items-center gap-2 text-xs text-text-muted hover:text-text-secondary transition-colors"
        >
          <span className="flex-1 border-t border-edge" aria-hidden="true" />
          {isExpanded ? (
            <ChevronDown className="w-3 h-3 flex-shrink-0" />
          ) : (
            <ChevronRight className="w-3 h-3 flex-shrink-0" />
          )}
          <span>
            {label} · {t('inbox.thread.messageCount', { count: session.messages.length })}
          </span>
          <span className="flex-1 border-t border-edge" aria-hidden="true" />
        </button>
        {isExpanded && (
          <div className="mt-3 opacity-80">
            {session.messages.map(renderMessage)}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className={cn('flex flex-col h-full bg-surface-2 rounded-2xl shadow-card overflow-hidden border border-edge', className)}>
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-edge bg-surface-2">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-full bg-surface-3 flex items-center justify-center">
            <User className="w-5 h-5 text-text-secondary" />
          </div>
          <div>
            <h3 className="font-semibold text-text-primary">
              {chat.userName || t('inbox.chat.anonymousUser')}
            </h3>
            <div className="flex items-center gap-2">
              <ChatStatusBadge status={chat.status} size="sm" />
              {chat.tenantName && (
                <span className="text-xs text-text-muted">• {chat.tenantName}</span>
              )}
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {onTransfer && (
            <Button
              variant="ghost"
              size="icon"
              onClick={() => onTransfer(chat.id)}
              className="text-text-secondary hover:text-text-primary hover:bg-surface-3 rounded-xl"
              title={t('inbox.window.transferChat')}
            >
              <ArrowRightLeft className="w-5 h-5" />
            </Button>
          )}
          {onClose && (
            <Button
              variant="ghost"
              size="icon"
              onClick={onClose}
              className="text-text-secondary hover:text-text-primary hover:bg-surface-3 rounded-xl"
              aria-label={t('common.close')}
              title={t('common.close')}
            >
              ×
            </Button>
          )}
        </div>
      </div>

      {/* Visitor info */}
      {(chat?.userEmail || chat?.metadata?.pageUrl) ? (
        <div className="px-4 py-2 border-b border-edge bg-surface-1/50 text-xs text-text-secondary space-y-1">
          {chat.userEmail && (
            <div className="flex items-center gap-1.5">
              <Mail className="w-3 h-3" />
              <span>{chat.userEmail}</span>
            </div>
          )}
          {chat.metadata?.pageUrl && (
            <div className="flex items-center gap-1.5">
              <Globe className="w-3 h-3" />
              <span className="truncate">{chat.metadata.pageUrl}</span>
            </div>
          )}
        </div>
      ) : null}

      {/* Possible-duplicates audit (B-PR4b §4): read-only, never merged */}
      {possibleDuplicates.length > 0 && (
        <div className="px-4 py-2 border-b border-edge bg-amber-500/5 text-xs" role="note">
          <p className="flex items-center gap-1.5 font-medium text-amber-600">
            <Users className="w-3 h-3 flex-shrink-0" />
            {t('inbox.thread.duplicatesTitle')}
          </p>
          <ul className="mt-1 space-y-1">
            {possibleDuplicates.map((dup) => (
              <li
                key={dup.summary.id}
                className="flex items-center gap-2 text-text-secondary"
              >
                <span className="truncate flex-1">
                  {dup.summary.userName || t('inbox.chat.anonymousUser')}
                  {' · '}
                  {dup.summary.channel ?? dup.summary.source ?? ''}
                  {' · '}
                  {formatBoundaryDate(dup.boundary.startedAt)}
                </span>
                {onOpenSession && (
                  <button
                    type="button"
                    onClick={() => onOpenSession(dup.summary.sessionId ?? dup.summary.id)}
                    className="flex-shrink-0 font-medium text-primary-400 hover:text-primary-300 underline"
                  >
                    {t('inbox.thread.open')}
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Messages */}
      <div className="flex-1 overflow-y-auto p-4 bg-surface-1">
        {messages.length > 0 || earlierSessions.length > 0 ? (
          <>
            {/* B-PR4b: prior sessions of the same customer, oldest→newest,
                as collapsed boundary blocks ABOVE the live thread */}
            {truncated && (
              <p className="mb-3 text-center text-xs text-text-muted">
                {t('inbox.thread.truncated')}
              </p>
            )}
            {earlierSessions.map(renderEarlierSession)}

            {messages.map(renderMessage)}

            {/* Typing indicator */}
            {typingUsers.length > 0 && (
              <div className="flex justify-start mb-4">
                <CompactTypingIndicator />
              </div>
            )}
          </>
        ) : (
          <div className="flex flex-col items-center justify-center h-full text-text-secondary">
            <p>{t('inbox.window.empty.title')}</p>
            <p className="text-sm text-text-muted">{t('inbox.window.empty.subtitle')}</p>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Input area */}
      <div className="px-4 py-3 border-t border-edge bg-surface-2">
        {/* Non-destructive send-conflict notice — the draft below is KEPT */}
        {sendNotice && (
          <div
            role="status"
            className="mb-2 flex items-center gap-2 rounded-xl border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-600"
          >
            <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" />
            <span className="flex-1">{sendNotice}</span>
            <button
              type="button"
              onClick={() => setSendNotice(null)}
              className="font-medium hover:text-amber-500"
              aria-label={t('common.close')}
            >
              ×
            </button>
          </div>
        )}
        <div className="flex items-end gap-2">
          <CannedResponsePickerButton onSelect={handleCannedResponseSelect} />

          <div className="flex-1 relative">
            <SlashCommandDropdown
              query={slashQuery}
              onSelect={handleCannedResponseSelect}
              onClose={() => setShowSlashMenu(false)}
              visible={showSlashMenu}
              registerKeyHandler={(handler) => { slashKeyHandlerRef.current = handler; }}
            />
            <Textarea
              ref={inputRef}
              value={messageInput}
              onChange={(e) => {
                handleInputChange(e);
                handleTextareaResize(e);
              }}
              onKeyDown={handleKeyPress}
              placeholder={t('inbox.window.composer.placeholder')}
              rows={1}
              className="w-full px-3 py-2 bg-surface-3 border border-edge rounded-xl resize-none focus:outline-none focus:border-primary-500 focus:ring-1 focus:ring-primary-500/30 text-sm text-text-primary placeholder:text-text-muted min-h-[40px] max-h-[120px]"
              style={{ overflow: 'hidden' }}
            />
          </div>

          <Button
            onClick={handleSend}
            disabled={!messageInput.trim() || isSending}
            className="p-2 bg-primary-600 text-white rounded-xl hover:bg-primary-500 hover:shadow-glow disabled:opacity-50 disabled:cursor-not-allowed transition-all flex-shrink-0"
            size="icon"
            aria-label={t('inbox.window.composer.send')}
            title={t('inbox.window.composer.send')}
          >
            {isSending ? <Loader2 className="w-5 h-5 animate-spin" /> : <Send className="w-5 h-5" />}
          </Button>
        </div>

        {/* Typing indicator text */}
        {typingUsers.length > 0 && (
          <div className="mt-2">
            <TypingIndicator users={typingUsers} size="sm" />
          </div>
        )}
      </div>
    </div>
  );
};

