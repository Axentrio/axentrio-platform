/**
 * ChatStream Component
 * Live chat feed with filtering and quick actions
 */

import React, { useEffect, useState } from 'react';
import { Search, MessageSquare, Clock, User } from 'lucide-react';
import { useChatsQuery } from '../queries/useChatQueries';
import { ChatStatusBadge } from './StatusBadge';
import { TenantSelector } from './TenantSelector';
import { useDebounce } from '@hooks/useDebounce';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectTrigger,
  SelectContent,
  SelectItem,
  SelectValue,
} from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { Chat, ChatStatus, Tenant } from '@app-types/index';

interface ChatStreamProps {
  tenants: Tenant[];
  onChatSelect: (chat: Chat) => void;
  onTakeover: (chatId: string) => void;
  selectedChatId?: string;
  className?: string;
  initialStatusFilter?: ChatStatus | 'all';
}

const statusFilters: { value: ChatStatus | 'all'; label: string }[] = [
  { value: 'all', label: 'All Status' },
  { value: 'bot', label: 'Bot' },
  { value: 'handsoff', label: 'Handoff' },
  { value: 'human', label: 'Human' },
  { value: 'closed', label: 'Closed' },
];

export const ChatStream: React.FC<ChatStreamProps> = ({
  tenants,
  onChatSelect,
  onTakeover,
  selectedChatId,
  className = '',
  initialStatusFilter = 'all',
}) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<ChatStatus | 'all'>(initialStatusFilter);
  const [tenantFilter, setTenantFilter] = useState<string | undefined>();

  useEffect(() => {
    if (initialStatusFilter) {
      setStatusFilter(initialStatusFilter);
    }
  }, [initialStatusFilter]);

  const debouncedSearch = useDebounce(searchQuery, 300);

  const { chats: allChats, isLoading, error, refetch: refresh } = useChatsQuery({
    filters: {
      status: statusFilter === 'all' ? undefined : statusFilter,
      tenantId: tenantFilter,
      search: debouncedSearch || undefined,
    },
  });

  // Hide sessions with no messages
  const chats = allChats.filter((c: any) => c.messageCount > 0 || c.lastMessage);

  const formatTime = (dateString?: string) => {
    if (!dateString) return '';
    const date = new Date(dateString);
    const now = new Date();
    const diff = now.getTime() - date.getTime();

    // Less than 1 hour
    if (diff < 3600000) {
      const minutes = Math.floor(diff / 60000);
      return minutes < 1 ? 'Just now' : `${minutes}m ago`;
    }

    // Less than 24 hours
    if (diff < 86400000) {
      const hours = Math.floor(diff / 3600000);
      return `${hours}h ago`;
    }

    return date.toLocaleDateString();
  };

  const getLastMessage = (chat: any) => {
    // Use lastMessage from enriched API response
    if (chat.lastMessage) {
      return chat.lastMessage.length > 60 ? chat.lastMessage.substring(0, 60) + '...' : chat.lastMessage;
    }
    if (chat.messages && chat.messages.length > 0) {
      const lastMsg = chat.messages[chat.messages.length - 1];
      return lastMsg.content.substring(0, 60) + (lastMsg.content.length > 60 ? '...' : '');
    }
    return '';
  };

  return (
    <div className={cn('flex flex-col h-full bg-surface-2 rounded-2xl shadow-card overflow-hidden border border-edge', className)}>
      {/* Header */}
      <div className="px-4 py-3 border-b border-edge">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-lg font-semibold text-text-primary flex items-center gap-2">
            <MessageSquare className="w-5 h-5" />
            Live Chats
          </h2>
          <span className="text-sm text-text-muted">
            {chats.length} active
          </span>
        </div>

        {/* Filters */}
        <div className="space-y-2">
          {/* Search */}
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-text-muted z-10" />
            <Input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search chats..."
              className="pl-9 bg-surface-3 border-edge rounded-xl text-text-primary placeholder:text-text-muted focus-visible:border-primary-500 focus-visible:ring-primary-500/30"
            />
          </div>

          {/* Status and Tenant filters */}
          <div className="flex gap-2">
            {initialStatusFilter === 'all' && (
              <Select
                value={statusFilter}
                onValueChange={(value) => setStatusFilter(value as ChatStatus | 'all')}
              >
                <SelectTrigger className="flex-1 bg-surface-3 border-edge rounded-xl text-sm text-text-primary focus:border-primary-500 focus:ring-primary-500/30">
                  <SelectValue placeholder="All Status" />
                </SelectTrigger>
                <SelectContent>
                  {statusFilters.map((filter) => (
                    <SelectItem key={filter.value} value={filter.value}>
                      {filter.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}

            <TenantSelector
              tenants={tenants}
              selectedTenantId={tenantFilter}
              onSelect={setTenantFilter}
              placeholder="All Tenants"
              showAllOption
              className="flex-1"
            />
          </div>
        </div>
      </div>

      {/* Chat list */}
      <div className="flex-1 overflow-y-auto">
        {isLoading && chats.length === 0 ? (
          <div className="flex items-center justify-center h-32">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-600" />
          </div>
        ) : error ? (
          <div className="flex flex-col items-center justify-center h-32 text-text-secondary">
            <p>Error loading chats</p>
            <button
              onClick={refresh}
              className="mt-2 text-primary-400 hover:text-primary-300 text-sm"
            >
              Retry
            </button>
          </div>
        ) : chats.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-text-muted">
            <MessageSquare className="w-8 h-8 mb-2 opacity-40" />
            <p className="text-sm">No conversations yet</p>
            <p className="text-xs mt-1 text-text-muted/70">Chats will appear here when visitors start chatting</p>
          </div>
        ) : (
          chats.map((chat) => (
            <div
              key={chat.id}
              onClick={() => onChatSelect(chat)}
              className={cn(
                'px-4 py-3 border-b border-edge/50 cursor-pointer transition-colors hover:bg-surface-3',
                selectedChatId === chat.id
                  ? 'bg-primary-600/10 border-l-4 border-l-primary-500'
                  : 'border-l-4 border-l-transparent'
              )}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="flex-1 min-w-0">
                  {/* User info */}
                  <div className="flex items-center gap-2 mb-1">
                    <span className="font-medium text-text-primary truncate">
                      {chat.userName || 'Anonymous'}
                    </span>
                    <ChatStatusBadge status={chat.status} size="sm" showLabel={true} />
                  </div>

                  {/* Last message */}
                  <p className="text-sm text-text-secondary truncate">
                    {getLastMessage(chat) || ''}
                  </p>

                  {/* Meta info */}
                  <div className="flex items-center gap-3 mt-2 text-xs text-text-muted">
                    <span className="flex items-center gap-1">
                      <Clock className="w-3 h-3" />
                      {formatTime(chat.lastMessageAt || chat.lastActivityAt)}
                    </span>
                    {(chat as any).messageCount > 0 && (
                      <span className="flex items-center gap-1">
                        <MessageSquare className="w-3 h-3" />
                        {(chat as any).messageCount}
                      </span>
                    )}
                    {chat.tenantName && (
                      <span>{chat.tenantName}</span>
                    )}
                    {chat.assignedAgentName && (
                      <span className="flex items-center gap-1">
                        <User className="w-3 h-3" />
                        {chat.assignedAgentName}
                      </span>
                    )}
                  </div>
                </div>

                {/* Takeover button for handoff chats */}
                {chat.status === 'handsoff' && (
                  <Button
                    size="sm"
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      onTakeover(chat.id);
                    }}
                    className="bg-primary-600 text-white text-xs font-medium rounded-xl hover:bg-primary-500 hover:shadow-glow-sm flex-shrink-0"
                  >
                    Takeover
                  </Button>
                )}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
};

export default ChatStream;
