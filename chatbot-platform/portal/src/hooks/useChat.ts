/**
 * useChat Hook
 * Manages chat state and real-time updates
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { useSocket } from '@websocket/SocketContext';
import { useNotificationSound } from '@websocket/notificationSound';
import type { Chat, Message, TypingIndicator } from '@app-types/index';

interface UseChatOptions {
  chatId?: string;
  enableSound?: boolean;
}

interface UseChatReturn {
  chat: Chat | null;
  messages: Message[];
  isTyping: boolean;
  typingUsers: string[];
  isLoading: boolean;
  error: string | null;
  sendMessage: (content: string, type?: Message['type']) => Promise<void>;
  sendTyping: (isTyping: boolean) => void;
  refreshChat: () => Promise<void>;
  markAsRead: () => void;
}

export const useChat = (options: UseChatOptions = {}): UseChatReturn => {
  const { chatId, enableSound = true } = options;
  const { registerHandlers, unregisterHandlers, joinChat, leaveChat, sendMessage: socketSendMessage, sendTyping: socketSendTyping } = useSocket();
  const { playMessage } = useNotificationSound();
  
  const [chat, setChat] = useState<Chat | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [isTyping, setIsTyping] = useState(false);
  const [typingUsers, setTypingUsers] = useState<string[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  
  const typingTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // Fetch chat data
  const fetchChat = useCallback(async () => {
    if (!chatId) return;
    
    setIsLoading(true);
    setError(null);
    
    try {
      // Replace with actual API call
      const response = await fetch(`/api/chats/${chatId}`);
      if (!response.ok) throw new Error('Failed to fetch chat');
      
      const data = await response.json();
      setChat(data);
      setMessages(data.messages || []);
    } catch (err: any) {
      setError(err.message || 'Failed to load chat');
    } finally {
      setIsLoading(false);
    }
  }, [chatId]);

  // Join chat room when chatId changes
  useEffect(() => {
    if (!chatId) return;
    
    fetchChat();
    joinChat(chatId);
    
    return () => {
      leaveChat(chatId);
    };
  }, [chatId, joinChat, leaveChat, fetchChat]);

  // Register socket event handlers
  useEffect(() => {
    if (!chatId) return;

    const handlers = registerHandlers({
      onChatUpdate: (updatedChat: Chat) => {
        if (updatedChat.id === chatId) {
          setChat(updatedChat);
        }
      },
      onMessageReceived: (message: Message) => {
        if (message.chatId === chatId) {
          setMessages((prev) => {
            // Avoid duplicates
            if (prev.some((m) => m.id === message.id)) return prev;
            return [...prev, message];
          });
          
          // Play sound for new messages from user or bot
          if (enableSound && (message.sender === 'user' || message.sender === 'bot')) {
            playMessage();
          }
        }
      },
      onTypingUpdate: (typing: TypingIndicator) => {
        if (typing.chatId === chatId) {
          setTypingUsers((prev) => {
            if (typing.isTyping) {
              return prev.includes(typing.userName) 
                ? prev 
                : [...prev, typing.userName];
            } else {
              return prev.filter((name) => name !== typing.userName);
            }
          });
        }
      },
    });

    return () => {
      unregisterHandlers(handlers);
    };
  }, [chatId, registerHandlers, unregisterHandlers, enableSound, playMessage]);

  // Send message
  const sendMessage = useCallback(async (content: string, type: Message['type'] = 'text') => {
    if (!chatId || !content.trim()) return;
    
    const message: Partial<Message> = {
      content: content.trim(),
      type,
      sender: 'agent',
    };
    
    socketSendMessage(chatId, message);
  }, [chatId, socketSendMessage]);

  // Send typing indicator with debounce
  const sendTyping = useCallback((typing: boolean) => {
    if (!chatId) return;
    
    // Clear existing timeout
    if (typingTimeoutRef.current) {
      clearTimeout(typingTimeoutRef.current);
    }
    
    socketSendTyping(chatId, typing);
    setIsTyping(typing);
    
    // Auto-clear typing after 3 seconds
    if (typing) {
      typingTimeoutRef.current = setTimeout(() => {
        socketSendTyping(chatId, false);
        setIsTyping(false);
      }, 3000);
    }
  }, [chatId, socketSendTyping]);

  // Mark messages as read
  const markAsRead = useCallback(() => {
    // Implement mark as read logic
  }, []);

  return {
    chat,
    messages,
    isTyping,
    typingUsers,
    isLoading,
    error,
    sendMessage,
    sendTyping,
    refreshChat: fetchChat,
    markAsRead,
  };
};

export default useChat;
