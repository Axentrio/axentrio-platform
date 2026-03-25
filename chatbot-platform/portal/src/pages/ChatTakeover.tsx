/**
 * ChatTakeover Page
 * Full chat interface with takeover functionality
 */

import React, { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, UserCheck, X, MoreVertical, Users } from 'lucide-react';
import { ChatWindow } from '@components/ChatWindow';
import { ChatStatusBadge } from '@components/StatusBadge';
import { Modal } from '@components/Modal';
import { useChats } from '@hooks/useChats';
import type { Chat, Agent } from '@app-types/index';

// Mock agents - replace with actual data
const mockAgents: Agent[] = [
  {
    id: '1',
    userId: '1',
    email: 'agent1@example.com',
    firstName: 'John',
    lastName: 'Doe',
    role: 'agent',
    status: 'online',
    maxConcurrentChats: 5,
    currentChats: 2,
    isActive: true,
    createdAt: new Date().toISOString(),
    skills: ['support', 'sales'],
  },
  {
    id: '2',
    userId: '2',
    email: 'agent2@example.com',
    firstName: 'Jane',
    lastName: 'Smith',
    role: 'agent',
    status: 'online',
    maxConcurrentChats: 5,
    currentChats: 3,
    isActive: true,
    createdAt: new Date().toISOString(),
    skills: ['support', 'technical'],
  },
];

const ChatTakeover: React.FC = () => {
  const { chatId } = useParams<{ chatId: string }>();
  const navigate = useNavigate();
  const [chat, setChat] = useState<Chat | null>(null);
  const [isTransferModalOpen, setIsTransferModalOpen] = useState(false);
  const [isClosing, setIsClosing] = useState(false);
  const { takeoverChat, closeChat } = useChats();

  // Fetch chat data
  useEffect(() => {
    if (!chatId) return;

    const fetchChat = async () => {
      try {
        const response = await fetch(`/api/chats/${chatId}`);
        if (response.ok) {
          const data = await response.json();
          setChat(data.data);
        }
      } catch (error) {
        console.error('Failed to fetch chat:', error);
      }
    };

    fetchChat();
  }, [chatId]);

  const handleTakeover = async () => {
    if (!chatId) return;

    try {
      await takeoverChat(chatId);
      const response = await fetch(`/api/chats/${chatId}`);
      if (response.ok) {
        const data = await response.json();
        setChat(data.data);
      }
    } catch (error) {
      console.error('Failed to takeover chat:', error);
    }
  };

  const handleTransfer = async (agentId: string) => {
    if (!chatId) return;

    try {
      await fetch(`/api/chats/${chatId}/transfer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId }),
      });
      setIsTransferModalOpen(false);
      navigate('/monitor');
    } catch (error) {
      console.error('Failed to transfer chat:', error);
    }
  };

  const handleClose = async () => {
    if (!chatId) return;

    setIsClosing(true);
    try {
      await closeChat(chatId);
      navigate('/monitor');
    } catch (error) {
      console.error('Failed to close chat:', error);
    } finally {
      setIsClosing(false);
    }
  };

  if (!chat) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary-600" />
      </div>
    );
  }

  const isHandoff = chat.status === 'handsoff';
  const isHuman = chat.status === 'human';

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="px-6 py-4 border-b border-edge bg-surface-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <button
              onClick={() => navigate('/monitor')}
              className="p-2 text-text-secondary hover:text-text-primary hover:bg-surface-3 rounded-xl transition-colors"
            >
              <ArrowLeft className="w-5 h-5" />
            </button>
            <div>
              <h1 className="text-xl font-bold text-text-primary">
                {chat.userName || 'Anonymous User'}
              </h1>
              <div className="flex items-center gap-2 text-sm text-text-secondary">
                <ChatStatusBadge status={chat.status} size="sm" />
                <span>•</span>
                <span>{chat.tenantName}</span>
                {chat.assignedAgentName && (
                  <>
                    <span>•</span>
                    <span>Assigned to {chat.assignedAgentName}</span>
                  </>
                )}
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2">
            {isHandoff && (
              <button
                onClick={handleTakeover}
                className="flex items-center gap-2 px-4 py-2 bg-primary-600 text-white rounded-xl hover:bg-primary-500 hover:shadow-glow transition-all"
              >
                <UserCheck className="w-4 h-4" />
                Takeover Chat
              </button>
            )}

            {isHuman && (
              <>
                <button
                  onClick={() => setIsTransferModalOpen(true)}
                  className="flex items-center gap-2 px-4 py-2 bg-surface-3 border border-edge text-text-secondary rounded-xl hover:bg-surface-4 hover:border-edge-light transition-colors"
                >
                  <Users className="w-4 h-4" />
                  Transfer
                </button>
                <button
                  onClick={handleClose}
                  disabled={isClosing}
                  className="flex items-center gap-2 px-4 py-2 bg-red-600/20 text-red-400 border border-red-500/20 rounded-xl hover:bg-red-600/30 disabled:opacity-50 transition-colors"
                >
                  <X className="w-4 h-4" />
                  {isClosing ? 'Closing...' : 'Close Chat'}
                </button>
              </>
            )}

            <button className="p-2 text-text-secondary hover:text-text-primary hover:bg-surface-3 rounded-xl transition-colors">
              <MoreVertical className="w-5 h-5" />
            </button>
          </div>
        </div>
      </div>

      {/* Chat Window */}
      <div className="flex-1 p-6 overflow-hidden">
        <ChatWindow
          chat={chat}
          onTransfer={() => setIsTransferModalOpen(true)}
          className="h-full"
        />
      </div>

      {/* Transfer Modal */}
      <Modal
        isOpen={isTransferModalOpen}
        onClose={() => setIsTransferModalOpen(false)}
        title="Transfer Chat"
        size="md"
      >
        <div className="space-y-4">
          <p className="text-text-secondary">
            Select an agent to transfer this chat to:
          </p>
          <div className="space-y-2">
            {mockAgents.map((agent) => (
              <button
                key={agent.id}
                onClick={() => handleTransfer(agent.id)}
                className="w-full flex items-center gap-3 p-3 bg-surface-3 hover:bg-surface-4 rounded-xl transition-colors text-left"
              >
                <div className="w-10 h-10 rounded-full bg-primary-600/20 flex items-center justify-center">
                  <span className="text-sm font-medium text-primary-400">
                    {agent.firstName[0]}{agent.lastName[0]}
                  </span>
                </div>
                <div className="flex-1">
                  <p className="font-medium text-text-primary">
                    {agent.firstName} {agent.lastName}
                  </p>
                  <p className="text-sm text-text-secondary">
                    {agent.currentChats}/{agent.maxConcurrentChats} chats • {agent.status}
                  </p>
                </div>
                <div className="flex gap-1">
                  {agent.skills.map((skill) => (
                    <span
                      key={skill}
                      className="px-2 py-0.5 text-xs bg-surface-4 text-text-secondary rounded-full"
                    >
                      {skill}
                    </span>
                  ))}
                </div>
              </button>
            ))}
          </div>
        </div>
      </Modal>
    </div>
  );
};

export default ChatTakeover;
