# Navigation & IA Restructure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Consolidate the portal sidebar from 9 items to 5 intent-based groups (Inbox, AI & Content, Analytics, Team, Settings), eliminating disconnected workflows and duplicate views.

**Architecture:** This is a layout/routing restructure that reuses all existing components and hooks. No backend changes. Each phase creates a new wrapper page that composes existing components, updates routes in App.tsx, and adds redirects for old URLs. The sidebar is updated last once all new pages are in place.

**Tech Stack:** React 18, React Router v6, TypeScript, Tailwind CSS, Radix UI (via shadcn/ui), TanStack Query, Zustand, Clerk auth

**Spec:** `docs/superpowers/specs/2026-03-29-navigation-restructure-design.md`

**Codex Review:** Plan cross-checked against actual codebase. Import paths, component props, type shapes, and task ordering verified.

---

## Verified Import Paths (reference for all tasks)

These are the actual import paths confirmed from the existing codebase:

| What | Correct Import Path |
|------|-------------------|
| API client | `@services/apiClient` (NOT `@/lib/api`) |
| Tenant hooks | `../queries/useTenantQueries` or `@/queries/useTenantQueries` |
| AI/Knowledge hooks | `@/queries/useKnowledgeQueries` (NOT `useAiQueries` — all AI hooks live here) |
| Canned response hooks + type | `../queries/useCannedResponseQueries` (CannedResponse type is here, NOT in `@app-types/index`) |
| Handoff hooks | `../queries/useHandoffQueries` |
| Agent query options | `../queries/useAgentQueries` |
| Chat hooks | `../queries/useChatQueries` |
| Analytics hooks | `../queries/useAnalyticsQueries` |
| Dashboard hooks | `../queries/useDashboardQueries` |
| Notification sound | `@websocket/notificationSound` (NOT `@/hooks/useNotificationSound`) |
| Socket context | `@websocket/SocketContext` |
| Chat/HandoffRequest types | `@app-types/index` |

---

## Verified Component Props (reference for all tasks)

| Component | Actual Props |
|-----------|-------------|
| `ChatStream` | `tenants`, `onChatSelect`, `onTakeover`, `selectedChatId?`, `className?` — **NO `filter` prop**. Has its own internal status filter UI. |
| `ChatWindow` | `chat`, `onClose?`, `onTransfer?(chatId: string)`, `className?` |
| `DocumentsTab` | `initialFilter?`, `onFilterChange?`, `showAiBanner?`, `onConfigureAi?` — **NOT `filter` or `onAddDocument`**. Owns its own add-document modal. |
| `AiSettingsTab` | No props (self-contained) |
| `TestChatPanel` | `isOpen`, `onClose`, `botName`, `provider`, `model`, `hasIndexedDocs` — **`isOpen` is required** and it renders its own backdrop. |
| `AddDocumentModal` | `isOpen`, `onClose`, `editingDocument?` |
| RawAgent shape | `maxConcurrentChats` (NOT `maxChats`), maps to Agent.`maxConcurrentChats` |

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
portal/src/App.tsx                                  — Route definitions, redirects, hoist SocketProvider
portal/src/components/Sidebar.tsx                   — Menu items (9 → 5), add handoff query
portal/src/pages/Analytics.tsx                      — Add Dashboard metric cards + agent role guard
portal/src/pages/settings/SettingsLayout.tsx         — Add Widget & Brand nav item
portal/src/components/ChatStream.tsx                — Accept optional initialStatusFilter prop
portal/src/pages/CannedResponses.tsx                — Extract CannedResponsesContent named export
```

### Files retired (kept but no longer routed to)
```
portal/src/pages/Dashboard.tsx          — Metrics merged into Analytics
portal/src/pages/LiveMonitor.tsx        — Merged into Inbox
portal/src/pages/Queue.tsx              — Merged into Inbox
portal/src/pages/ChatTakeover.tsx       — Merged into Inbox (right panel)
portal/src/pages/KnowledgeBase.tsx      — Merged into AiContent
portal/src/pages/Tenants.tsx            — Split into Settings > Widget & Brand + Integrations
```

---

## Task 1: Add initialStatusFilter prop to ChatStream

**Files:**
- Modify: `portal/src/components/ChatStream.tsx`

ChatStream already has its own internal status filter UI (dropdown with `'all' | 'bot' | 'handsoff' | 'human' | 'closed'`). We need to let the Inbox page set the initial filter value so the tabs drive it.

- [ ] **Step 1: Read ChatStream.tsx**

Read `portal/src/components/ChatStream.tsx` to find the exact state variable for the status filter and its initialization.

- [ ] **Step 2: Add initialStatusFilter prop**

Add to the `ChatStreamProps` interface:
```tsx
interface ChatStreamProps {
  tenants: Tenant[];
  onChatSelect: (chat: Chat) => void;
  onTakeover: (chatId: string) => void;
  selectedChatId?: string;
  className?: string;
  initialStatusFilter?: 'all' | 'bot' | 'handsoff' | 'human' | 'closed';  // NEW
}
```

In the component destructuring, accept it:
```tsx
const ChatStream: React.FC<ChatStreamProps> = ({
  tenants,
  onChatSelect,
  onTakeover,
  selectedChatId,
  className,
  initialStatusFilter = 'all',  // NEW — default to 'all'
}) => {
```

Find the internal status filter state (likely `useState<string>('all')`) and change the default:
```tsx
const [statusFilter, setStatusFilter] = useState(initialStatusFilter);
```

Also add a `useEffect` to sync when the prop changes:
```tsx
React.useEffect(() => {
  setStatusFilter(initialStatusFilter);
}, [initialStatusFilter]);
```

When `initialStatusFilter` is provided from Inbox, optionally hide the internal filter dropdown to avoid duplication. Add a prop `hideStatusFilter?: boolean` or simply check if the prop was passed:
```tsx
{!initialStatusFilter || initialStatusFilter === 'all' ? (
  // render internal status filter dropdown
) : null}
```

- [ ] **Step 3: Verify compilation**

Run: `cd chatbot-platform && npx tsc --noEmit 2>&1 | head -30`

- [ ] **Step 4: Commit**

```bash
git add portal/src/components/ChatStream.tsx
git commit -m "feat: add initialStatusFilter prop to ChatStream

Allows parent components to set the initial status filter
and optionally hide the internal filter dropdown."
```

---

## Task 2: Create the Inbox page

**Files:**
- Create: `portal/src/pages/Inbox.tsx`

This merges Live Monitor, Queue, and Chat Takeover into a single split-pane workspace with filter tabs. Uses `ChatStream` with the new `initialStatusFilter` prop.

**Important:** Chat statuses are `'bot' | 'handsoff' | 'human'` (not `'agent'` or `'handoff'`). The Inbox tab labels use friendly names but map to these actual status values.

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
import { useHandoffsQuery, useAcceptHandoff, useRejectHandoff } from '../queries/useHandoffQueries';
import { useNotificationSound } from '@websocket/notificationSound';
import { agentOptions } from '../queries/useAgentQueries';
import api from '@services/apiClient';

import type { Chat, HandoffRequest } from '@app-types/index';

type InboxTab = 'all' | 'bot' | 'handoff' | 'human';
type HandoffPriority = 'urgent' | 'high' | 'medium' | 'low';

// Maps Inbox tabs to ChatStream status filter values
const tabToStatusFilter: Record<InboxTab, 'all' | 'bot' | 'handsoff' | 'human'> = {
  all: 'all',
  bot: 'bot',
  handoff: 'handsoff',  // Inbox shows "Handoff" tab, but the status value is 'handsoff'
  human: 'human',
};

interface RawAgent {
  id: string;
  name: string;
  status: string;
  currentChatCount: number;
  maxConcurrentChats: number;
  skills?: string[];
}

interface MappedAgent {
  id: string;
  firstName: string;
  lastName: string;
  status: string;
  currentChatCount: number;
  maxConcurrentChats: number;
  skills: string[];
}

function mapRawAgent(raw: RawAgent): MappedAgent {
  const parts = raw.name?.split(' ') || ['Unknown'];
  return {
    id: raw.id,
    firstName: parts[0] || '',
    lastName: parts.slice(1).join(' ') || '',
    status: raw.status,
    currentChatCount: raw.currentChatCount,
    maxConcurrentChats: raw.maxConcurrentChats ?? 5,
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
  const initialTab = (searchParams.get('filter') as InboxTab) || 'all';
  const initialChatId = searchParams.get('chat') || null;

  const [activeTab, setActiveTab] = useState<InboxTab>(initialTab);
  const [selectedChat, setSelectedChat] = useState<Chat | null>(null);
  const [selectedChatId, setSelectedChatId] = useState<string | null>(initialChatId);
  const [isTransferModalOpen, setIsTransferModalOpen] = useState(false);
  const [filterPriority, setFilterPriority] = useState<HandoffPriority | 'all'>('all');
  const [isMobileChatOpen, setIsMobileChatOpen] = useState(false);

  // Data hooks
  const { data: tenant } = useTenantSettings();
  const tenants = tenant ? [tenant] : [];
  const { handoffs, pendingCount, isLoading: handoffsLoading } = useHandoffsQuery('pending');
  const acceptMutation = useAcceptHandoff();
  const rejectMutation = useRejectHandoff();
  useNotificationSound();

  // Transfer modal agents
  const { data: rawAgents } = useQuery({
    ...agentOptions.list({ status: 'online' }),
    enabled: isTransferModalOpen,
  });
  const agents: MappedAgent[] = ((rawAgents as RawAgent[] | undefined) ?? []).map(mapRawAgent);

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

  const handleTabChange = (tab: string) => {
    const t = tab as InboxTab;
    setActiveTab(t);
    setSearchParams(t === 'all' ? {} : { filter: t });
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
    setSearchParams(activeTab === 'all' ? {} : { filter: activeTab });
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
            <Tabs value={activeTab} onValueChange={handleTabChange}>
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
                <TabsTrigger value="human" className="flex-1">
                  <UserCheck className="w-4 h-4 mr-1" />
                  Agent
                </TabsTrigger>
              </TabsList>
            </Tabs>

            {/* Priority filter for handoff tab */}
            {activeTab === 'handoff' && (
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
            {activeTab === 'handoff' ? (
              /* Handoff list — renders handoff cards with accept/decline */
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
              /* Chat list via ChatStream — uses initialStatusFilter to sync with tab */
              <ChatStream
                tenants={tenants}
                onChatSelect={handleChatSelect}
                onTakeover={handleTakeover}
                selectedChatId={selectedChatId ?? undefined}
                className="h-full"
                initialStatusFilter={tabToStatusFilter[activeTab]}
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
                    {agent.currentChatCount}/{agent.maxConcurrentChats} chats
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

Fix any remaining import path issues by checking the actual imports in LiveMonitor.tsx, Queue.tsx, and ChatTakeover.tsx.

- [ ] **Step 3: Commit**

```bash
git add portal/src/pages/Inbox.tsx
git commit -m "feat: create unified Inbox page

Merges Live Monitor, Queue, and Chat Takeover into a single
split-pane workspace with filter tabs (All/Bot/Handoff/Agent)."
```

---

## Task 3: Create the AI & Content page

**Files:**
- Create: `portal/src/pages/AiContent.tsx`
- Modify: `portal/src/pages/CannedResponses.tsx`

Merges Knowledge Base and Canned Responses into a single tabbed page, promoting AI Settings to a first-class tab.

**Key corrections from Codex review:**
- `DocumentsTab` accepts `initialFilter`, NOT `filter`. It owns its own add-document modal.
- `TestChatPanel` requires `isOpen` prop and renders its own backdrop — don't wrap it in another overlay.
- AI hooks come from `@/queries/useKnowledgeQueries`, NOT `useAiQueries`.

- [ ] **Step 1: Extract CannedResponsesContent from CannedResponses page**

Read `portal/src/pages/CannedResponses.tsx`. Refactor so all the hooks, state, handlers, and JSX (minus the outer page wrapper and h1 header) live in a named export `CannedResponsesContent`. The default export wraps it with the page header for backward compat:

```tsx
export const CannedResponsesContent: React.FC = () => {
  // ... all current hooks, state, handlers, and JSX from CannedResponses
  // MINUS the outer <div className="p-6 space-y-6"> and <h1> header
  // Include the filter controls, table, create/edit dialog, and delete dialog
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

- [ ] **Step 2: Create the AiContent page file**

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

import { useAppAuth } from '@auth/useAppAuth';
import { useKnowledgeStats, useGetAiSettings } from '@/queries/useKnowledgeQueries';

import { CannedResponsesContent } from '@/pages/CannedResponses';

type AiContentTab = 'knowledge' | 'canned' | 'settings';

const AiContent: React.FC = () => {
  const [searchParams, setSearchParams] = useSearchParams();
  const initialTab = (searchParams.get('tab') as AiContentTab) || 'knowledge';

  const [activeTab, setActiveTab] = useState<AiContentTab>(initialTab);
  const [isTestChatOpen, setIsTestChatOpen] = useState(false);
  const [docFilter, setDocFilter] = useState<string | undefined>();

  const { isRole } = useAppAuth();
  const isAdmin = isRole('admin') || isRole('super_admin');
  const isSupervisorOrAbove = isAdmin || isRole('supervisor');

  const { data: stats } = useKnowledgeStats() as { data: any };
  const { data: aiSettings } = useGetAiSettings() as { data: any };

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
                  onClick={() => stat.filterKey && setDocFilter(docFilter === stat.filterKey ? undefined : stat.filterKey)}
                  className={cn(
                    'px-3 py-1.5 rounded-lg text-sm font-medium transition-colors',
                    docFilter === stat.filterKey
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

            {/* DocumentsTab — uses initialFilter prop, NOT filter */}
            <DocumentsTab
              initialFilter={docFilter}
              onFilterChange={setDocFilter}
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

      {/* Test Chat Panel — it renders its own backdrop/panel, just pass isOpen */}
      <TestChatPanel
        isOpen={isTestChatOpen}
        onClose={() => setIsTestChatOpen(false)}
        botName={aiSettings?.brandVoice?.name || 'AI Bot'}
        provider={aiSettings?.provider}
        model={aiSettings?.model}
        hasIndexedDocs={hasIndexedDocs}
      />
    </div>
  );
};

export default AiContent;
```

- [ ] **Step 3: Verify imports compile**

Run: `cd chatbot-platform && npx tsc --noEmit 2>&1 | head -30`

- [ ] **Step 4: Commit**

```bash
git add portal/src/pages/AiContent.tsx portal/src/pages/CannedResponses.tsx
git commit -m "feat: create AI & Content page

Merges Knowledge Base, Canned Responses, and AI Settings into
a single tabbed page. Extracts CannedResponsesContent for reuse."
```

---

## Task 4: Merge Dashboard metrics into Analytics + agent role guard

**Files:**
- Modify: `portal/src/pages/Analytics.tsx`

**Important (from Codex review):** `useHandoffsQuery()` calls `useSocket()` internally, so Analytics must be wrapped in SocketProvider before this hook is used. Since this task runs before the route change (Task 6), we must either:
1. Move the route change first, OR
2. Avoid `useHandoffsQuery()` and use a simple REST query for the count instead.

**Chosen approach:** Use `useDashboardMetrics()` only (which does NOT require SocketProvider). The pending handoff count is already available in the dashboard response as `dashboard.sessions.handoff`. Skip `useHandoffsQuery()` entirely for the Analytics page — it's unnecessary.

Also add role-based rendering: agents see metric cards only, supervisors+ see full charts.

- [ ] **Step 1: Read current Analytics.tsx**

Read `portal/src/pages/Analytics.tsx` to get exact imports, state, and JSX structure.

- [ ] **Step 2: Add Dashboard metrics and role guard**

Add imports:
```tsx
import { useDashboardMetrics } from '../queries/useDashboardQueries';
import { useNavigate } from 'react-router-dom';
import { Headphones, TrendingUp } from 'lucide-react';
import { useAppAuth } from '@auth/useAppAuth';
```

Add to component body:
```tsx
const navigate = useNavigate();
const { user } = useAppAuth();
const isAgent = user?.role === 'agent';
const { data: rawDashboard } = useDashboardMetrics();
const dashboard = rawDashboard?.dashboard;
```

Replace the existing 4-item `stats` array with 6 items:
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
    value: dashboard?.sessions.handoff ?? 0,
    icon: Headphones,
    color: 'text-accent-400',
    bgColor: 'bg-accent-500/10',
    alert: (dashboard?.sessions.handoff ?? 0) > 3,
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
    value: dashboard ? `${dashboard.avgResponseTimeSeconds}s` : '--',
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

Update stats grid:
```tsx
<div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
```

Add click handling to cards:
```tsx
<Card
  key={index}
  variant="glass"
  hover
  className={cn(stat.onClick && 'cursor-pointer')}
  onClick={stat.onClick}
>
```

After the stats grid, conditionally render charts only for non-agents:
```tsx
{isAgent ? (
  <div className="text-center py-12">
    <p className="text-text-secondary">
      <Button variant="link" onClick={() => navigate('/inbox')}>Go to Inbox</Button>
      to manage conversations
    </p>
  </div>
) : (
  /* existing Tabs with Overview/Agents/Chats */
)}
```

- [ ] **Step 3: Verify compilation**

Run: `cd chatbot-platform && npx tsc --noEmit 2>&1 | head -30`

- [ ] **Step 4: Commit**

```bash
git add portal/src/pages/Analytics.tsx
git commit -m "feat: merge Dashboard metrics into Analytics + agent role guard

Adds 6 real-time metric cards. Agents see cards only with link
to Inbox. Supervisors+ see full charts and tables."
```

---

## Task 5: Add Widget & Brand settings page

**Files:**
- Create: `portal/src/pages/settings/WidgetBrandSettings.tsx`
- Modify: `portal/src/pages/settings/SettingsLayout.tsx`

**Key corrections from Codex review:**
- Color lives at `settings.theme.primaryColor`, NOT `settings.primaryColor`
- Save payload uses `settings: { theme: { primaryColor } }` (nested)
- Session fields are `currentAgents`/`maxAgents` on the mapped Tenant (mapped from API's `currentSessions`/`maxSessions`)

- [ ] **Step 1: Create WidgetBrandSettings page**

Read `portal/src/pages/Tenants.tsx` lines 23-105 first for the exact data shape.

Create `portal/src/pages/settings/WidgetBrandSettings.tsx`:

```tsx
/**
 * Widget & Brand Settings
 * Manages tenant branding (logo, colors, name) and session stats.
 * Extracted from Tenants page for Settings integration.
 */

import React, { useState, useRef } from 'react';
import {
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
  const [editingName, setEditingName] = useState<string | null>(null);
  const logoInputRef = useRef<HTMLInputElement>(null);

  // Map the raw API tenant data the same way Tenants.tsx does
  // Read mapApiToTenant in Tenants.tsx for the exact shape
  const tenant = rawTenant as any;
  // primaryColor lives at settings.theme.primaryColor on the raw data,
  // or at tenant.primaryColor on the mapped Tenant shape
  const primaryColor = tenant?.primaryColor || tenant?.settings?.theme?.primaryColor || '#6366f1';

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
      // Must use nested settings.theme.primaryColor structure
      await updateMutation.mutateAsync({
        settings: { theme: { primaryColor: color } },
      });
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

  return (
    <div className="space-y-6">
      {/* Branding */}
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

          <div>
            <Label className="text-sm text-text-secondary mb-2 block">Brand Color</Label>
            <div className="flex flex-wrap gap-2">
              {colorPresets.map((color, i) => (
                <button
                  key={`${color}-${i}`}
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

      {/* Usage */}
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
                {tenant?.currentAgents ?? 0} / {tenant?.maxAgents ?? '∞'}
              </p>
            </div>
            <Badge variant={tenant?.isActive ? 'default' : 'secondary'}>
              {tenant?.isActive ? 'Active' : 'Inactive'}
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

Read `portal/src/pages/settings/SettingsLayout.tsx`. Add the import and nav entry:

```tsx
import { Palette } from 'lucide-react';
```

Add to `settingsNav` array in the Workspace group before Integrations:
```tsx
{ path: '/settings/widget', label: 'Widget & Brand', icon: Palette, group: 'Workspace' },
```

Add role-based filtering to hide Workspace items from agents. Read the current code to see if `useAppAuth()` is already imported. If not, add:
```tsx
import { useAppAuth } from '@auth/useAppAuth';
```

In the component, filter nav items:
```tsx
const { user } = useAppAuth();
const isAdminOrAbove = user && ['admin', 'super_admin'].includes(user.role);

// Filter nav items by role
const visibleNav = settingsNav.filter((item) => {
  if (item.group === 'Workspace' && !isAdminOrAbove) return false;
  return true;
});
```

Then use `visibleNav` instead of `settingsNav` for rendering.

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

## Task 6: Update routes, hoist SocketProvider, and add redirects in App.tsx

**Files:**
- Modify: `portal/src/App.tsx`

**Critical (from Codex review):** `useHandoffsQuery()` in the Inbox and Sidebar requires `useSocket()` from SocketProvider. Currently SocketProvider is route-level (inside each page route). We need to hoist it above `AuthenticatedLayout` so the Sidebar can access socket context for the handoff badge count.

- [ ] **Step 1: Read current App.tsx**

Read `portal/src/App.tsx` to get the exact structure.

- [ ] **Step 2: Add new page imports and redirect components**

Add to imports:
```tsx
import Inbox from './pages/Inbox';
import AiContent from './pages/AiContent';
import WidgetBrandSettings from './pages/settings/WidgetBrandSettings';
```

Add redirect helper components above the main App component:
```tsx
const TakeoverRedirect: React.FC = () => {
  const { chatId } = useParams<{ chatId: string }>();
  return <Navigate to={`/inbox?chat=${chatId}`} replace />;
};

const DefaultRedirect: React.FC = () => {
  const { user } = useAppAuth();
  if (user?.role === 'agent') {
    return <Navigate to="/inbox" replace />;
  }
  return <Navigate to="/analytics" replace />;
};
```

- [ ] **Step 3: Hoist SocketProvider above AuthenticatedLayout**

In the route tree, wrap `AuthenticatedLayout` in `SocketProvider` so all child routes and the Sidebar can access socket context:

```tsx
<Route element={
  <OrganizationRequired>
    <SocketProvider>
      <AuthenticatedLayout>
        <Outlet />
      </AuthenticatedLayout>
    </SocketProvider>
  </OrganizationRequired>
}>
  {/* All child routes go here — no individual SocketProvider wrappers needed */}
</Route>
```

Remove the per-route `<SocketProvider>` wrappers from Dashboard, LiveMonitor, ChatTakeover, and Queue routes since the provider is now at the layout level.

- [ ] **Step 4: Replace route definitions**

```tsx
{/* === NEW ROUTES === */}
<Route path="/inbox" element={<ProtectedRoute><Inbox /></ProtectedRoute>} />
<Route path="/ai" element={<ProtectedRoute><AiContent /></ProtectedRoute>} />
<Route path="/analytics" element={<ProtectedRoute><Analytics /></ProtectedRoute>} />
<Route path="/team" element={<SupervisorRoute><Team /></SupervisorRoute>} />
<Route path="/settings" element={<ProtectedRoute><SettingsLayout /></ProtectedRoute>}>
  <Route index element={<Navigate to="/settings/profile" replace />} />
  <Route path="profile" element={<ProfileSettings />} />
  <Route path="notifications" element={<NotificationSettings />} />
  <Route path="appearance" element={<AppearanceSettings />} />
  <Route path="widget" element={<AdminRoute><WidgetBrandSettings /></AdminRoute>} />
  <Route path="integrations" element={<IntegrationSettings />} />
</Route>

{/* === REDIRECTS === */}
<Route path="/" element={<DefaultRedirect />} />
<Route path="/monitor" element={<Navigate to="/inbox" replace />} />
<Route path="/queue" element={<Navigate to="/inbox?filter=handoff" replace />} />
<Route path="/takeover/:chatId" element={<TakeoverRedirect />} />
<Route path="/knowledge" element={<Navigate to="/ai?tab=knowledge" replace />} />
<Route path="/canned-responses" element={<Navigate to="/ai?tab=canned" replace />} />
<Route path="/tenants" element={<Navigate to="/settings/widget" replace />} />

{/* Super Admin — unchanged */}
<Route path="/admin/tenants" element={<SuperAdminRoute><AdminTenants /></SuperAdminRoute>} />
<Route path="/admin/tenants/:id" element={<SuperAdminRoute><AdminTenantDetail /></SuperAdminRoute>} />
<Route path="/admin/users" element={<SuperAdminRoute><AdminUsers /></SuperAdminRoute>} />
<Route path="/admin/analytics" element={<SuperAdminRoute><AdminAnalytics /></SuperAdminRoute>} />

<Route path="*" element={<Navigate to="/inbox" replace />} />
```

- [ ] **Step 5: Remove old page imports**

```tsx
// Remove:
import Dashboard from './pages/Dashboard';
import LiveMonitor from './pages/LiveMonitor';
import Queue from './pages/Queue';
import ChatTakeover from './pages/ChatTakeover';
import KnowledgeBase from './pages/KnowledgeBase';
import CannedResponses from './pages/CannedResponses';
import Tenants from './pages/Tenants';
```

- [ ] **Step 6: Verify compilation**

Run: `cd chatbot-platform && npx tsc --noEmit 2>&1 | head -30`

- [ ] **Step 7: Commit**

```bash
git add portal/src/App.tsx
git commit -m "feat: update routes, hoist SocketProvider, add redirects

Wires Inbox, AI & Content, Widget & Brand pages. Hoists
SocketProvider above layout so Sidebar can access handoff count.
Adds redirects for all old routes."
```

---

## Task 7: Update the Sidebar with handoff badge

**Files:**
- Modify: `portal/src/components/Sidebar.tsx`

Now that SocketProvider is hoisted (Task 6), the Sidebar can use `useHandoffsQuery()` directly to get a real-time pending count.

- [ ] **Step 1: Read current Sidebar.tsx**

Read `portal/src/components/Sidebar.tsx`.

- [ ] **Step 2: Add handoff query import and remove pendingHandoffs prop**

The current Sidebar accepts `pendingHandoffs` as a prop (defaulting to 0) but it's never actually passed from App.tsx. Replace this with a direct query:

Add import:
```tsx
import { useHandoffsQuery } from '../queries/useHandoffQueries';
```

In the component, remove `pendingHandoffs` from props and add:
```tsx
const { pendingCount } = useHandoffsQuery('pending');
```

Update the SidebarProps interface to remove `pendingHandoffs`:
```tsx
interface SidebarProps {
  className?: string;
}
```

- [ ] **Step 3: Update the menuItems array**

Replace the `menuItems` array with:
```tsx
const menuItems: MenuItem[] = [
  { path: '/inbox', label: 'Inbox', icon: MessageSquare, roles: ['super_admin', 'admin', 'supervisor', 'agent'] },
  { path: '/ai', label: 'AI & Content', icon: BookOpen, roles: ['super_admin', 'admin', 'supervisor', 'agent'] },
  { path: '/analytics', label: 'Analytics', icon: BarChart3, roles: ['super_admin', 'admin', 'supervisor', 'agent'] },
  { path: '/team', label: 'Team', icon: Users, roles: ['super_admin', 'admin', 'supervisor'] },
  { path: '/settings', label: 'Settings', icon: Settings, roles: ['super_admin', 'admin', 'supervisor', 'agent'] },
];
```

- [ ] **Step 4: Update badge rendering**

Change from:
```tsx
{item.path === '/queue' && pendingHandoffs > 0 && (
```
to:
```tsx
{item.path === '/inbox' && pendingCount > 0 && (
```

And update the display:
```tsx
{pendingCount > 99 ? '99+' : pendingCount}
```

- [ ] **Step 5: Clean up unused imports**

Remove:
```tsx
import { LayoutDashboard, Headphones, Zap, Building2 } from 'lucide-react';
```

Keep: `MessageSquare`, `Users`, `BarChart3`, `Settings`, `LogOut`, `BookOpen`, `Shield`, `UserCog`, `TrendingUp`

- [ ] **Step 6: Verify compilation**

Run: `cd chatbot-platform && npx tsc --noEmit 2>&1 | head -30`

- [ ] **Step 7: Commit**

```bash
git add portal/src/components/Sidebar.tsx
git commit -m "feat: consolidate sidebar from 9 items to 5

Updates navigation to intent-based groups:
Inbox, AI & Content, Analytics, Team, Settings.
Uses useHandoffsQuery for real-time badge count."
```

---

## Task 8: Smoke test and fix integration issues

**Files:**
- Potentially modify any of the new files based on what breaks

- [ ] **Step 1: Start the dev server**

Run: `cd chatbot-platform && npm run dev`

Open the portal in the browser. Check each new page:

1. `/inbox` — verify chat list renders, filter tabs work (All/Bot/Handoff/Agent), selecting a chat opens the right panel, accept/decline handoff works
2. `/ai` — verify Knowledge Base tab shows documents (DocumentsTab renders), Canned Responses tab shows table (CannedResponsesContent renders), AI Settings tab shows config form
3. `/analytics` — verify 6 metric cards render, clicking Active Chats navigates to `/inbox`, charts load for supervisor+ roles, agents see cards only
4. `/settings/widget` — verify branding config renders, color picker works, logo upload works
5. Sidebar shows 5 items with correct handoff badge count on Inbox

- [ ] **Step 2: Test all redirects**

Navigate to each old URL and verify:
- `/` → `/inbox` (agent) or `/analytics` (admin)
- `/monitor` → `/inbox`
- `/queue` → `/inbox?filter=handoff`
- `/takeover/some-id` → `/inbox?chat=some-id`
- `/knowledge` → `/ai?tab=knowledge`
- `/canned-responses` → `/ai?tab=canned`
- `/tenants` → `/settings/widget`

- [ ] **Step 3: Fix any issues found**

Common issues to watch for:
- Import path mismatches — check actual paths against the reference table at the top of this plan
- Component prop mismatches — check actual interfaces against the reference table
- SocketProvider context errors — should be resolved by hoisting in Task 6
- ChatStream `initialStatusFilter` not syncing — verify the useEffect in Task 1

- [ ] **Step 4: Fix any TypeScript errors**

Run: `cd chatbot-platform && npx tsc --noEmit`

- [ ] **Step 5: Commit fixes**

```bash
git add -A
git commit -m "fix: resolve integration issues from navigation restructure"
```

---

## Task 9: Final verification and cleanup

- [ ] **Step 1: Verify role-based access**

Test with different roles if possible:
- Agent: Inbox, AI & Content (read), Analytics (cards only), Settings (account only)
- Supervisor: all + Team + full Analytics
- Admin: all + Widget & Brand + Integrations
- Super Admin: all + Super Admin section

- [ ] **Step 2: Verify mobile responsiveness**

Test at < 768px:
- Inbox: list takes full width, selecting chat pushes full-screen view with back button
- AI & Content: tabs stack properly
- Settings: horizontal tabs (not sidebar) on mobile

- [ ] **Step 3: Final commit**

```bash
git add -A
git commit -m "chore: finalize navigation restructure

All 5 navigation groups working: Inbox, AI & Content,
Analytics, Team, Settings. Old routes redirect correctly.
Role-based access verified."
```
