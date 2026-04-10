/**
 * Inbox Page
 * Unified split-pane workspace merging Live Monitor, Queue, and Chat Takeover.
 * Left panel: ChatStream with filter tabs (All / Bot / Handoff / Agent).
 * Right panel: ChatWindow for the selected conversation.
 * Handoff queue badge shown on the Handoff tab.
 */

import React, { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  Headphones,
  Clock,
  User,
  MessageSquare,
  AlertCircle,
  XCircle,
  UserCheck,
  Users,
  X,
  ArrowLeft,
  Bot,
  CheckCircle,
} from 'lucide-react';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { ChatStream } from '@components/ChatStream';
import { ChatWindow } from '@components/ChatWindow';
import { ChatStatusBadge, PriorityBadge } from '@components/StatusBadge';
import { Modal } from '@components/Modal';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { api } from '@services/apiClient';
import { useQuery } from '@tanstack/react-query';
import { useNotificationSound } from '@websocket/notificationSound';
import {
  useHandoffsQuery,
  useAcceptHandoff,
  useRejectHandoff,
} from '../queries/useHandoffQueries';
import { agentOptions } from '../queries/useAgentQueries';
import { useTenantSettings } from '../queries/useTenantQueries';
import { cn } from '@/lib/utils';
import type { Chat, ChatStatus, Agent } from '@app-types/index';
import type { HandoffRequest } from '@app-types/index';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type InboxTab = 'all' | 'bot' | 'handsoff' | 'human';

interface RawAgent {
  id: string;
  name: string;
  status: string;
  currentChatCount: number;
  maxConcurrentChats: number;
  skills?: string[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mapRawAgent(agent: RawAgent): Agent {
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
}

const tabStatusMap: Record<InboxTab, ChatStatus | 'all'> = {
  all: 'all',
  bot: 'bot',
  handsoff: 'handsoff',
  human: 'human',
};

const formatWaitTime = (seconds: number) => {
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes > 0) return `${minutes}m ${remainingSeconds}s`;
  return `${remainingSeconds}s`;
};

const getReasonIcon = (reason: HandoffRequest['reason']) => {
  switch (reason) {
    case 'user_request':
      return <User className="w-4 h-4" />;
    case 'sentiment_drop':
      return <AlertCircle className="w-4 h-4" />;
    case 'bot_failure':
      return <XCircle className="w-4 h-4" />;
    case 'timeout':
      return <Clock className="w-4 h-4" />;
    default:
      return <MessageSquare className="w-4 h-4" />;
  }
};

const getReasonLabel = (reason: HandoffRequest['reason']) =>
  reason.replace(/_/g, ' ').replace(/\b\w/g, (l) => l.toUpperCase());

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

const Inbox: React.FC = () => {
  const { data: tenant } = useTenantSettings();
  const tenants = tenant ? [tenant] : [];

  // Query params for deep-linking from redirects
  const [searchParams] = useSearchParams();
  const initialFilter = searchParams.get('filter') as InboxTab | null;
  const initialChatId = searchParams.get('chat');

  // Tabs & filters
  const [activeTab, setActiveTab] = useState<InboxTab>(initialFilter || 'all');

  // Selected chat (right panel)
  const [selectedChat, setSelectedChat] = useState<Chat | null>(null);

  // Transfer modal
  const [isTransferModalOpen, setIsTransferModalOpen] = useState(false);
  const [isClosing, setIsClosing] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);

  // Handoff queue data
  const { handoffs, pendingCount } = useHandoffsQuery('pending');
  const acceptHandoffMutation = useAcceptHandoff();
  const rejectHandoffMutation = useRejectHandoff();
  useNotificationSound();

  // Auto-load chat from query param (deep-link from redirect)
  React.useEffect(() => {
    if (initialChatId && !selectedChat) {
      api.get<{ data: Chat }>(`/chats/${initialChatId}`).then((res) => {
        setSelectedChat(res.data ?? (res as unknown as Chat));
      }).catch(() => {
        toast.error('Could not load the requested conversation');
      });
    }
  }, [initialChatId]);

  // Agent list (for transfer modal)
  const { data: rawAgents, isLoading: isLoadingAgents } = useQuery({
    ...agentOptions.list({ status: 'online' }),
    enabled: isTransferModalOpen,
  });
  const agents: Agent[] = ((rawAgents as RawAgent[] | undefined) ?? []).map(mapRawAgent);

  // -----------------------------------------------------------------------
  // Handlers
  // -----------------------------------------------------------------------

  const handleChatSelect = (chat: Chat) => {
    setSelectedChat(chat);
  };

  const handleTakeover = async (chatId: string) => {
    try {
      await api.post(`/chats/${chatId}/takeover`);
      // Refresh chat data after takeover
      const data = await api.get<{ data: Chat }>(`/chats/${chatId}`);
      setSelectedChat(data.data);
      toast.success('You are now handling this conversation');
    } catch (error) {
      console.error('Failed to takeover chat:', error);
      toast.error('Failed to take over conversation');
    }
  };

  const handleAcceptHandoff = async (handoff: HandoffRequest) => {
    try {
      await acceptHandoffMutation.mutateAsync(handoff.id);
      // After accepting, take over the chat and show it
      await handleTakeover(handoff.chatId);
      toast.success('Handoff accepted');
    } catch (error) {
      console.error('Failed to accept handoff:', error);
      toast.error('Failed to accept handoff');
    }
  };

  const handleDeclineHandoff = async (handoffId: string) => {
    try {
      await rejectHandoffMutation.mutateAsync({ handoffId, reason: 'Agent unavailable' });
    } catch (error) {
      console.error('Failed to decline handoff:', error);
      toast.error('Failed to decline handoff');
    }
  };

  const handleTransfer = async (agentId: string) => {
    if (!selectedChat) return;
    const prev = selectedChat;
    // Optimistic: close modal and deselect immediately
    setIsTransferModalOpen(false);
    setSelectedChat(null);
    try {
      await api.post(`/chats/${prev.id}/transfer`, { agentId });
      toast.success('Conversation transferred');
    } catch (error) {
      console.error('Failed to transfer chat:', error);
      toast.error('Failed to transfer chat');
      setSelectedChat((current) => current === null ? prev : current);
    }
  };

  const handleCloseChat = async () => {
    if (!selectedChat) return;
    const prev = selectedChat;
    // Optimistic: deselect immediately
    setIsClosing(true);
    setSelectedChat(null);
    setConfirmClose(false);
    try {
      await api.post(`/chats/${prev.id}/close`);
      toast.success('Conversation closed');
    } catch (error) {
      console.error('Failed to close chat:', error);
      toast.error('Failed to close conversation');
      setSelectedChat((current) => current === null ? prev : current);
    } finally {
      setIsClosing(false);
    }
  };

  const handleReturnToBot = async () => {
    if (!selectedChat) return;
    const prev = selectedChat;
    // Optimistic: deselect immediately
    setSelectedChat(null);
    try {
      await api.post(`/chats/${prev.id}/release`);
      toast.success('Conversation returned to bot');
    } catch (error) {
      console.error('Failed to return to bot:', error);
      toast.error('Failed to return to bot');
      setSelectedChat((current) => current === null ? prev : current);
    }
  };

  // -----------------------------------------------------------------------
  // Tab definitions
  // -----------------------------------------------------------------------

  const tabs: { key: InboxTab; label: string; badge?: number }[] = [
    { key: 'all', label: 'All' },
    { key: 'bot', label: 'Bot' },
    { key: 'handsoff', label: 'Handoff', badge: pendingCount },
    { key: 'human', label: 'Agent' },
  ];

  // -----------------------------------------------------------------------
  // Render
  // -----------------------------------------------------------------------

  const isHandoff = selectedChat?.status === 'handsoff';
  const isHuman = selectedChat?.status === 'human';

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="px-6 py-4 border-b border-edge bg-surface-2">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-text-primary">Inbox</h1>
            <p className="text-text-secondary">Monitor and manage conversations</p>
          </div>
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2 text-sm text-text-muted">
              <span className="w-2 h-2 bg-status-online rounded-full animate-pulse shadow-[0_0_6px_rgba(52,211,153,0.5)]" />
              Live
            </div>
          </div>
        </div>

        {/* Filter tabs */}
        <div className="flex items-center gap-1 mt-4">
          {tabs.map((tab) => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={cn(
                'px-4 py-2 text-sm font-medium rounded-lg transition-colors relative',
                activeTab === tab.key
                  ? 'bg-primary-600/20 text-primary-400'
                  : 'text-text-secondary hover:text-text-primary hover:bg-surface-3',
              )}
            >
              {tab.label}
              {tab.badge != null && tab.badge > 0 && (
                <span className="ml-2 inline-flex items-center justify-center min-w-[20px] h-5 px-1.5 text-xs font-bold rounded-full bg-red-500 text-white">
                  {tab.badge}
                </span>
              )}
            </button>
          ))}
        </div>
      </div>

      {/* Split pane content */}
      <div className="flex-1 flex overflow-hidden">
        {/* Left panel: Chat list / Handoff queue */}
        <div className={cn(
          'w-full md:w-[400px] md:min-w-[400px] flex-shrink-0 border-r border-edge overflow-hidden flex flex-col',
          selectedChat && 'hidden md:flex'
        )}>
          {activeTab === 'handsoff' && pendingCount === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-text-muted">
              <CheckCircle className="w-10 h-10 mb-3 text-green-500/50" />
              <p className="text-sm font-medium">All caught up!</p>
              <p className="text-xs mt-1">No pending handoff requests</p>
            </div>
          ) : activeTab === 'handsoff' && pendingCount > 0 ? (
            /* Handoff queue cards */
            <div className="flex-1 overflow-y-auto p-4 space-y-3">
              <div className="text-sm text-text-muted mb-2">
                {pendingCount} pending handoff{pendingCount !== 1 ? 's' : ''}
              </div>
              {handoffs.map((handoff) => (
                <Card
                  key={handoff.id}
                  variant="glass"
                  className={cn(
                    'overflow-hidden border cursor-pointer transition-colors hover:bg-surface-3',
                    handoff.priority === 'urgent' && 'border-red-500/30 bg-red-500/5',
                    handoff.priority === 'high' && 'border-accent-500/30 bg-accent-500/5',
                    handoff.priority === 'medium' && 'border-accent-300/20',
                    handoff.priority === 'low' && 'border-edge',
                  )}
                >
                  <div className="p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1">
                          <Headphones className={cn(
                            'w-4 h-4 flex-shrink-0',
                            handoff.priority === 'urgent' && 'text-red-400',
                            handoff.priority === 'high' && 'text-accent-400',
                            handoff.priority === 'medium' && 'text-accent-300',
                            handoff.priority === 'low' && 'text-text-secondary',
                          )} />
                          <span className="font-medium text-text-primary truncate">
                            {handoff.userName || 'Anonymous User'}
                          </span>
                          <PriorityBadge status={handoff.priority} size="sm" />
                        </div>
                        <div className="flex items-center gap-2 text-xs text-text-muted mt-1">
                          <span className="flex items-center gap-1">
                            {getReasonIcon(handoff.reason)}
                            {getReasonLabel(handoff.reason)}
                          </span>
                          <span>-</span>
                          <span className="font-mono">{formatWaitTime(handoff.waitTime)}</span>
                        </div>
                      </div>
                      <div className="flex items-center gap-1 flex-shrink-0">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleDeclineHandoff(handoff.id);
                          }}
                          disabled={rejectHandoffMutation.isPending || acceptHandoffMutation.isPending}
                          className="text-xs h-7 px-2"
                        >
                          {rejectHandoffMutation.isPending ? (
                            <Loader2 className="w-3 h-3 animate-spin" />
                          ) : 'Decline'}
                        </Button>
                        <Button
                          size="sm"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleAcceptHandoff(handoff);
                          }}
                          disabled={acceptHandoffMutation.isPending || rejectHandoffMutation.isPending}
                          className="text-xs h-7 px-2"
                        >
                          {acceptHandoffMutation.isPending ? (
                            <Loader2 className="w-3 h-3 animate-spin" />
                          ) : 'Accept'}
                        </Button>
                      </div>
                    </div>
                  </div>
                </Card>
              ))}

              {/* Also show the ChatStream below for handsoff-status chats */}
              <div className="pt-2 border-t border-edge mt-4">
                <p className="text-xs text-text-muted mb-2">Handoff chats</p>
                <ChatStream
                  tenants={tenants}
                  onChatSelect={handleChatSelect}
                  onTakeover={handleTakeover}
                  selectedChatId={selectedChat?.id}
                  initialStatusFilter="handsoff"
                  className="h-[400px]"
                />
              </div>
            </div>
          ) : (
            /* Normal ChatStream with status filter from active tab */
            <ChatStream
              key={activeTab}
              tenants={tenants}
              onChatSelect={handleChatSelect}
              onTakeover={handleTakeover}
              selectedChatId={selectedChat?.id}
              initialStatusFilter={tabStatusMap[activeTab]}
              className="h-full"
            />
          )}
        </div>

        {/* Right panel: Chat detail */}
        <div className={cn(
          'flex-1 flex flex-col overflow-hidden',
          !selectedChat && 'hidden md:flex'
        )}>
          {selectedChat ? (
            <>
              {/* Action bar */}
              <div className="px-4 py-3 border-b border-edge bg-surface-2 flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <button
                    className="md:hidden p-1 rounded-lg hover:bg-surface-3 transition-colors"
                    onClick={() => setSelectedChat(null)}
                    aria-label="Back to chat list"
                  >
                    <ArrowLeft className="w-5 h-5 text-text-secondary" />
                  </button>
                  <div>
                    <h2 className="font-semibold text-text-primary">
                      {selectedChat.userName || 'Anonymous User'}
                    </h2>
                    <div className="flex items-center gap-2 text-sm text-text-secondary">
                      <ChatStatusBadge status={selectedChat.status} size="sm" />
                      {selectedChat.tenantName && (
                        <>
                          <span>-</span>
                          <span>{selectedChat.tenantName}</span>
                        </>
                      )}
                      {selectedChat.assignedAgentName && (
                        <>
                          <span>-</span>
                          <span>Assigned to {selectedChat.assignedAgentName}</span>
                        </>
                      )}
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  {isHandoff && (
                    <Button
                      onClick={() => handleTakeover(selectedChat.id)}
                      size="sm"
                      className="gap-2 rounded-xl"
                    >
                      <UserCheck className="w-4 h-4" />
                      Takeover
                    </Button>
                  )}
                  {isHuman && (
                    <>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setIsTransferModalOpen(true)}
                        className="gap-2 rounded-xl"
                      >
                        <Users className="w-4 h-4" />
                        Transfer
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={handleReturnToBot}
                        className="gap-1.5 rounded-xl"
                      >
                        <Bot className="w-3.5 h-3.5" />
                        Return to Bot
                      </Button>
                      <Button
                        variant="destructive"
                        size="sm"
                        onClick={() => setConfirmClose(true)}
                        disabled={isClosing}
                        className="gap-2 rounded-xl"
                      >
                        <X className="w-4 h-4" />
                        {isClosing ? 'Closing...' : 'Close'}
                      </Button>
                    </>
                  )}
                </div>
              </div>

              {/* Chat window */}
              <div className="flex-1 overflow-hidden">
                <ChatWindow
                  chat={selectedChat}
                  onTransfer={() => setIsTransferModalOpen(true)}
                  className="h-full rounded-none border-0 shadow-none"
                />
              </div>
            </>
          ) : (
            /* Empty state */
            <div className="flex-1 flex flex-col items-center justify-center text-text-secondary">
              <MessageSquare className="w-16 h-16 mb-4 text-text-muted" />
              <p className="text-lg font-medium">Select a conversation</p>
              <p className="text-sm text-text-muted mt-1">
                Choose a chat from the left panel to view details
              </p>
            </div>
          )}
        </div>
      </div>

      {/* Confirm Close Dialog */}
      <AlertDialog open={confirmClose} onOpenChange={setConfirmClose}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Close this conversation?</AlertDialogTitle>
            <AlertDialogDescription>The visitor will be disconnected and the conversation will be marked as resolved.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleCloseChat} className="bg-red-600 hover:bg-red-700">Close conversation</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

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
                      {agent.currentChats}/{agent.maxConcurrentChats} chats - {agent.status}
                    </p>
                  </div>
                  <div className="flex gap-1">
                    {agent.skills.map((skill) => (
                      <Badge key={skill} variant="secondary">
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

export default Inbox;
