/**
 * LiveMonitor Page
 * Real-time chat streams with filtering by tenant/status
 */

import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ChatStream } from '@components/ChatStream';
import { ChatWindow } from '@components/ChatWindow';
import { Modal } from '@components/Modal';
import { useChats } from '@hooks/useChats';
import type { Chat, Tenant } from '@app-types/index';

// Mock tenants - replace with actual data
const mockTenants: Tenant[] = [
  {
    id: '1',
    name: 'Acme Corp',
    slug: 'acme',
    primaryColor: '#6366f1',
    secondaryColor: '#4338ca',
    settings: {
      businessHours: { timezone: 'UTC', schedule: [] },
      autoHandoff: true,
      handoffTriggers: { sentimentThreshold: 0.3, consecutiveFailures: 3, explicitRequest: true, timeoutSeconds: 300 },
      responseTimeSLA: 2,
      csatEnabled: true,
    },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    isActive: true,
    maxAgents: 10,
    currentAgents: 5,
  },
  {
    id: '2',
    name: 'TechStart Inc',
    slug: 'techstart',
    primaryColor: '#34d399',
    secondaryColor: '#059669',
    settings: {
      businessHours: { timezone: 'UTC', schedule: [] },
      autoHandoff: true,
      handoffTriggers: { sentimentThreshold: 0.3, consecutiveFailures: 3, explicitRequest: true, timeoutSeconds: 300 },
      responseTimeSLA: 2,
      csatEnabled: true,
    },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    isActive: true,
    maxAgents: 5,
    currentAgents: 2,
  },
];

const LiveMonitor: React.FC = () => {
  const navigate = useNavigate();
  const [selectedChat, setSelectedChat] = useState<Chat | null>(null);
  const [isChatModalOpen, setIsChatModalOpen] = useState(false);
  const { takeoverChat } = useChats();

  const handleChatSelect = (chat: Chat) => {
    setSelectedChat(chat);
    setIsChatModalOpen(true);
  };

  const handleTakeover = async (chatId: string) => {
    try {
      await takeoverChat(chatId);
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
          tenants={mockTenants}
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
