/**
 * ChatTakeover Page
 * Full chat interface with takeover functionality
 */

import React, { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, UserCheck, X, MoreVertical, Users } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { ChatWindow } from '@components/ChatWindow';
import { ChatStatusBadge } from '@components/StatusBadge';
import { Modal } from '@components/Modal';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { useChats } from '@hooks/useChats';
import { api } from '@services/apiClient';
import type { Chat, Agent } from '@app-types/index';

interface AgentApiResponse {
  success: boolean;
  data?: Array<{
    id: string;
    name: string;
    status: string;
    currentChatCount: number;
    maxConcurrentChats: number;
    skills?: string[];
  }>;
  agents?: Array<{
    id: string;
    name: string;
    status: string;
    currentChatCount: number;
    maxConcurrentChats: number;
    skills?: string[];
  }>;
}

function mapApiAgents(response: AgentApiResponse): Agent[] {
  const rawAgents = response.data || response.agents || [];
  return rawAgents.map((agent) => {
    const nameParts = agent.name?.split(' ') || ['Unknown'];
    const firstName = nameParts[0];
    const lastName = nameParts.slice(1).join(' ') || '';
    return {
      id: agent.id,
      userId: agent.id,
      email: '',
      firstName,
      lastName,
      role: 'agent' as const,
      status: (agent.status || 'online') as Agent['status'],
      maxConcurrentChats: agent.maxConcurrentChats ?? 5,
      currentChats: agent.currentChatCount ?? 0,
      isActive: true,
      createdAt: new Date().toISOString(),
      skills: agent.skills || [],
    };
  });
}

const ChatTakeover: React.FC = () => {
  const { chatId } = useParams<{ chatId: string }>();
  const navigate = useNavigate();
  const [chat, setChat] = useState<Chat | null>(null);
  const [isTransferModalOpen, setIsTransferModalOpen] = useState(false);
  const [isClosing, setIsClosing] = useState(false);
  const { takeoverChat, closeChat } = useChats();

  const { data: agents = [], isLoading: isLoadingAgents } = useQuery<Agent[]>({
    queryKey: ['agents', 'online'],
    queryFn: async () => {
      const response = await api.get<AgentApiResponse>('/v1/agents?status=online');
      return mapApiAgents(response);
    },
    enabled: isTransferModalOpen,
  });

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
            <Button
              variant="ghost"
              size="icon"
              onClick={() => navigate('/monitor')}
              className="text-text-secondary hover:text-text-primary rounded-xl"
            >
              <ArrowLeft className="w-5 h-5" />
            </Button>
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
              <Button
                onClick={handleTakeover}
                className="gap-2 rounded-xl"
              >
                <UserCheck className="w-4 h-4" />
                Takeover Chat
              </Button>
            )}

            {isHuman && (
              <>
                <Button
                  variant="outline"
                  onClick={() => setIsTransferModalOpen(true)}
                  className="gap-2 rounded-xl"
                >
                  <Users className="w-4 h-4" />
                  Transfer
                </Button>
                <Button
                  variant="destructive"
                  onClick={handleClose}
                  disabled={isClosing}
                  className="gap-2 rounded-xl"
                >
                  <X className="w-4 h-4" />
                  {isClosing ? 'Closing...' : 'Close Chat'}
                </Button>
              </>
            )}

            <Button
              variant="ghost"
              size="icon"
              className="text-text-secondary hover:text-text-primary rounded-xl"
            >
              <MoreVertical className="w-5 h-5" />
            </Button>
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
          {isLoadingAgents ? (
            <div className="flex items-center justify-center py-8">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-600" />
            </div>
          ) : agents.length === 0 ? (
            <p className="text-center text-text-secondary py-8">
              No online agents available.
            </p>
          ) : (
          <div className="space-y-2">
            {agents.map((agent) => (
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
                    <Badge
                      key={skill}
                      variant="secondary"
                    >
                      {skill}
                    </Badge>
                  ))}
                </div>
              </button>
            ))}
          </div>
          )}
        </div>
      </Modal>
    </div>
  );
};

export default ChatTakeover;
