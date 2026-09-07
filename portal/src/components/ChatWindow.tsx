/**
 * ChatWindow Component
 * Active chat interface with message display and input
 */

import type React from 'react';
import { useState, useRef, useEffect } from 'react';
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
import { ChannelBadge } from './ChannelBadge';
import { TypingIndicator, CompactTypingIndicator } from './TypingIndicator';
import { AttachButton, MessageAttachment } from './ChatAttachments';
import {
  uploadChatAttachment,
  ChatAttachmentUploadError,
  type ChatAttachmentDraft,
} from '../queries/useChatAttachment';
import { messageHasAttachment } from '../queries/attachmentMetadata';
import { fileService } from '../services/fileService';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import type { Chat, Message, ThreadDuplicateEntry } from '@app-types/index';

interface ChatWindowProps {
  chat: Chat;
  onClose?: () => void;
  onTransfer?: (chatId: string) => void;
  /** Open another session read-only from the possible-duplicates audit. */
  onOpenSession?: (sessionId: string) => void;
  /** Inbox supplies its own action bar; hide the duplicate identity strip. */
  chrome?: 'full' | 'thread';
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

/** Sender disc: 'A' for the agent, 'B' for the bot, an icon for the visitor. */
const MessageAvatar: React.FC<{ isAgent: boolean; isBot: boolean }> = ({ isAgent, isBot }) => (
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
);

/** Sender label above a bubble: the carried name, else the role. */
const MessageSenderName: React.FC<{ message: Message; isAgent: boolean; isBot: boolean }> = ({
  message,
  isAgent,
  isBot,
}) => {
  const { t } = useTranslation();
  return (
    <span className="text-xs text-text-muted mb-1">
      {message.senderName || (isAgent ? t('inbox.window.sender.agent') : isBot ? t('inbox.window.sender.bot') : t('inbox.window.sender.visitor'))}
    </span>
  );
};

/** Bubble payload: text or attachment (signed URL fetched on read). */
const MessageBody: React.FC<{ message: Message }> = ({ message }) => {
  if (messageHasAttachment(message)) {
    return <MessageAttachment message={message} />;
  }
  return <p className="text-sm whitespace-pre-wrap">{message.content}</p>;
};

/** Timestamp, or the pending / failed delivery line with its Retry. */
const MessageDeliveryLine: React.FC<{
  message: Message;
  onRetry: (clientMessageId: string) => void;
}> = ({ message, onRetry }) => {
  const { t } = useTranslation();
  if (message.deliveryState === 'pending') {
    return (
      <span className="text-xs text-text-muted mt-1">
        {t('inbox.window.message.sending')}
      </span>
    );
  }
  if (message.deliveryState === 'failed') {
    return (
      <span className="text-xs text-red-500 mt-1 flex items-center gap-1.5">
        {t('inbox.window.message.failed')}
        {message.clientMessageId && (
          <button
            type="button"
            onClick={() => onRetry(message.clientMessageId!)}
            className="inline-flex items-center gap-1 font-medium text-red-500 hover:text-red-400 underline"
          >
            <RotateCw className="w-3 h-3" />
            {t('inbox.window.message.retry')}
          </button>
        )}
      </span>
    );
  }
  return (
    <span className="text-xs text-text-muted mt-1">
      {new Date(message.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
    </span>
  );
};

/** One thread row: a centered system event, or an avatar + bubble exchange. */
const MessageRow: React.FC<{
  message: Message;
  onRetry: (clientMessageId: string) => void;
}> = ({ message, onRetry }) => {
  if (message.type === 'system' || message.sender === 'system') {
    return (
      <div className="flex justify-center mb-4" data-testid="system-event">
        <p className="text-xs text-text-muted text-center max-w-[80%]">{message.content}</p>
      </div>
    );
  }

  const isAgent = message.sender === 'agent';
  const isBot = message.sender === 'bot';
  const isVisitor = !isAgent && !isBot;
  const isPending = message.deliveryState === 'pending';
  const isFailed = message.deliveryState === 'failed';

  return (
    <div className={`flex ${isVisitor ? 'justify-start' : 'justify-end'} mb-3`}>
      <div className={`flex max-w-[80%] ${isVisitor ? 'flex-row' : 'flex-row-reverse'} gap-2`}>
        {/* Avatar */}
        <MessageAvatar isAgent={isAgent} isBot={isBot} />

        {/* Message content */}
        <div className={`flex flex-col ${isVisitor ? 'items-start' : 'items-end'}`}>
          <MessageSenderName message={message} isAgent={isAgent} isBot={isBot} />
          <div
            className={cn(
              'px-3.5 py-2 rounded-2xl text-sm',
              isVisitor
                ? 'bg-surface-3 text-text-primary rounded-bl-md'
                : isBot
                  ? 'bg-primary-600/15 text-text-primary rounded-br-md'
                  : 'bg-primary-600/20 text-text-primary rounded-br-md',
              isPending && 'opacity-60',
              isFailed && 'border border-red-500/50'
            )}
          >
            <MessageBody message={message} />
          </div>

          {/* Timestamp / delivery state */}
          <MessageDeliveryLine message={message} onRetry={onRetry} />
        </div>
      </div>
    </div>
  );
};

/** Conversation header: visitor identity, status, transfer / close actions. */
const ChatWindowHeader: React.FC<{
  chat: Chat;
  onClose?: () => void;
  onTransfer?: (chatId: string) => void;
}> = ({ chat, onClose, onTransfer }) => {
  const { t } = useTranslation();
  return (
    <div className="flex items-center justify-between px-4 py-3 border-b border-edge bg-surface-2">
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-full bg-surface-3 flex items-center justify-center">
          <User className="w-5 h-5 text-text-secondary" />
        </div>
        <div>
          <div className="flex items-center gap-2 min-w-0">
            <h3 className="font-semibold text-text-primary truncate">
              {chat.userName || t('inbox.chat.anonymousUser')}
            </h3>
            <ChannelBadge channel={chat.channel} source={chat.metadata?.source} />
          </div>
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
            aria-label={t('inbox.window.transferChat')}
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
  );
};

/** Optional visitor facts strip. Renders nothing without email or page URL. */
const VisitorInfoBar: React.FC<{ chat: Chat }> = ({ chat }) => {
  if (!chat?.userEmail && !chat?.metadata?.pageUrl) return null;
  return (
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
  );
};

/** Possible-duplicates audit (B-PR4b §4): read-only, never merged. */
const PossibleDuplicatesNote: React.FC<{
  duplicates: ThreadDuplicateEntry[];
  onOpenSession?: (sessionId: string) => void;
}> = ({ duplicates, onOpenSession }) => {
  const { t } = useTranslation();
  if (duplicates.length === 0) return null;
  return (
    <div className="px-4 py-2 border-b border-edge bg-amber-500/5 text-xs" role="note">
      <p className="flex items-center gap-1.5 font-medium text-amber-600">
        <Users className="w-3 h-3 flex-shrink-0" />
        {t('inbox.thread.duplicatesTitle')}
      </p>
      <ul className="mt-1 space-y-1">
        {duplicates.map((dup) => (
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
  );
};

/** Non-destructive send-conflict notice — the composer draft is KEPT. */
const SendConflictNotice: React.FC<{ notice: string | null; onDismiss: () => void }> = ({
  notice,
  onDismiss,
}) => {
  const { t } = useTranslation();
  if (!notice) return null;
  return (
    <div
      role="status"
      className="mb-2 flex items-center gap-2 rounded-xl border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-600"
    >
      <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" />
      <span className="flex-1">{notice}</span>
      <button
        type="button"
        onClick={onDismiss}
        className="font-medium hover:text-amber-500"
        aria-label={t('common.close')}
      >
        ×
      </button>
    </div>
  );
};

export const ChatWindow: React.FC<ChatWindowProps> = ({
  chat,
  onClose,
  onTransfer,
  onOpenSession,
  chrome = 'full',
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
  const [composerFocused, setComposerFocused] = useState(false);
  const [attachmentDraft, setAttachmentDraft] = useState<ChatAttachmentDraft | null>(null);
  const [pendingAttachmentFile, setPendingAttachmentFile] = useState<File | null>(null);
  const [pendingAttachmentPreviewUrl, setPendingAttachmentPreviewUrl] = useState<string | null>(null);
  const [isUploadingAttachment, setIsUploadingAttachment] = useState(false);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
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

  useEffect(() => {
    return () => {
      if (pendingAttachmentPreviewUrl) {
        URL.revokeObjectURL(pendingAttachmentPreviewUrl);
      }
    };
  }, [pendingAttachmentPreviewUrl]);

  const clearPendingAttachmentPreview = () => {
    setPendingAttachmentPreviewUrl((current) => {
      if (current) URL.revokeObjectURL(current);
      return null;
    });
    setPendingAttachmentFile(null);
  };

  const clearAttachmentDraft = () => {
    setAttachmentDraft(null);
    setAttachmentError(null);
    clearPendingAttachmentPreview();
  };

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
  const attachmentErrorMessage = (err: unknown): string => {
    if (err instanceof ChatAttachmentUploadError) {
      if (err.code === 'too_large') return t('inbox.window.attachment.tooLarge');
      if (err.code === 'unsupported_type') return t('inbox.window.attachment.unsupported');
      if (err.code === 'rejected') return t('inbox.window.attachment.rejected');
      return err.detail ?? t('inbox.window.attachment.failed');
    }
    return t('inbox.window.attachment.failed');
  };

  const handleFilePicked = async (file: File) => {
    setAttachmentError(null);
    setAttachmentDraft(null);
    clearPendingAttachmentPreview();
    const previewUrl = file.type.startsWith('image/') ? URL.createObjectURL(file) : null;
    setPendingAttachmentFile(file);
    setPendingAttachmentPreviewUrl(previewUrl);
    setIsUploadingAttachment(true);
    try {
      const draft = await uploadChatAttachment(chat.id, file);
      setAttachmentDraft(draft);
    } catch (err) {
      setAttachmentDraft(null);
      clearPendingAttachmentPreview();
      setAttachmentError(attachmentErrorMessage(err));
    } finally {
      setIsUploadingAttachment(false);
    }
  };

  const handleSend = async () => {
    const hasText = !!messageInput.trim();
    const hasAttachment = !!attachmentDraft;
    if ((!hasText && !hasAttachment) || isSending || isUploadingAttachment) return;

    const sentText = messageInput;
    const sentAttachment = attachmentDraft;

    setSendNotice(null);
    setIsSending(true);
    let result: Awaited<ReturnType<typeof sendMessage>>;
    try {
      result = await sendMessage(sentText.trim(), sentAttachment ?? undefined);
    } finally {
      setIsSending(false);
    }

    if (result.status === 'conflict') {
      setSendNotice(conflictNoticeFor(result.code));
      return;
    }

    if (result.status === 'sent') {
      if ((inputRef.current?.value ?? messageInput) === sentText) {
        setMessageInput('');
        sendTyping(false);
        if (inputRef.current) {
          inputRef.current.style.height = 'auto';
        }
      }
      setAttachmentDraft(null);
      setAttachmentError(null);
      clearPendingAttachmentPreview();
    }
  };

  const conflictNoticeFor = (code?: string) => {
    if (code === 'conversation_closed') return t('inbox.window.composer.conflictClosed');
    if (code === 'operator_not_in_tenant') return t('inbox.window.composer.conflictNotInTenant');
    if (code === 'not_conversation_owner') return t('inbox.window.composer.conflictNotOwner');
    return t('inbox.window.composer.conflictTaken');
  };

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

  const renderMessage = (message: Message) => (
    <MessageRow
      key={message.clientMessageId ?? message.id}
      message={message}
      onRetry={handleRetry}
    />
  );

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

  const sendingTakesOver =
    chat.status !== 'closed' &&
    chat.ownership !== 'human_owned' &&
    (chat.status === 'bot' ||
      chat.status === 'handsoff' ||
      chat.ownership === 'bot_owned' ||
      chat.ownership === 'handoff_requested');
  const showTakeoverHint =
    sendingTakesOver && (composerFocused || messageInput.trim().length > 0);

  return (
    <div className={cn('flex flex-col h-full bg-surface-1 overflow-hidden', className)}>
      {chrome === 'full' && (
        <>
          <ChatWindowHeader chat={chat} onClose={onClose} onTransfer={onTransfer} />
          <VisitorInfoBar chat={chat} />
        </>
      )}

      <PossibleDuplicatesNote duplicates={possibleDuplicates} onOpenSession={onOpenSession} />

      <div className="flex-1 overflow-y-auto p-5 bg-surface-0">
        {messages.length > 0 || earlierSessions.length > 0 ? (
          <>
            {truncated && (
              <p className="mb-3 text-center text-xs text-text-muted">
                {t('inbox.thread.truncated')}
              </p>
            )}
            {earlierSessions.map(renderEarlierSession)}
            {messages.map(renderMessage)}
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
        <SendConflictNotice notice={sendNotice} onDismiss={() => setSendNotice(null)} />
        {showTakeoverHint && (
          <p className="mb-2 text-xs text-text-muted" data-testid="send-takes-over-hint">
            {t('inbox.window.composer.sendTakesOver')}
          </p>
        )}
        {(attachmentDraft || pendingAttachmentFile || isUploadingAttachment) && (
          <div
            className="mb-2 flex items-center gap-2 rounded-xl border border-edge bg-surface-3 px-3 py-2 text-xs text-text-secondary"
            data-testid="attachment-chip"
          >
            {pendingAttachmentPreviewUrl ? (
              <img
                src={pendingAttachmentPreviewUrl}
                alt=""
                className="h-10 w-10 flex-shrink-0 rounded-lg border border-edge object-cover bg-surface-2"
              />
            ) : null}
            <span className="flex-1 truncate">
              {attachmentDraft
                ? `${attachmentDraft.fileName} (${fileService.formatFileSize(attachmentDraft.fileSize)})`
                : pendingAttachmentFile
                  ? `${pendingAttachmentFile.name} (${fileService.formatFileSize(pendingAttachmentFile.size)})`
                  : t('inbox.window.attachment.uploading')}
            </span>
            {isUploadingAttachment ? (
              <Loader2 className="h-4 w-4 flex-shrink-0 animate-spin text-text-muted" aria-hidden="true" />
            ) : (
              <button
                type="button"
                className="font-medium text-text-muted hover:text-text-primary"
                onClick={clearAttachmentDraft}
              >
                {t('inbox.window.attachment.remove')}
              </button>
            )}
          </div>
        )}
        {attachmentError && (
          <p className="mb-2 text-xs text-red-500" role="alert">
            {attachmentError}
          </p>
        )}
        <div className="flex items-end gap-2">
          <CannedResponsePickerButton onSelect={handleCannedResponseSelect} />
          <AttachButton
            chatId={chat.id}
            disabled={isSending || isUploadingAttachment}
            onPicked={handleFilePicked}
          />

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
              onFocus={() => setComposerFocused(true)}
              onBlur={() => setComposerFocused(false)}
              onKeyDown={handleKeyPress}
              placeholder={t('inbox.window.composer.placeholder')}
              rows={1}
              className="w-full px-3 py-2 bg-surface-3 border border-edge rounded-xl resize-none focus:outline-none focus:border-primary-500 focus:ring-1 focus:ring-primary-500/30 text-sm text-text-primary placeholder:text-text-muted min-h-[40px] max-h-[120px]"
              style={{ overflow: 'hidden' }}
            />
          </div>

          <Button
            onClick={handleSend}
            disabled={(!messageInput.trim() && !attachmentDraft) || isSending || isUploadingAttachment}
            className="p-2 bg-primary text-primary-foreground rounded-xl hover:bg-primary/90 hover:shadow-glow disabled:opacity-50 disabled:cursor-not-allowed transition-all flex-shrink-0"
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

