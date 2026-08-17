/**
 * Inbox Page
 * Unified split-pane workspace merging Live Monitor, Queue, and Chat Takeover.
 * Left panel: ChatStream with filter tabs (All / Bot / Handoff / Agent).
 * Right panel: ChatWindow for the selected conversation.
 * Handoff queue badge shown on the Handoff tab.
 */

import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
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
  ChevronDown,
  ShieldAlert,
  ShieldCheck,
  Timer,
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
import { HumanControlBadge, TakeoverMenu } from '@components/HumanControl';
import type { TakeoverPolicy } from '@utils/humanControl';
import { ChatStatusBadge, PriorityBadge } from '@components/StatusBadge';
import { ConnectionIndicator } from '@components/ConnectionIndicator';
import { Modal } from '@components/Modal';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { api } from '@services/apiClient';
import { takeoverFailureOf, takeoverToastKey } from '@utils/takeoverErrors';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { queryKeys } from '../queries/queryKeys';
import { useNotificationSound } from '@websocket/notificationSound';
import { useSocket } from '@websocket/SocketContext';
import {
  useHandoffsQuery,
  useAcceptHandoff,
  useRejectHandoff,
} from '../queries/useHandoffQueries';
import {
  useLiveConversationSync,
  applyCommandConversation,
  commandSummaryToChatPatch,
  findCachedChat,
  mergeDefined,
  newUuid,
} from '../queries/conversationLive';
import { normalizeChatDetail } from '../queries/useChatQueries';
import { agentOptions } from '../queries/useAgentQueries';
import { useTenantSettings } from '../queries/useTenantQueries';
import { cn } from '@/lib/utils';
import type { Chat, ChatStatus, Agent, CommandConversationSummary } from '@app-types/index';
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

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

const Inbox: React.FC = () => {
  const { t } = useTranslation();
  const { data: tenant } = useTenantSettings();
  const tenants = tenant ? [tenant] : [];

  const getReasonLabel = (reason: HandoffRequest['reason']) => {
    const key = `inbox.handoff.reason.${reason}`;
    const translated = t(key);
    if (translated !== key) return translated;
    return reason.replace(/_/g, ' ').replace(/\b\w/g, (l) => l.toUpperCase());
  };

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
  // B-PR5b FIX 3: takeover/policy commands are SERIALIZED. A same-owner
  // policy update keeps the ownershipVersion, so two in-flight duration
  // changes cannot be ordered by the revision gates — the UI must not allow
  // a second one while the first is on the wire.
  const [isTakeoverPending, setIsTakeoverPending] = useState(false);

  const queryClient = useQueryClient();
  const { isConnected, isConnecting } = useSocket();

  // Handoff queue data
  const { handoffs, pendingCount } = useHandoffsQuery('pending');
  const acceptHandoffMutation = useAcceptHandoff();
  const rejectHandoffMutation = useRejectHandoff();
  useNotificationSound();

  // ONE live-sync mount: folds conversation:upsert / message:created into
  // every cached list variant + the detail cache, plays the message sound for
  // the open thread, and invalidates on reconnect + window focus. The open
  // chat lives in component state, so upserts for it are merged here too
  // (defined fields only — a partial summary never clobbers a known value).
  useLiveConversationSync({
    selectedChatId: selectedChat?.id,
    onSelectedUpsert: (patch) => {
      setSelectedChat((prev) => (prev && prev.id === patch.id ? mergeDefined(prev, patch) : prev));
    },
  });

  // Auto-load chat from query param (deep-link from redirect)
  React.useEffect(() => {
    if (initialChatId && !selectedChat) {
      api.get<{ data: Chat }>(`/chats/${initialChatId}`).then((res) => {
        const chat = (res.data ?? (res as unknown as Chat)) as Chat;
        setSelectedChat(normalizeChatDetail(chat) as Chat);
      }).catch(() => {
        toast.error(t('inbox.toasts.loadFailed'));
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

  // B-PR4b: open a session from the possible-duplicates audit by id. The
  // freshest cached row wins; a GET is only the fallback (audit entries can
  // reference sessions no cached list variant holds).
  const handleOpenSessionById = async (sessionId: string) => {
    const cached = findCachedChat(queryClient, sessionId);
    if (cached) {
      setSelectedChat(cached);
      return;
    }
    try {
      const chat = normalizeChatDetail(await api.get<Chat>(`/chats/${sessionId}`)) as Chat;
      setSelectedChat(chat);
    } catch {
      toast.error(t('inbox.toasts.loadFailed'));
    }
  };

  /**
   * Select a conversation after a command, patched from the POST RESPONSE
   * summary instead of a follow-up GET. The reduced summary carries no
   * display fields, so the base row comes from the cache; the GET only runs
   * as a fallback when nothing is cached (e.g. a deep link).
   */
  const selectFromCommandResponse = async (
    chatId: string,
    conversation: CommandConversationSummary | undefined,
  ) => {
    const patch = conversation ? commandSummaryToChatPatch(conversation) : null;
    const base =
      (selectedChat?.id === chatId ? selectedChat : null) ?? findCachedChat(queryClient, chatId);
    if (base) {
      setSelectedChat(patch ? mergeDefined(base, patch) : base);
      return;
    }
    const chat = normalizeChatDetail(await api.get<Chat>(`/chats/${chatId}`)) as Chat;
    setSelectedChat(patch ? mergeDefined(chat, patch) : chat);
  };

  /**
   * POST /takeover and fold the committed summary into the caches + the open
   * pane (no refetch-after-mutation). B-PR5b: an omitted policy posts the
   * modeless legacy body (= indefinite); an explicit policy posts { mode,
   * hours? } — on a same-owner re-claim the backend treats an explicit mode
   * as a policy update (the "change duration" path).
   */
  const postTakeover = async (chatId: string, policy?: TakeoverPolicy) => {
    const res = await api.post<{ outcome: string; conversation?: CommandConversationSummary }>(
      `/chats/${chatId}/takeover`,
      {
        idempotencyKey: newUuid(),
        ...(policy?.mode === 'timed' ? { mode: 'timed' as const, hours: policy.hours } : {}),
        ...(policy?.mode === 'indefinite' ? { mode: 'indefinite' as const } : {}),
      },
    );
    applyCommandConversation(queryClient, res.conversation);
    await selectFromCommandResponse(chatId, res.conversation);
  };

  const handleTakeover = async (chatId: string, policy?: TakeoverPolicy) => {
    if (isTakeoverPending) return; // serialized — see isTakeoverPending
    setIsTakeoverPending(true);
    try {
      await postTakeover(chatId, policy);
      toast.success(t('inbox.toasts.takeoverSuccess'));
    } catch (error) {
      console.error('Failed to takeover chat:', error);
      const failure = takeoverFailureOf(error);
      toast.error(
        failure
          ? t(takeoverToastKey(failure), { name: failure.assignedAgentId })
          : t('inbox.toasts.takeoverFailed'),
      );
    } finally {
      setIsTakeoverPending(false);
    }
  };

  // "Change duration" on an already-owned chat: ALWAYS an explicit mode, so
  // the backend rewrites the policy (indefinite converts a timed control).
  const handleChangeDuration = async (policy: TakeoverPolicy) => {
    if (!selectedChat) return;
    if (isTakeoverPending) return; // serialized — see isTakeoverPending
    setIsTakeoverPending(true);
    try {
      await postTakeover(selectedChat.id, policy);
      toast.success(t('inbox.toasts.durationUpdated'));
    } catch (error) {
      console.error('Failed to change control duration:', error);
      const failure = takeoverFailureOf(error);
      toast.error(
        failure
          ? t(takeoverToastKey(failure), { name: failure.assignedAgentId })
          : t('inbox.toasts.durationUpdateFailed'),
      );
    } finally {
      setIsTakeoverPending(false);
    }
  };

  // Re-enable AI on a conversation a guardrail paused (admin-only on the server).
  const handleResumeAI = async () => {
    if (!selectedChat) return;
    try {
      await api.post('/handoff/resume-ai', { sessionId: selectedChat.id });
      // api.get unwraps the { success, data } envelope → returns the Chat directly.
      const chat = normalizeChatDetail(await api.get<Chat>(`/chats/${selectedChat.id}`)) as Chat;
      setSelectedChat(chat);
      // Refresh the conversation list so the paused badge clears on the row too.
      queryClient.invalidateQueries({ queryKey: queryKeys.chats.all() });
      toast.success(t('inbox.toasts.resumeAiSuccess'));
    } catch (error) {
      console.error('Failed to resume AI:', error);
      toast.error(t('inbox.toasts.resumeAiFailed'));
    }
  };

  // Accept = the ONE acknowledged takeover command (no separate socket
  // handoff:accept emit, no optimistic queue removal — the resulting
  // conversation:upsert + the handoff refetch reconcile the queue).
  const handleAcceptHandoff = async (handoff: HandoffRequest) => {
    try {
      const res = await acceptHandoffMutation.mutateAsync({ chatId: handoff.chatId });
      await selectFromCommandResponse(handoff.chatId, res?.conversation);
      toast.success(t('inbox.toasts.handoffAccepted'));
    } catch (error) {
      console.error('Failed to accept handoff:', error);
      toast.error(t('inbox.toasts.handoffAcceptFailed'));
    }
  };

  // Decline = the acknowledged cancel command (HANDOFF_REQUESTED → BOT_OWNED).
  const handleDeclineHandoff = async (handoff: HandoffRequest) => {
    try {
      await rejectHandoffMutation.mutateAsync({ chatId: handoff.chatId, reason: 'Agent unavailable' });
    } catch (error) {
      console.error('Failed to decline handoff:', error);
      toast.error(t('inbox.toasts.handoffDeclineFailed'));
    }
  };

  const handleTransfer = async (agentId: string) => {
    if (!selectedChat) return;
    const prev = selectedChat;
    // Optimistic: close modal and deselect immediately
    setIsTransferModalOpen(false);
    setSelectedChat(null);
    try {
      await api.post(`/chats/${prev.id}/transfer`, { agentId, idempotencyKey: newUuid() });
      toast.success(t('inbox.toasts.transferSuccess'));
    } catch (error) {
      console.error('Failed to transfer chat:', error);
      toast.error(t('inbox.toasts.transferFailed'));
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
      const res = await api.post<{ outcome: string; conversation?: CommandConversationSummary }>(
        `/chats/${prev.id}/close`,
        { idempotencyKey: newUuid() },
      );
      applyCommandConversation(queryClient, res.conversation);
      toast.success(t('inbox.toasts.closeSuccess'));
    } catch (error) {
      console.error('Failed to close chat:', error);
      toast.error(t('inbox.toasts.closeFailed'));
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
      const res = await api.post<{ outcome: string; conversation?: CommandConversationSummary }>(
        `/chats/${prev.id}/release`,
        { idempotencyKey: newUuid() },
      );
      applyCommandConversation(queryClient, res.conversation);
      toast.success(t('inbox.toasts.returnToBotSuccess'));
    } catch (error) {
      console.error('Failed to return to bot:', error);
      toast.error(t('inbox.toasts.returnToBotFailed'));
      setSelectedChat((current) => current === null ? prev : current);
    }
  };

  // -----------------------------------------------------------------------
  // Tab definitions
  // -----------------------------------------------------------------------

  const tabs: { key: InboxTab; label: string; badge?: number }[] = [
    { key: 'all', label: t('inbox.tabs.all') },
    { key: 'bot', label: t('inbox.tabs.bot') },
    { key: 'handsoff', label: t('inbox.tabs.handoff'), badge: pendingCount },
    { key: 'human', label: t('inbox.tabs.agent') },
  ];

  // -----------------------------------------------------------------------
  // Render
  // -----------------------------------------------------------------------

  // B-PR5b: OWNERSHIP is the authoritative gate for the human controls. A
  // real takeover is ownership:'human_owned' with backend status 'handoff'
  // (deriveStatusFromOwnership) — portal status 'handsoff' — so a
  // status==='human' gate would never fire for a taken-over chat.
  const isHumanOwned = selectedChat?.ownership === 'human_owned';
  // Takeover offer: a handoff-status chat NOT already human-owned. A row with
  // an unknown ownership (the detail GET omits the field) lands here too — a
  // same-owner re-claim is harmless and the response corrects the pane.
  const isHandoff = selectedChat?.status === 'handsoff' && !isHumanOwned;
  // A guardrail paused AI auto-reply (status stays 'bot'); surface it + allow resume.
  const isGuardrailPaused = selectedChat?.aiAutoReplyEnabled === false;

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="px-6 py-4 border-b border-edge bg-surface-2">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-text-primary">{t('nav.inbox')}</h1>
            <p className="text-text-secondary">{t('inbox.header.subtitle')}</p>
          </div>
          <div className="flex items-center gap-4">
            <ConnectionIndicator isConnected={isConnected} isConnecting={isConnecting} />
          </div>
        </div>

        {/* Filter tabs */}
        <div className="flex items-center gap-1 mt-4">
          {tabs.map((tab) => (
            <button
              type="button"
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
              <p className="text-sm font-medium">{t('inbox.handoff.empty.title')}</p>
              <p className="text-xs mt-1">{t('inbox.handoff.empty.subtitle')}</p>
            </div>
          ) : activeTab === 'handsoff' && pendingCount > 0 ? (
            /* Handoff queue cards */
            <div className="flex-1 overflow-y-auto p-4 space-y-3">
              <div className="text-sm text-text-muted mb-2">
                {t('inbox.handoff.pendingCount', { count: pendingCount })}
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
                            {handoff.userName || t('inbox.chat.anonymousUser')}
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
                            handleDeclineHandoff(handoff);
                          }}
                          disabled={rejectHandoffMutation.isPending || acceptHandoffMutation.isPending}
                          className="text-xs h-7 px-2"
                        >
                          {rejectHandoffMutation.isPending ? (
                            <Loader2 className="w-3 h-3 animate-spin" />
                          ) : t('inbox.handoff.decline')}
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
                          ) : t('inbox.handoff.accept')}
                        </Button>
                      </div>
                    </div>
                  </div>
                </Card>
              ))}

              {/* Also show the ChatStream below for handsoff-status chats */}
              <div className="pt-2 border-t border-edge mt-4">
                <p className="text-xs text-text-muted mb-2">{t('inbox.handoff.handoffChats')}</p>
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
                    type="button"
                    className="md:hidden p-1 rounded-lg hover:bg-surface-3 transition-colors"
                    onClick={() => setSelectedChat(null)}
                    aria-label={t('inbox.window.backToList')}
                  >
                    <ArrowLeft className="w-5 h-5 text-text-secondary" />
                  </button>
                  <div>
                    <h2 className="font-semibold text-text-primary">
                      {selectedChat.userName || t('inbox.chat.anonymousUser')}
                    </h2>
                    <div className="flex items-center gap-2 text-sm text-text-secondary">
                      <ChatStatusBadge status={selectedChat.status} size="sm" />
                      {isGuardrailPaused && (
                        <span
                          className="inline-flex items-center gap-1 rounded-full bg-amber-500/15 px-2 py-0.5 text-xs font-medium text-amber-600"
                          title={t('inbox.guardrail.pausedTooltip')}
                        >
                          <ShieldAlert className="w-3 h-3" />
                          {t('inbox.guardrail.paused', { reason: selectedChat.guardrailStatus || 'flagged' })}
                        </span>
                      )}
                      {isHumanOwned && (
                        <HumanControlBadge
                          mode={selectedChat.humanControlMode}
                          until={selectedChat.humanControlUntil}
                        />
                      )}
                      {selectedChat.tenantName && (
                        <>
                          <span>-</span>
                          <span>{selectedChat.tenantName}</span>
                        </>
                      )}
                      {selectedChat.assignedAgentName && (
                        <>
                          <span>-</span>
                          <span>{t('inbox.window.header.assignedTo', { name: selectedChat.assignedAgentName })}</span>
                        </>
                      )}
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  {isGuardrailPaused && (
                    <Button
                      onClick={handleResumeAI}
                      size="sm"
                      className="gap-2 rounded-xl"
                    >
                      <ShieldCheck className="w-4 h-4" />
                      {t('inbox.guardrail.resumeButton')}
                    </Button>
                  )}
                  {isHandoff && (
                    <TakeoverMenu
                      onSelect={(policy) =>
                        // The initial indefinite pick keeps the modeless
                        // legacy body — only timed picks carry a policy.
                        handleTakeover(
                          selectedChat.id,
                          policy.mode === 'indefinite' ? undefined : policy,
                        )
                      }
                      trigger={
                        <Button size="sm" disabled={isTakeoverPending} className="gap-2 rounded-xl">
                          <UserCheck className="w-4 h-4" />
                          {t('inbox.takeover.button')}
                          <ChevronDown className="w-3.5 h-3.5" />
                        </Button>
                      }
                    />
                  )}
                  {isHumanOwned && (
                    <>
                      <TakeoverMenu
                        onSelect={handleChangeDuration}
                        trigger={
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={isTakeoverPending}
                            className="gap-1.5 rounded-xl"
                          >
                            <Timer className="w-3.5 h-3.5" />
                            {t('inbox.takeover.changeDuration')}
                            <ChevronDown className="w-3 h-3" />
                          </Button>
                        }
                      />
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setIsTransferModalOpen(true)}
                        className="gap-2 rounded-xl"
                      >
                        <Users className="w-4 h-4" />
                        {t('inbox.actions.transfer')}
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={handleReturnToBot}
                        className="gap-1.5 rounded-xl"
                      >
                        <Bot className="w-3.5 h-3.5" />
                        {t('inbox.actions.returnToBot')}
                      </Button>
                      <Button
                        variant="destructive"
                        size="sm"
                        onClick={() => setConfirmClose(true)}
                        disabled={isClosing}
                        className="gap-2 rounded-xl"
                      >
                        <X className="w-4 h-4" />
                        {isClosing ? t('inbox.actions.closing') : t('inbox.actions.close')}
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
                  onOpenSession={handleOpenSessionById}
                  className="h-full rounded-none border-0 shadow-none"
                />
              </div>
            </>
          ) : (
            /* Empty state */
            <div className="flex-1 flex flex-col items-center justify-center text-text-secondary">
              <MessageSquare className="w-16 h-16 mb-4 text-text-muted" />
              <p className="text-lg font-medium">{t('inbox.detail.empty.title')}</p>
              <p className="text-sm text-text-muted mt-1">
                {t('inbox.detail.empty.subtitle')}
              </p>
            </div>
          )}
        </div>
      </div>

      {/* Confirm Close Dialog */}
      <AlertDialog open={confirmClose} onOpenChange={setConfirmClose}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('inbox.closeDialog.title')}</AlertDialogTitle>
            <AlertDialogDescription>{t('inbox.closeDialog.description')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={handleCloseChat} className="bg-red-600 hover:bg-red-700">{t('inbox.closeDialog.confirm')}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Transfer Modal */}
      <Modal
        isOpen={isTransferModalOpen}
        onClose={() => setIsTransferModalOpen(false)}
        title={t('inbox.transferModal.title')}
        size="md"
      >
        <div className="space-y-4">
          <p className="text-text-secondary">
            {t('inbox.transferModal.prompt')}
          </p>
          {isLoadingAgents ? (
            <div className="flex items-center justify-center py-8">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-600" />
            </div>
          ) : agents.length === 0 ? (
            <p className="text-center text-text-secondary py-8">
              {t('inbox.transferModal.noAgents')}
            </p>
          ) : (
            <div className="space-y-2">
              {agents.map((agent) => (
                <button
                  type="button"
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
                      {t('inbox.transferModal.agentStats', { current: agent.currentChats, max: agent.maxConcurrentChats, status: agent.status })}
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
