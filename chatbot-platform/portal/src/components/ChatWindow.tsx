/**
 * ChatWindow Component
 * Active chat interface with message display and input
 */

import React, { useState, useRef, useEffect } from 'react';
import { Send, Paperclip, MoreVertical, Phone, User } from 'lucide-react';
import { useChat } from '@hooks/useChat';
import { useNotificationSound } from '@websocket/notificationSound';
import { ChatStatusBadge } from './StatusBadge';
import { TypingIndicator, CompactTypingIndicator } from './TypingIndicator';
import { FileAttachment } from './FilePreview';
import type { Chat, Message } from '@app-types/index';

interface ChatWindowProps {
  chat: Chat;
  onClose?: () => void;
  onTransfer?: (chatId: string) => void;
  className?: string;
}

export const ChatWindow: React.FC<ChatWindowProps> = ({
  chat,
  onClose,
  onTransfer,
  className = '',
}) => {
  const [messageInput, setMessageInput] = useState('');
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const { messages, typingUsers, sendMessage, sendTyping } = useChat({
    chatId: chat.id,
    enableSound: true,
  });

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
  };

  // Send message
  const handleSend = async () => {
    if (!messageInput.trim()) return;

    await sendMessage(messageInput.trim());
    setMessageInput('');
    sendTyping(false);

    // Reset textarea height
    if (inputRef.current) {
      inputRef.current.style.height = 'auto';
    }
  };

  // Handle key press
  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  // Auto-resize textarea
  const handleTextareaResize = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const textarea = e.target;
    textarea.style.height = 'auto';
    textarea.style.height = `${Math.min(textarea.scrollHeight, 120)}px`;
  };

  const renderMessage = (message: Message) => {
    const isAgent = message.sender === 'agent';
    const isBot = message.sender === 'bot';

    return (
      <div
        key={message.id}
        className={`flex ${isAgent ? 'justify-end' : 'justify-start'} mb-4`}
      >
        <div className={`flex max-w-[80%] ${isAgent ? 'flex-row-reverse' : 'flex-row'} gap-2`}>
          {/* Avatar */}
          <div className={`flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center text-sm font-medium ${
            isAgent
              ? 'bg-primary-600/20 text-primary-400'
              : isBot
                ? 'bg-chat-bot/20 text-chat-bot'
                : 'bg-surface-3 text-text-secondary'
          }`}>
            {isAgent ? 'A' : isBot ? 'B' : <User className="w-4 h-4" />}
          </div>

          {/* Message content */}
          <div className={`flex flex-col ${isAgent ? 'items-end' : 'items-start'}`}>
            {/* Sender name */}
            <span className="text-xs text-text-muted mb-1">
              {message.senderName || (isAgent ? 'Agent' : isBot ? 'Bot' : 'User')}
            </span>

            {/* Message bubble */}
            <div
              className={`px-4 py-2 rounded-2xl ${
                isAgent
                  ? 'bg-primary-600 text-white rounded-br-md'
                  : isBot
                    ? 'bg-chat-bot/10 text-text-primary rounded-bl-md'
                    : 'bg-surface-3 text-text-primary rounded-bl-md'
              }`}
            >
              {message.type === 'text' ? (
                <p className="text-sm whitespace-pre-wrap">{message.content}</p>
              ) : message.type === 'image' ? (
                <img
                  src={message.fileUrl}
                  alt={message.fileName || 'Image'}
                  className="max-w-48 max-h-48 rounded-lg object-cover"
                />
              ) : (
                <FileAttachment
                  fileName={message.fileName || 'File'}
                  fileType={message.fileType || 'application/octet-stream'}
                  fileSize={message.fileSize}
                  onClick={() => {
                    // Open file preview
                  }}
                />
              )}
            </div>

            {/* Timestamp */}
            <span className="text-xs text-text-muted mt-1">
              {new Date(message.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            </span>
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className={`flex flex-col h-full bg-surface-2 rounded-2xl shadow-card overflow-hidden border border-edge ${className}`}>
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-edge bg-surface-2">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-full bg-surface-3 flex items-center justify-center">
            <User className="w-5 h-5 text-text-secondary" />
          </div>
          <div>
            <h3 className="font-semibold text-text-primary">
              {chat.userName || 'Anonymous User'}
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
            <button
              type="button"
              onClick={() => onTransfer(chat.id)}
              className="p-2 text-text-secondary hover:text-text-primary hover:bg-surface-3 rounded-xl transition-colors"
              title="Transfer chat"
            >
              <Phone className="w-5 h-5" />
            </button>
          )}
          <button
            type="button"
            className="p-2 text-text-secondary hover:text-text-primary hover:bg-surface-3 rounded-xl transition-colors"
          >
            <MoreVertical className="w-5 h-5" />
          </button>
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              className="p-2 text-text-secondary hover:text-text-primary hover:bg-surface-3 rounded-xl transition-colors"
            >
              ×
            </button>
          )}
        </div>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto p-4 bg-surface-1">
        {messages.length > 0 ? (
          <>
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
            <p>No messages yet</p>
            <p className="text-sm text-text-muted">Start the conversation!</p>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Input area */}
      <div className="px-4 py-3 border-t border-edge bg-surface-2">
        <div className="flex items-end gap-2">
          <button
            type="button"
            className="p-2 text-text-secondary hover:text-text-primary hover:bg-surface-3 rounded-xl transition-colors flex-shrink-0"
          >
            <Paperclip className="w-5 h-5" />
          </button>

          <div className="flex-1 relative">
            <textarea
              ref={inputRef}
              value={messageInput}
              onChange={(e) => {
                handleInputChange(e);
                handleTextareaResize(e);
              }}
              onKeyDown={handleKeyPress}
              placeholder="Type a message..."
              rows={1}
              className="w-full px-3 py-2 bg-surface-3 border border-edge rounded-xl resize-none focus:outline-none focus:border-primary-500 focus:ring-1 focus:ring-primary-500/30 text-sm text-text-primary placeholder:text-text-muted min-h-[40px] max-h-[120px]"
              style={{ overflow: 'hidden' }}
            />
          </div>

          <button
            type="button"
            onClick={handleSend}
            disabled={!messageInput.trim()}
            className="p-2 bg-primary-600 text-white rounded-xl hover:bg-primary-500 hover:shadow-glow disabled:opacity-50 disabled:cursor-not-allowed transition-all flex-shrink-0"
          >
            <Send className="w-5 h-5" />
          </button>
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

export default ChatWindow;
