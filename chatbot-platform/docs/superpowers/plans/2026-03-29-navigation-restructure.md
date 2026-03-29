# Navigation & IA Restructure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Consolidate the portal sidebar from 9 items to 5 intent-based groups (Inbox, AI & Content, Analytics, Team, Settings), eliminating disconnected workflows and duplicate views.

**Architecture:** This is a layout/routing restructure that reuses all existing components and hooks. No backend changes. Each phase creates a new wrapper page that composes existing components, updates routes in App.tsx, and adds redirects for old URLs. The sidebar is updated last once all new pages are in place.

**Tech Stack:** React 18, React Router v6, TypeScript, Tailwind CSS, Radix UI (via shadcn/ui), TanStack Query, Zustand, Clerk auth

**Spec:** `docs/superpowers/specs/2026-03-29-navigation-restructure-design.md`

---

## File Structure

### New files to create
```
portal/src/pages/Inbox.tsx                          — Unified conversation workspace (replaces LiveMonitor + Queue + ChatTakeover)
portal/src/pages/AiContent.tsx                      — AI & Content hub (replaces KnowledgeBase + CannedResponses)
portal/src/pages/settings/WidgetBrandSettings.tsx   — Widget & Brand settings (from Tenants page)
```

### Files to modify
```
portal/src/App.tsx                                  — Route definitions and redirects
portal/src/components/Sidebar.tsx                   — Menu items (9 → 5)
portal/src/pages/Analytics.tsx                      — Add Dashboard metric cards
portal/src/pages/settings/SettingsLayout.tsx         — Add Widget & Brand nav item
portal/src/components/settings/IntegrationTab.tsx   — Already handles webhook/API key (no changes needed)
```

### Files retired (kept but no longer routed to)
```
portal/src/pages/Dashboard.tsx          — Metrics merged into Analytics
portal/src/pages/LiveMonitor.tsx        — Merged into Inbox
portal/src/pages/Queue.tsx              — Merged into Inbox
portal/src/pages/ChatTakeover.tsx       — Merged into Inbox (right panel)
portal/src/pages/KnowledgeBase.tsx      — Merged into AiContent
portal/src/pages/CannedResponses.tsx    — Merged into AiContent
portal/src/pages/Tenants.tsx            — Split into Settings > Widget & Brand + Integrations
```

---

## Task 1: Create the Inbox page

**Files:**
- Create: `portal/src/pages/Inbox.tsx`

This is the highest-impact change. It merges Live Monitor, Queue, and Chat Takeover into a single split-pane workspace with filter tabs.

- [ ] **Step 1: Create the Inbox page file**

Create `portal/src/pages/Inbox.tsx`:

```tsx
/**
 * Inbox Page
 * Unified conversation workspace — replaces LiveMonitor, Queue, and ChatTakeover.
 * Left panel: filterable chat/handoff list. Right panel: active chat window.
 */

import React, { useState, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  MessageSquare,
  Bot,
  Headphones,
  UserCheck,
  X,
  ArrowLeft,
  ArrowRightLeft,
  PhoneOff,
  HandMetal,
  AlertCircle,
  User,
  Timer,
  MessageCircle,
} from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardContent } from '@/components/ui/card';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { ChatStatusBadge } from '@components/StatusBadge';

import { ChatStream } from '@components/ChatStream';
import { ChatWindow } from '@components/ChatWindow';

import { useTenantSettings } from '@/queries/useTenantQueries';
import { useChatsQuery } from '@/queries/useChatQueries';
import { useHandoffsQuery, useAcceptHandoff, useRejectHandoff } from '@/queries/useHandoffQueries';
import { useNotificationSound } from '@/hooks/useNotificationSound';
import { agentOptions } from '@/queries/useAgentQueries';
import { api } from '@/lib/api';

import type { Chat, HandoffRequest } from '@app-types/index';

type InboxFilter = 'all' | 'bot' | 'handoff' | 'agent';
type HandoffPriority = 'urgent' | 'high' | 'medium' | 'low';

interface RawAgent {
  id: string;
  name: string;
  status: string;
  currentChatCount: number;
  maxChats: number;
  skills?: string[];
}

interface Agent {
  id: string;
  firstName: string;
  lastName: string;
  status: string;
  currentChatCount: number;
  maxChats: number;
  skills: string[];
}

function mapRawAgent(raw: RawAgent): Agent {
  const parts = raw.name.split(' ');
  return {
    id: raw.id,
    firstName: parts[0] || '',
    lastName: parts.slice(1).join(' ') || '',
    status: raw.status,
    currentChatCount: raw.currentChatCount,
    maxChats: raw.maxChats,
    skills: raw.skills ?? [],
  };
}

const priorityColors: Record<string, string> = {
  urgent: 'border-l-red-500 bg-red-500/5',
  high: 'border-l-orange-500 bg-orange-500/5',
  medium: 'border-l-yellow-500 bg-yellow-500/5',
  low: 'border-l-blue-500 bg-blue-500/5',
};

function getReasonIcon(reason: string) {
  switch (reason) {
    case 'user_request': return User;
    case 'sentiment_drop': return AlertCircle;
    case 'bot_failure': return Bot;
    case 'timeout': return Timer;
    default: return MessageCircle;
  }
}

function formatWaitTime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}m ${secs}s`;
}

const Inbox: React.FC = () => {
  const [searchParams, setSearchParams] = useSearchParams();
  const initialFilter = (searchParams.get('filter') as InboxFilter) || 'all';
  const initialChatId = searchParams.get('chat') || null;

  const [activeFilter, setActiveFilter] = useState<InboxFilter>(initialFilter);
  const [selectedChat, setSelectedChat] = useState<Chat | null>(null);
  const [selectedChatId, setSelectedChatId] = useState<string | null>(initialChatId);
  const [isTransferModalOpen, setIsTransferModalOpen] = useState(false);
  const [filterPriority, setFilterPriority] = useState<HandoffPriority | 'all'>('all');
  const [isMobileChatOpen, setIsMobileChatOpen] = useState(false);

  // Data hooks
  const { data: tenant } = useTenantSettings();
  const tenants = tenant ? [tenant] : [];
  const { chats } = useChatsQuery({ filters: { status: undefined } });
  const { handoffs, pendingCount, isLoading: handoffsLoading } = useHandoffsQuery('pending');
  const acceptMutation = useAcceptHandoff();
  const rejectMutation = useRejectHandoff();
  useNotificationSound();

  // Transfer modal agents
  const { data: rawAgents } = useQuery({
    ...agentOptions.list({ status: 'online' }),
    enabled: isTransferModalOpen,
  });
  const agents: Agent[] = ((rawAgents as RawAgent[] | undefined) ?? []).map(mapRawAgent);

  // Filter chats by tab
  const filteredChats = useMemo(() => {
    if (!chats) return [];
    switch (activeFilter) {
      case 'bot': return chats.filter((c: Chat) => c.status === 'bot');
      case 'agent': return chats.filter((c: Chat) => c.status === 'human');
      case 'handoff': return []; // Handoff tab shows handoff cards, not chats
      default: return chats;
    }
  }, [chats, activeFilter]);

  // Filter handoffs by priority
  const filteredHandoffs = useMemo(() => {
    if (filterPriority === 'all') return handoffs;
    return handoffs.filter((h: HandoffRequest) => h.priority === filterPriority);
  }, [handoffs, filterPriority]);

  // Load chat for right panel when selected via URL param
  React.useEffect(() => {
    if (initialChatId && !selectedChat) {
      api.get<{ data: Chat }>(`/chats/${initialChatId}`).then((res) => {
        setSelectedChat(res.data.data ?? (res.data as unknown as Chat));
      }).catch(() => {});
    }
  }, [initialChatId, selectedChat]);

  const handleFilterChange = (filter: string) => {
    setActiveFilter(filter as InboxFilter);
    setSearchParams(filter === 'all' ? {} : { filter });
  };

  const handleChatSelect = (chat: Chat) => {
    setSelectedChat(chat);
    setSelectedChatId(chat.id);
    setSearchParams({ chat: chat.id });
    setIsMobileChatOpen(true);
  };

  const handleAcceptHandoff = async (handoff: HandoffRequest) => {
    try {
      await acceptMutation.mutateAsync(handoff.id);
      const res = await api.get<{ data: Chat }>(`/chats/${handoff.chatId}`);
      const chat = res.data.data ?? (res.data as unknown as Chat);
      setSelectedChat(chat);
      setSelectedChatId(handoff.chatId);
      setSearchParams({ chat: handoff.chatId });
      setIsMobileChatOpen(true);
    } catch { /* mutation handles error toast */ }
  };

  const handleDeclineHandoff = async (handoffId: string) => {
    try {
      await rejectMutation.mutateAsync({ handoffId, reason: 'declined' });
    } catch { /* mutation handles error toast */ }
  };

  const handleTakeover = async (chatId: string) => {
    try {
      await api.post(`/chats/${chatId}/takeover`);
      const res = await api.get<{ data: Chat }>(`/chats/${chatId}`);
      setSelectedChat(res.data.data ?? (res.data as unknown as Chat));
    } catch { /* error toast */ }
  };

  const handleTransfer = async (agentId: string) => {
    if (!selectedChat) return;
    try {
      await api.post(`/chats/${selectedChat.id}/transfer`, { agentId });
      setSelectedChat(null);
      setSelectedChatId(null);
      setIsTransferModalOpen(false);
      setSearchParams({});
    } catch { /* error toast */ }
  };

  const handleCloseChat = async () => {
    if (!selectedChat) return;
    try {
      await api.post(`/chats/${selectedChat.id}/close`);
      setSelectedChat(null);
      setSelectedChatId(null);
      setSearchParams({});
    } catch { /* error toast */ }
  };

  const handleCloseChatPanel = () => {
    setSelectedChat(null);
    setSelectedChatId(null);
    setIsMobileChatOpen(false);
    setSearchParams(activeFilter === 'all' ? {} : { filter: activeFilter });
  };

  const isHandoff = selectedChat?.status === 'handsoff';
  const isHuman = selectedChat?.status === 'human';

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="px-6 py-4 border-b border-edge flex items-center justify-between flex-shrink-0">
        <h1 className="text-2xl font-bold text-text-primary">Inbox</h1>
      </div>

      <div className="flex-1 flex overflow-hidden">
        {/* Left Panel — Chat/Handoff List */}
        <div className={cn(
          'w-full md:w-96 md:min-w-[384px] border-r border-edge flex flex-col overflow-hidden',
          isMobileChatOpen && 'hidden md:flex'
        )}>
          {/* Filter tabs */}
          <div className="px-4 py-3 border-b border-edge flex-shrink-0">
            <Tabs value={activeFilter} onValueChange={handleFilterChange}>
              <TabsList className="w-full">
                <TabsTrigger value="all" className="flex-1">All</TabsTrigger>
                <TabsTrigger value="bot" className="flex-1">
                  <Bot className="w-4 h-4 mr-1" />
                  Bot
                </TabsTrigger>
                <TabsTrigger value="handoff" className="flex-1 gap-1">
                  <Headphones className="w-4 h-4 mr-1" />
                  Handoff
                  {pendingCount > 0 && (
                    <span className="ml-1 flex items-center justify-center min-w-5 h-5 px-1.5 text-xs font-medium text-white bg-red-500 rounded-full">
                      {pendingCount > 99 ? '99+' : pendingCount}
                    </span>
                  )}
                </TabsTrigger>
                <TabsTrigger value="agent" className="flex-1">
                  <UserCheck className="w-4 h-4 mr-1" />
                  Agent
                </TabsTrigger>
              </TabsList>
            </Tabs>

            {/* Priority filter for handoff tab */}
            {activeFilter === 'handoff' && (
              <div className="mt-2">
                <Select value={filterPriority} onValueChange={(v) => setFilterPriority(v as HandoffPriority | 'all')}>
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Filter by priority" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Priorities</SelectItem>
                    <SelectItem value="urgent">Urgent</SelectItem>
                    <SelectItem value="high">High</SelectItem>
                    <SelectItem value="medium">Medium</SelectItem>
                    <SelectItem value="low">Low</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>

          {/* List content */}
          <div className="flex-1 overflow-y-auto">
            {activeFilter === 'handoff' ? (
              /* Handoff list */
              <div className="p-3 space-y-2">
                {handoffsLoading ? (
                  Array.from({ length: 3 }).map((_, i) => (
                    <Skeleton key={i} className="h-28 w-full rounded-xl" />
                  ))
                ) : filteredHandoffs.length === 0 ? (
                  <div className="text-center py-12 text-text-secondary">
                    <Headphones className="w-12 h-12 mx-auto mb-3 text-text-muted" />
                    <p>No pending handoffs</p>
                    <p className="text-sm text-text-muted mt-1">The queue is clear.</p>
                  </div>
                ) : (
                  filteredHandoffs.map((handoff: HandoffRequest) => {
                    const ReasonIcon = getReasonIcon(handoff.reason);
                    return (
                      <div
                        key={handoff.id}
                        className={cn(
                          'p-4 rounded-xl border-l-4 border border-edge transition-colors',
                          priorityColors[handoff.priority] || ''
                        )}
                      >
                        <div className="flex items-start justify-between mb-2">
                          <div className="flex items-center gap-2">
                            <span className="font-medium text-text-primary">
                              {handoff.userName || 'Anonymous'}
                            </span>
                            <Badge variant="outline" className="text-xs capitalize">
                              {handoff.priority}
                            </Badge>
                          </div>
                          <span className={cn(
                            'text-sm font-mono',
                            handoff.waitTime > 300 ? 'text-red-400' : 'text-text-muted'
                          )}>
                            {formatWaitTime(handoff.waitTime)}
                          </span>
                        </div>
                        <div className="flex items-center gap-2 text-sm text-text-secondary mb-3">
                          <ReasonIcon className="w-4 h-4" />
                          <span>{handoff.reason.replace(/_/g, ' ')}</span>
                          <span className="text-text-muted">•</span>
                          <span>{handoff.tenantName}</span>
                        </div>
                        {handoff.reasonDetails && (
                          <p className="text-sm text-text-muted mb-3 italic">
                            "{handoff.reasonDetails}"
                          </p>
                        )}
                        <div className="flex gap-2">
                          <Button
                            size="sm"
                            onClick={() => handleAcceptHandoff(handoff)}
                            disabled={acceptMutation.isPending}
                          >
                            Accept
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => handleDeclineHandoff(handoff.id)}
                            disabled={rejectMutation.isPending}
                          >
                            Decline
                          </Button>
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            ) : (
              /* Chat list via ChatStream */
              <ChatStream
                tenants={tenants}
                onChatSelect={handleChatSelect}
                onTakeover={handleTakeover}
                selectedChatId={selectedChatId ?? undefined}
                className="h-full"
                filter={activeFilter === 'all' ? undefined : activeFilter}
              />
            )}
          </div>
        </div>

        {/* Right Panel — Chat Window */}
        <div className={cn(
          'flex-1 flex flex-col overflow-hidden',
          !isMobileChatOpen && 'hidden md:flex'
        )}>
          {selectedChat ? (
            <>
              {/* Chat panel header */}
              <div className="px-4 py-3 border-b border-edge flex items-center justify-between flex-shrink-0">
                <div className="flex items-center gap-3">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="md:hidden"
                    onClick={handleCloseChatPanel}
                  >
                    <ArrowLeft className="w-4 h-4" />
                  </Button>
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-text-primary">
                        {selectedChat.userName || 'Anonymous'}
                      </span>
                      <ChatStatusBadge status={selectedChat.status} size="sm" />
                    </div>
                    <p className="text-xs text-text-muted">
                      {selectedChat.tenantName}
                      {selectedChat.assignedAgentName && ` • Agent: ${selectedChat.assignedAgentName}`}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {isHandoff && (
                    <Button size="sm" onClick={() => handleTakeover(selectedChat.id)}>
                      <HandMetal className="w-4 h-4 mr-1" />
                      Takeover
                    </Button>
                  )}
                  {isHuman && (
                    <>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => setIsTransferModalOpen(true)}
                      >
                        <ArrowRightLeft className="w-4 h-4 mr-1" />
                        Transfer
                      </Button>
                      <Button
                        size="sm"
                        variant="destructive"
                        onClick={handleCloseChat}
                      >
                        <PhoneOff className="w-4 h-4 mr-1" />
                        Close
                      </Button>
                    </>
                  )}
                  <Button
                    variant="ghost"
                    size="sm"
                    className="hidden md:flex"
                    onClick={handleCloseChatPanel}
                  >
                    <X className="w-4 h-4" />
                  </Button>
                </div>
              </div>

              {/* Chat messages */}
              <div className="flex-1 overflow-hidden">
                <ChatWindow
                  chat={selectedChat}
                  onTransfer={() => setIsTransferModalOpen(true)}
                />
              </div>
            </>
          ) : (
            /* Empty state */
            <div className="flex-1 flex items-center justify-center text-text-secondary">
              <div className="text-center">
                <MessageSquare className="w-16 h-16 mx-auto mb-4 text-text-muted" />
                <p className="text-lg font-medium">Select a conversation</p>
                <p className="text-sm text-text-muted mt-1">
                  Choose a chat from the list to start viewing
                </p>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Transfer Modal */}
      <Dialog open={isTransferModalOpen} onOpenChange={setIsTransferModalOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Transfer Chat</DialogTitle>
            <DialogDescription>Select an online agent to transfer this chat to.</DialogDescription>
          </DialogHeader>
          <div className="space-y-2 max-h-64 overflow-y-auto">
            {agents.length === 0 ? (
              <p className="text-sm text-text-secondary py-4 text-center">No agents online</p>
            ) : (
              agents.map((agent) => (
                <button
                  key={agent.id}
                  onClick={() => handleTransfer(agent.id)}
                  className="w-full flex items-center justify-between p-3 rounded-xl hover:bg-surface-3 transition-colors text-left"
                >
                  <div>
                    <p className="font-medium text-text-primary">
                      {agent.firstName} {agent.lastName}
                    </p>
                    {agent.skills.length > 0 && (
                      <p className="text-xs text-text-muted">{agent.skills.join(', ')}</p>
                    )}
                  </div>
                  <span className="text-sm text-text-secondary">
                    {agent.currentChatCount}/{agent.maxChats} chats
                  </span>
                </button>
              ))
            )}
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setIsTransferModalOpen(false)}>Cancel</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default Inbox;
```

- [ ] **Step 2: Verify the file compiles**

Run: `cd chatbot-platform && npx tsc --noEmit 2>&1 | head -30`

Note: There may be TypeScript errors related to the `ChatStream` `filter` prop — this component may not yet accept a `filter` prop. If so, proceed to Step 3 to fix it; if it compiles, skip Step 3.

- [ ] **Step 3: Add filter prop to ChatStream if needed**

Check the `ChatStream` component interface. If it doesn't accept a `filter` prop, you have two options:
1. Filter the chats at the Inbox level before passing to ChatStream (preferred if ChatStream accepts a `chats` array prop)
2. Add a `filter` prop to ChatStream

Read `ChatStream` source first. Adapt the filtering approach to match how ChatStream currently works. The goal is to show only bot/agent/all chats based on the active tab.

- [ ] **Step 4: Commit**

```bash
git add portal/src/pages/Inbox.tsx
git commit -m "feat: create unified Inbox page

Merges Live Monitor, Queue, and Chat Takeover into a single
split-pane workspace with filter tabs (All/Bot/Handoff/Agent)."
```

---

## Task 2: Create the AI & Content page

**Files:**
- Create: `portal/src/pages/AiContent.tsx`

This merges Knowledge Base and Canned Responses into a single tabbed page, promoting AI Settings from a slide-over panel to a first-class tab.

- [ ] **Step 1: Create the AiContent page file**

Create `portal/src/pages/AiContent.tsx`:

```tsx
/**
 * AI & Content Page
 * Unified hub for Knowledge Base, Canned Responses, and AI Settings.
 * Replaces separate /knowledge and /canned-responses pages.
 */

import React, { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  BookOpen,
  Zap,
  Settings,
  FlaskConical,
  Loader2,
} from 'lucide-react';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

import { DocumentsTab } from '@/pages/knowledge/DocumentsTab';
import { AiSettingsTab } from '@/pages/knowledge/AiSettingsTab';
import { TestChatPanel } from '@/pages/knowledge/TestChatPanel';
import { AddDocumentModal } from '@/pages/knowledge/AddDocumentModal';

import { useAppAuth } from '@auth/useAppAuth';
import { useKnowledgeStats } from '@/queries/useKnowledgeQueries';
import { useGetAiSettings, useUpdateAiSettings } from '@/queries/useAiQueries';
import { useCannedResponses, useCreateCannedResponse, useUpdateCannedResponse, useDeleteCannedResponse } from '@/queries/useCannedResponseQueries';

import type { CannedResponse } from '@app-types/index';

// Inline the canned responses content to avoid importing the full page component.
// This keeps the tab self-contained while reusing the same hooks.
import { CannedResponsesContent } from '@/pages/CannedResponses';

type AiContentTab = 'knowledge' | 'canned' | 'settings';

const AiContent: React.FC = () => {
  const [searchParams, setSearchParams] = useSearchParams();
  const initialTab = (searchParams.get('tab') as AiContentTab) || 'knowledge';

  const [activeTab, setActiveTab] = useState<AiContentTab>(initialTab);
  const [isTestChatOpen, setIsTestChatOpen] = useState(false);
  const [activeFilter, setActiveFilter] = useState<string | undefined>();
  const [showAddDoc, setShowAddDoc] = useState(false);

  const { isRole } = useAppAuth();
  const isAdmin = isRole('admin') || isRole('super_admin');
  const isSupervisorOrAbove = isAdmin || isRole('supervisor');

  const { data: stats } = useKnowledgeStats() as { data: any };
  const { data: aiSettings } = useGetAiSettings() as { data: any };
  const updateSettings = useUpdateAiSettings();

  const documents = stats?.documents || {};
  const indexed = parseInt(documents.indexed || '0');
  const hasAiConfigured = aiSettings?.enabled && aiSettings?.hasApiKey;
  const hasIndexedDocs = indexed > 0;

  const handleTabChange = (tab: string) => {
    const t = tab as AiContentTab;
    setActiveTab(t);
    setSearchParams(t === 'knowledge' ? {} : { tab: t });
  };

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="px-6 py-4 border-b border-edge flex items-center justify-between flex-shrink-0">
        <h1 className="text-2xl font-bold text-text-primary">AI & Content</h1>
        <div className="flex items-center gap-2">
          {isAdmin && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setIsTestChatOpen(true)}
              disabled={!hasAiConfigured}
            >
              <FlaskConical className="w-4 h-4 mr-1" />
              Test AI
            </Button>
          )}
        </div>
      </div>

      {/* Tabs */}
      <div className="flex-1 overflow-hidden flex flex-col">
        <Tabs value={activeTab} onValueChange={handleTabChange} className="flex-1 flex flex-col overflow-hidden">
          <div className="px-6 pt-4 flex-shrink-0">
            <TabsList>
              <TabsTrigger value="knowledge">
                <BookOpen className="w-4 h-4 mr-1.5" />
                Knowledge Base
              </TabsTrigger>
              <TabsTrigger value="canned">
                <Zap className="w-4 h-4 mr-1.5" />
                Canned Responses
              </TabsTrigger>
              {isSupervisorOrAbove && (
                <TabsTrigger value="settings">
                  <Settings className="w-4 h-4 mr-1.5" />
                  AI Settings
                </TabsTrigger>
              )}
            </TabsList>
          </div>

          <TabsContent value="knowledge" className="flex-1 overflow-y-auto px-6 py-4 mt-0">
            {/* Stats strip */}
            <div className="flex items-center gap-3 mb-6 flex-wrap">
              {[
                { label: 'Total', value: parseInt(documents.indexed || '0') + parseInt(documents.processing || '0') + parseInt(documents.failed || '0') + parseInt(documents.pending || '0') },
                { label: 'Indexed', value: indexed, filterKey: 'indexed' },
                { label: 'Processing', value: parseInt(documents.processing || '0'), filterKey: 'processing', isAnimated: true },
                { label: 'Failed', value: parseInt(documents.failed || '0'), filterKey: 'failed' },
              ].map((stat) => (
                <button
                  key={stat.label}
                  onClick={() => stat.filterKey && setActiveFilter(activeFilter === stat.filterKey ? undefined : stat.filterKey)}
                  className={cn(
                    'px-3 py-1.5 rounded-lg text-sm font-medium transition-colors',
                    activeFilter === stat.filterKey
                      ? 'bg-primary-600/10 text-primary-400'
                      : 'bg-surface-3 text-text-secondary hover:bg-surface-4',
                    !stat.filterKey && 'cursor-default'
                  )}
                >
                  {stat.isAnimated && stat.value > 0 && (
                    <Loader2 className="w-3 h-3 mr-1 inline animate-spin" />
                  )}
                  {stat.label}: {stat.value}
                </button>
              ))}
            </div>

            <DocumentsTab
              filter={activeFilter}
              onAddDocument={() => setShowAddDoc(true)}
            />
          </TabsContent>

          <TabsContent value="canned" className="flex-1 overflow-y-auto mt-0">
            <CannedResponsesContent />
          </TabsContent>

          {isSupervisorOrAbove && (
            <TabsContent value="settings" className="flex-1 overflow-y-auto px-6 py-4 mt-0">
              <AiSettingsTab />
            </TabsContent>
          )}
        </Tabs>
      </div>

      {/* Test Chat slide-over */}
      {isTestChatOpen && (
        <div className="fixed inset-0 z-50 flex justify-end">
          <div className="absolute inset-0 bg-black/50" onClick={() => setIsTestChatOpen(false)} />
          <div className="relative w-full max-w-md bg-surface-0 border-l border-edge shadow-xl">
            <TestChatPanel
              botName={aiSettings?.brandVoice?.name || 'AI Bot'}
              provider={aiSettings?.provider}
              model={aiSettings?.model}
              hasIndexedDocs={hasIndexedDocs}
              onClose={() => setIsTestChatOpen(false)}
            />
          </div>
        </div>
      )}

      {/* Add Document Modal */}
      {showAddDoc && (
        <AddDocumentModal
          isOpen={showAddDoc}
          onClose={() => setShowAddDoc(false)}
        />
      )}
    </div>
  );
};

export default AiContent;
```

- [ ] **Step 2: Extract CannedResponsesContent from CannedResponses page**

The `CannedResponses.tsx` page currently exports a default component that includes the page header. We need a version without the outer header wrapper so it fits inside the AI & Content tab. Add a named export `CannedResponsesContent` at the bottom of `portal/src/pages/CannedResponses.tsx`:

Read the current file first to determine the exact component structure. Then extract the inner content (everything below the page header) into a `CannedResponsesContent` component. The existing default export should render `CannedResponsesContent` wrapped in the page header, so the old `/canned-responses` route still works during the transition.

Pattern:
```tsx
// At the bottom of CannedResponses.tsx, refactor:
export const CannedResponsesContent: React.FC = () => {
  // ... all the hooks, state, handlers, and JSX that currently live in CannedResponses
  // MINUS the outer <div className="p-6 space-y-6"> and <h1>Canned Responses</h1> header
};

const CannedResponses: React.FC = () => {
  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-text-primary">Canned Responses</h1>
      </div>
      <CannedResponsesContent />
    </div>
  );
};

export default CannedResponses;
```

- [ ] **Step 3: Verify imports compile**

Run: `cd chatbot-platform && npx tsc --noEmit 2>&1 | head -30`

Fix any import path issues. The query hook imports may need adjustment based on actual file paths — check the existing import paths in `KnowledgeBase.tsx` and `CannedResponses.tsx` to match exactly.

- [ ] **Step 4: Commit**

```bash
git add portal/src/pages/AiContent.tsx portal/src/pages/CannedResponses.tsx
git commit -m "feat: create AI & Content page

Merges Knowledge Base, Canned Responses, and AI Settings into
a single tabbed page. Extracts CannedResponsesContent for reuse."
```

---

## Task 3: Merge Dashboard metrics into Analytics

**Files:**
- Modify: `portal/src/pages/Analytics.tsx`

Add the Dashboard's real-time metric cards (Active Chats, Pending Handoffs, Online Agents) to the top of the Analytics page, combining both data sources.

- [ ] **Step 1: Add Dashboard hooks and metric cards to Analytics**

Read the current `portal/src/pages/Analytics.tsx` and `portal/src/pages/Dashboard.tsx` files first.

Add the Dashboard's `useDashboardMetrics` hook import and extend the stats cards array to include all 6 metrics. Update the import section and the stats array:

```tsx
// Add to existing imports in Analytics.tsx:
import { useDashboardMetrics } from '../queries/useDashboardQueries';
import { useHandoffsQuery } from '../queries/useHandoffQueries';
import { useNavigate } from 'react-router-dom';
import { Headphones, TrendingUp } from 'lucide-react';
```

In the component body, add:
```tsx
const navigate = useNavigate();
const { data: rawDashboard } = useDashboardMetrics();
const { pendingCount } = useHandoffsQuery('pending');

const dashboard = rawDashboard?.dashboard;
```

Replace the existing 4-item `stats` array with a 6-item version combining Dashboard and Analytics data:
```tsx
const stats = [
  {
    label: 'Active Chats',
    value: dashboard ? (dashboard.sessions.active + dashboard.sessions.bot) : '--',
    icon: MessageSquare,
    color: 'text-primary-400',
    bgColor: 'bg-primary-600/10',
    onClick: () => navigate('/inbox'),
  },
  {
    label: 'Pending Handoffs',
    value: pendingCount ?? 0,
    icon: Headphones,
    color: 'text-accent-400',
    bgColor: 'bg-accent-500/10',
    alert: (pendingCount ?? 0) > 3,
    onClick: () => navigate('/inbox?filter=handoff'),
  },
  {
    label: 'Online Agents',
    value: dashboard ? `${dashboard.agents.online}/${dashboard.agents.total}` : '--',
    icon: Users,
    color: 'text-status-online',
    bgColor: 'bg-status-online/10',
  },
  {
    label: 'Avg Response Time',
    value: dashboard ? `${dashboard.avgResponseTimeSeconds}s` : (metrics?.avgDurationSeconds != null ? `${metrics.avgDurationSeconds}s` : '--'),
    icon: Clock,
    color: 'text-status-online',
    bgColor: 'bg-status-online/10',
  },
  {
    label: 'CSAT Score',
    value: dashboard?.csatScore != null ? `${dashboard.csatScore}/5` : '--',
    icon: Star,
    color: 'text-accent-400',
    bgColor: 'bg-accent-500/10',
  },
  {
    label: 'Bot Resolution',
    value: dashboard?.botResolutionRate != null ? `${dashboard.botResolutionRate}%` : '--',
    icon: TrendingUp,
    color: 'text-primary-400',
    bgColor: 'bg-primary-600/10',
  },
];
```

Update the stats grid to be 6-column on large screens:
```tsx
<div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
```

Make clickable cards navigate when they have an `onClick`:
```tsx
<Card
  key={index}
  variant="glass"
  hover
  className={cn('cursor-pointer', stat.onClick && 'cursor-pointer')}
  onClick={stat.onClick}
>
```

- [ ] **Step 2: Verify the page renders**

Run: `cd chatbot-platform && npx tsc --noEmit 2>&1 | head -30`

- [ ] **Step 3: Commit**

```bash
git add portal/src/pages/Analytics.tsx
git commit -m "feat: merge Dashboard metrics into Analytics page

Adds real-time metric cards (Active Chats, Pending Handoffs,
Online Agents, CSAT, Bot Resolution) from Dashboard to Analytics,
making Analytics the single source for all performance data."
```

---

## Task 4: Add Widget & Brand settings page

**Files:**
- Create: `portal/src/pages/settings/WidgetBrandSettings.tsx`
- Modify: `portal/src/pages/settings/SettingsLayout.tsx`

Extract the branding/widget configuration from `Tenants.tsx` into a new Settings sub-page.

- [ ] **Step 1: Create WidgetBrandSettings page**

Read `portal/src/pages/Tenants.tsx` first to get the exact component structure, then create a simplified version that shows the branding config:

Create `portal/src/pages/settings/WidgetBrandSettings.tsx`:

```tsx
/**
 * Widget & Brand Settings
 * Manages tenant branding (logo, colors, name) and session stats.
 * Extracted from Tenants page for Settings integration.
 */

import React, { useState, useRef } from 'react';
import {
  Palette,
  Upload,
  Trash2,
  Building2,
  Activity,
} from 'lucide-react';
import { useOrganization } from '@clerk/clerk-react';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';

import { useTenantSettings, useUpdateTenant } from '@/queries/useTenantQueries';

const colorPresets = [
  '#6366f1', '#8b5cf6', '#a855f7', '#d946ef',
  '#ec4899', '#f43f5e', '#ef4444', '#f97316',
  '#f59e0b', '#eab308', '#84cc16', '#22c55e',
  '#10b981', '#14b8a6', '#06b6d4', '#0ea5e9',
  '#3b82f6', '#6366f1', '#1e293b', '#475569',
];

const WidgetBrandSettings: React.FC = () => {
  const { organization } = useOrganization();
  const { data: rawTenant, isLoading } = useTenantSettings();
  const updateMutation = useUpdateTenant();

  const [isUploadingLogo, setIsUploadingLogo] = useState(false);
  const [editingColor, setEditingColor] = useState<string | null>(null);
  const [editingName, setEditingName] = useState<string | null>(null);
  const logoInputRef = useRef<HTMLInputElement>(null);

  const tenant = rawTenant as any;

  const handleLogoUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !organization) return;
    setIsUploadingLogo(true);
    try {
      await organization.setLogo({ file });
      toast.success('Logo updated');
    } catch {
      toast.error('Failed to upload logo');
    } finally {
      setIsUploadingLogo(false);
    }
  };

  const handleLogoRemove = async () => {
    if (!organization) return;
    setIsUploadingLogo(true);
    try {
      await organization.setLogo({ file: null });
      toast.success('Logo removed');
    } catch {
      toast.error('Failed to remove logo');
    } finally {
      setIsUploadingLogo(false);
    }
  };

  const handleColorSave = async (color: string) => {
    try {
      await updateMutation.mutateAsync({ settings: { primaryColor: color } });
      setEditingColor(null);
      toast.success('Brand color updated');
    } catch {
      toast.error('Failed to update color');
    }
  };

  const handleNameSave = async () => {
    if (!editingName) return;
    try {
      await updateMutation.mutateAsync({ name: editingName });
      setEditingName(null);
      toast.success('Name updated');
    } catch {
      toast.error('Failed to update name');
    }
  };

  if (isLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-48 w-full rounded-xl" />
        <Skeleton className="h-32 w-full rounded-xl" />
      </div>
    );
  }

  const primaryColor = tenant?.settings?.primaryColor || '#6366f1';

  return (
    <div className="space-y-6">
      {/* Logo */}
      <Card variant="glass">
        <CardHeader className="pb-2">
          <h3 className="font-semibold text-text-primary flex items-center gap-2">
            <Building2 className="w-4 h-4" />
            Branding
          </h3>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <Label className="text-sm text-text-secondary mb-2 block">Logo</Label>
            <div className="flex items-center gap-4">
              <div className="relative group">
                {organization?.hasImage ? (
                  <img
                    src={organization.imageUrl}
                    alt={organization.name ?? ''}
                    className="w-16 h-16 rounded-xl object-cover"
                  />
                ) : (
                  <div className="w-16 h-16 bg-primary-600/20 rounded-xl flex items-center justify-center">
                    <span className="text-xl font-bold text-primary-400">
                      {organization?.name?.charAt(0)?.toUpperCase() ?? 'H'}
                    </span>
                  </div>
                )}
              </div>
              <div className="flex gap-2">
                <Button size="sm" variant="outline" onClick={() => logoInputRef.current?.click()} disabled={isUploadingLogo}>
                  <Upload className="w-4 h-4 mr-1" />
                  Upload
                </Button>
                {organization?.hasImage && (
                  <Button size="sm" variant="ghost" onClick={handleLogoRemove} disabled={isUploadingLogo}>
                    <Trash2 className="w-4 h-4 mr-1" />
                    Remove
                  </Button>
                )}
              </div>
              <input ref={logoInputRef} type="file" accept="image/*" className="hidden" onChange={handleLogoUpload} />
            </div>
          </div>

          {/* Name */}
          <div>
            <Label className="text-sm text-text-secondary mb-2 block">Display Name</Label>
            <div className="flex items-center gap-2">
              <Input
                value={editingName ?? tenant?.name ?? ''}
                onChange={(e) => setEditingName(e.target.value)}
                className="max-w-xs"
              />
              {editingName !== null && editingName !== tenant?.name && (
                <Button size="sm" onClick={handleNameSave} disabled={updateMutation.isPending}>
                  Save
                </Button>
              )}
            </div>
            <p className="text-xs text-text-muted mt-1">Slug: {tenant?.slug}</p>
          </div>

          {/* Brand Color */}
          <div>
            <Label className="text-sm text-text-secondary mb-2 block">Brand Color</Label>
            <div className="flex flex-wrap gap-2">
              {colorPresets.map((color) => (
                <button
                  key={color}
                  onClick={() => handleColorSave(color)}
                  className={cn(
                    'w-8 h-8 rounded-lg transition-all',
                    primaryColor === color && 'ring-2 ring-offset-2 ring-primary-500'
                  )}
                  style={{ backgroundColor: color }}
                />
              ))}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Session Stats */}
      <Card variant="glass">
        <CardHeader className="pb-2">
          <h3 className="font-semibold text-text-primary flex items-center gap-2">
            <Activity className="w-4 h-4" />
            Usage
          </h3>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-4">
            <div>
              <p className="text-sm text-text-secondary">Active Sessions</p>
              <p className="text-2xl font-bold font-mono text-text-primary">
                {tenant?.activeSessions ?? 0} / {tenant?.maxSessions ?? '∞'}
              </p>
            </div>
            <Badge variant={tenant?.status === 'active' ? 'default' : 'secondary'}>
              {tenant?.status ?? 'active'}
            </Badge>
          </div>
        </CardContent>
      </Card>
    </div>
  );
};

export default WidgetBrandSettings;
```

- [ ] **Step 2: Add Widget & Brand to SettingsLayout navigation**

Read `portal/src/pages/settings/SettingsLayout.tsx`, then add the new nav item. Add the import and nav entry:

Add to imports:
```tsx
import { Palette } from 'lucide-react';
```

Add to the `settingsNav` array, in the Workspace group before Integrations:
```tsx
{ path: '/settings/widget', label: 'Widget & Brand', icon: Palette, group: 'Workspace' },
```

The Workspace group items should show only for admin/super_admin roles. Read the current file to check if role filtering exists in `SettingsLayout`. If not, add role-based filtering using `useAppAuth()`.

- [ ] **Step 3: Verify compilation**

Run: `cd chatbot-platform && npx tsc --noEmit 2>&1 | head -30`

- [ ] **Step 4: Commit**

```bash
git add portal/src/pages/settings/WidgetBrandSettings.tsx portal/src/pages/settings/SettingsLayout.tsx
git commit -m "feat: add Widget & Brand settings page

Extracts branding config (logo, color, name) from Tenants page
into Settings > Workspace > Widget & Brand."
```

---

## Task 5: Update routes and add redirects in App.tsx

**Files:**
- Modify: `portal/src/App.tsx`

Wire up the new pages, add redirects for old routes, and set role-based default landing pages.

- [ ] **Step 1: Read current App.tsx**

Read `portal/src/App.tsx` to get the exact current route structure, line numbers, and import paths.

- [ ] **Step 2: Add new page imports**

Add to the imports section of App.tsx:
```tsx
import Inbox from './pages/Inbox';
import AiContent from './pages/AiContent';
import WidgetBrandSettings from './pages/settings/WidgetBrandSettings';
```

- [ ] **Step 3: Replace route definitions**

Replace the existing protected routes with the new structure. Keep all existing wrappers (SocketProvider, ProtectedRoute, etc.):

**New protected routes (replace existing):**
```tsx
{/* === NEW ROUTES === */}

{/* Inbox — replaces /monitor, /queue, /takeover */}
<Route path="/inbox" element={
  <ProtectedRoute><SocketProvider><Inbox /></SocketProvider></ProtectedRoute>
} />

{/* AI & Content — replaces /knowledge, /canned-responses */}
<Route path="/ai" element={
  <ProtectedRoute><AiContent /></ProtectedRoute>
} />

{/* Analytics — now includes Dashboard metrics */}
<Route path="/analytics" element={
  <ProtectedRoute><SocketProvider><Analytics /></SocketProvider></ProtectedRoute>
} />

{/* Team — unchanged */}
<Route path="/team" element={
  <SupervisorRoute><Team /></SupervisorRoute>
} />

{/* Settings — now includes Widget & Brand */}
<Route path="/settings" element={
  <ProtectedRoute><SettingsLayout /></ProtectedRoute>
}>
  <Route index element={<Navigate to="/settings/profile" replace />} />
  <Route path="profile" element={<ProfileSettings />} />
  <Route path="notifications" element={<NotificationSettings />} />
  <Route path="appearance" element={<AppearanceSettings />} />
  <Route path="widget" element={<AdminRoute><WidgetBrandSettings /></AdminRoute>} />
  <Route path="integrations" element={<IntegrationSettings />} />
</Route>

{/* === REDIRECTS for old routes === */}
<Route path="/" element={<DefaultRedirect />} />
<Route path="/monitor" element={<Navigate to="/inbox" replace />} />
<Route path="/queue" element={<Navigate to="/inbox?filter=handoff" replace />} />
<Route path="/takeover/:chatId" element={<Navigate to="/inbox" replace />} />
<Route path="/knowledge" element={<Navigate to="/ai?tab=knowledge" replace />} />
<Route path="/canned-responses" element={<Navigate to="/ai?tab=canned" replace />} />
<Route path="/tenants" element={<Navigate to="/settings/widget" replace />} />

{/* Super Admin — unchanged */}
<Route path="/admin/tenants" element={<SuperAdminRoute><AdminTenants /></SuperAdminRoute>} />
<Route path="/admin/tenants/:id" element={<SuperAdminRoute><AdminTenantDetail /></SuperAdminRoute>} />
<Route path="/admin/users" element={<SuperAdminRoute><AdminUsers /></SuperAdminRoute>} />
<Route path="/admin/analytics" element={<SuperAdminRoute><AdminAnalytics /></SuperAdminRoute>} />

{/* Catch-all */}
<Route path="*" element={<Navigate to="/inbox" replace />} />
```

Note: The `/takeover/:chatId` redirect is simplified — the Navigate component doesn't support dynamic param forwarding in the `to` prop directly. A proper implementation would use a small redirect component:

```tsx
const TakeoverRedirect: React.FC = () => {
  const { chatId } = useParams<{ chatId: string }>();
  return <Navigate to={`/inbox?chat=${chatId}`} replace />;
};

// Then in routes:
<Route path="/takeover/:chatId" element={<TakeoverRedirect />} />
```

Add `TakeoverRedirect` inline in App.tsx above the main App component, or at the top of the routes section.

Also add a `DefaultRedirect` component for role-based landing:
```tsx
const DefaultRedirect: React.FC = () => {
  const { user } = useAppAuth();
  // Agents land on Inbox (conversations are their primary workflow)
  // Supervisors/Admins/Super Admins land on Analytics (overview first)
  if (user?.role === 'agent') {
    return <Navigate to="/inbox" replace />;
  }
  return <Navigate to="/analytics" replace />;
};
```

- [ ] **Step 4: Remove old route imports that are no longer directly routed**

Remove these imports from App.tsx (the components are still used transitionally but no longer have direct routes):
```tsx
// Remove these imports:
import Dashboard from './pages/Dashboard';
import LiveMonitor from './pages/LiveMonitor';
import Queue from './pages/Queue';
import ChatTakeover from './pages/ChatTakeover';
import KnowledgeBase from './pages/KnowledgeBase';
import CannedResponses from './pages/CannedResponses';
import Tenants from './pages/Tenants';
```

- [ ] **Step 5: Verify compilation**

Run: `cd chatbot-platform && npx tsc --noEmit 2>&1 | head -30`

- [ ] **Step 6: Commit**

```bash
git add portal/src/App.tsx
git commit -m "feat: update routes for new navigation structure

Wires Inbox, AI & Content, and Widget & Brand pages.
Adds redirects for all old routes (/monitor, /queue, /takeover,
/knowledge, /canned-responses, /tenants) to their new locations."
```

---

## Task 6: Update the Sidebar

**Files:**
- Modify: `portal/src/components/Sidebar.tsx`

Reduce menu items from 9 to 5 and move the handoff badge to the Inbox item.

- [ ] **Step 1: Read current Sidebar.tsx**

Read `portal/src/components/Sidebar.tsx` to confirm the exact current menu items array structure.

- [ ] **Step 2: Update the menuItems array**

Replace the `menuItems` array (currently lines 43-53) with:

```tsx
const menuItems: MenuItem[] = [
  { path: '/inbox', label: 'Inbox', icon: MessageSquare, roles: ['super_admin', 'admin', 'supervisor', 'agent'] },
  { path: '/ai', label: 'AI & Content', icon: BookOpen, roles: ['super_admin', 'admin', 'supervisor', 'agent'] },
  { path: '/analytics', label: 'Analytics', icon: BarChart3, roles: ['super_admin', 'admin', 'supervisor', 'agent'] },
  { path: '/team', label: 'Team', icon: Users, roles: ['super_admin', 'admin', 'supervisor'] },
  { path: '/settings', label: 'Settings', icon: Settings, roles: ['super_admin', 'admin', 'supervisor', 'agent'] },
];
```

- [ ] **Step 3: Update the badge logic**

The badge currently shows on the `/queue` item. Update it to show on `/inbox`:

Change the badge rendering condition from:
```tsx
{item.path === '/queue' && pendingHandoffs > 0 && (
```
to:
```tsx
{item.path === '/inbox' && pendingHandoffs > 0 && (
```

- [ ] **Step 4: Remove unused icon imports**

Remove icons that are no longer used in the menu items:
```tsx
// Remove from imports:
import { LayoutDashboard, Headphones, Zap, Building2 } from 'lucide-react';
```

Keep: `MessageSquare`, `Users`, `BarChart3`, `Settings`, `LogOut`, `BookOpen`, `Shield`, `UserCog`, `TrendingUp`

- [ ] **Step 5: Verify compilation**

Run: `cd chatbot-platform && npx tsc --noEmit 2>&1 | head -30`

- [ ] **Step 6: Commit**

```bash
git add portal/src/components/Sidebar.tsx
git commit -m "feat: consolidate sidebar from 9 items to 5

Updates navigation to intent-based groups:
Inbox, AI & Content, Analytics, Team, Settings.
Moves handoff badge from Queue to Inbox."
```

---

## Task 7: Smoke test and fix integration issues

**Files:**
- Potentially modify any of the new files based on what breaks

This task is for running the app and fixing any integration issues that surface.

- [ ] **Step 1: Start the dev server**

Run: `cd chatbot-platform && npm run dev`

Open the portal in the browser. Check each new page:

1. `/inbox` — verify chat list renders, filter tabs work, selecting a chat opens the right panel
2. `/ai` — verify Knowledge Base tab shows documents, Canned Responses tab works, AI Settings tab shows config
3. `/analytics` — verify 6 metric cards render, charts load, clickable cards navigate to Inbox
4. `/settings/widget` — verify branding config renders
5. Old URLs redirect: `/monitor` → `/inbox`, `/queue` → `/inbox?filter=handoff`, etc.

- [ ] **Step 2: Fix any ChatStream filter prop issues**

If `ChatStream` doesn't support filtering by status, you'll need to adapt. Options:
1. Pass filtered `chats` array if ChatStream accepts a `chats` prop
2. Add a `filter` prop to ChatStream
3. Filter in Inbox and render chat items directly instead of using ChatStream

Read ChatStream source to determine the right approach.

- [ ] **Step 3: Fix any import path issues**

Common issues:
- Query hook import paths may differ from what's shown in the plan (check actual paths in existing pages)
- Type imports may need adjustment
- `CannedResponsesContent` export may need the exact inner JSX from the current page

- [ ] **Step 4: Fix any TypeScript errors**

Run: `cd chatbot-platform && npx tsc --noEmit`

Fix all errors before proceeding.

- [ ] **Step 5: Commit fixes**

```bash
git add -A
git commit -m "fix: resolve integration issues from navigation restructure"
```

---

## Task 8: Clean up and final commit

**Files:**
- No new files

- [ ] **Step 1: Verify all redirects work**

Test each redirect in the browser:
- `/` → should land on `/inbox` (or `/analytics` depending on role)
- `/monitor` → `/inbox`
- `/queue` → `/inbox?filter=handoff`
- `/takeover/some-id` → `/inbox?chat=some-id`
- `/knowledge` → `/ai?tab=knowledge`
- `/canned-responses` → `/ai?tab=canned`
- `/tenants` → `/settings/widget`

- [ ] **Step 2: Verify role-based access**

Test with different roles if possible:
- Agent should see: Inbox, AI & Content (read), Analytics (cards only), Settings (account only)
- Admin should see: all items including Widget & Brand and Integrations in Settings
- Super Admin should see: all items + Super Admin section

- [ ] **Step 3: Final commit**

If any remaining fixes were needed:
```bash
git add -A
git commit -m "chore: finalize navigation restructure

All 5 navigation groups working: Inbox, AI & Content,
Analytics, Team, Settings. Old routes redirect correctly."
```
