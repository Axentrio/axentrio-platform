/**
 * LiveMonitor Page
 * Real-time chat streams with filtering by tenant/status
 */

import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ChatStream } from '@components/ChatStream';
import { ChatWindow } from '@components/ChatWindow';
import { Modal } from '@components/Modal';
import { api } from '@services/apiClient';
import type { Chat, Tenant } from '@app-types/index';

const LiveMonitor: React.FC = () => {
  const navigate = useNavigate();
  const { data: tenant } = useQuery<Tenant>({
    queryKey: ['tenant', 'me'],
    queryFn: () => api.get<Tenant>('/tenants/me'),
  });
  const tenants = tenant ? [tenant] : [];
  const [selectedChat, setSelectedChat] = useState<Chat | null>(null);
  const [isChatModalOpen, setIsChatModalOpen] = useState(false);
  const handleChatSelect = (chat: Chat) => {
    setSelectedChat(chat);
    setIsChatModalOpen(true);
  };

  const handleTakeover = async (chatId: string) => {
    try {
      await api.post(`/chats/${chatId}/takeover`);
      navigate(`/takeover/${chatId}`);
    } catch (error) {
      console.error('Failed to takeover chat:', error);
    }
  };

  const handleCloseModal = () => {
    setIsChatModalOpen(false);
    setSelectedChat(null);
  };

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="px-6 py-4 border-b border-edge bg-surface-2">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-text-primary">Live Monitor</h1>
            <p className="text-text-secondary">Monitor and manage active conversations</p>
          </div>
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2 text-sm text-text-muted">
              <span className="w-2 h-2 bg-status-online rounded-full animate-pulse shadow-[0_0_6px_rgba(52,211,153,0.5)]" />
              Live
            </div>
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 p-6 overflow-hidden">
        <ChatStream
          tenants={tenants}
          onChatSelect={handleChatSelect}
          onTakeover={handleTakeover}
          selectedChatId={selectedChat?.id}
          className="h-full"
        />
      </div>

      {/* Chat Modal */}
      <Modal
        isOpen={isChatModalOpen}
        onClose={handleCloseModal}
        title="Chat Preview"
        size="lg"
      >
        {selectedChat && (
          <div className="h-[600px]">
            <ChatWindow
              chat={selectedChat}
              onClose={handleCloseModal}
              onTransfer={(chatId) => {
                // Handle transfer
                console.log('Transfer chat:', chatId);
              }}
            />
          </div>
        )}
      </Modal>
    </div>
  );
};

export default LiveMonitor;
