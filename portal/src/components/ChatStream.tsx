/**
 * ChatStream Component
 * Live chat feed with filtering and quick actions
 */

import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Search, MessageSquare, Clock, User, ShieldAlert } from 'lucide-react';
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

const statusFilters: { value: ChatStatus | 'all'; labelKey: string }[] = [
  { value: 'all', labelKey: 'inbox.stream.filters.status.all' },
  { value: 'bot', labelKey: 'inbox.stream.filters.status.bot' },
  { value: 'handsoff', labelKey: 'inbox.stream.filters.status.handsoff' },
  { value: 'human', labelKey: 'inbox.stream.filters.status.human' },
  { value: 'closed', labelKey: 'inbox.stream.filters.status.closed' },
];

/** Last-message preview for a chat row. Pure — hoisted to module scope. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const getLastMessage = (chat: any): string => {
  if (chat.lastMessage) {
    return chat.lastMessage.length > 60 ? chat.lastMessage.substring(0, 60) + '...' : chat.lastMessage;
  }
  if (chat.messages && chat.messages.length > 0) {
    const lastMsg = chat.messages[chat.messages.length - 1];
    return lastMsg.content.substring(0, 60) + (lastMsg.content.length > 60 ? '...' : '');
  }
  return '';
};

export const ChatStream: React.FC<ChatStreamProps> = ({
  tenants,
  onChatSelect,
  onTakeover,
  selectedChatId,
  className = '',
  initialStatusFilter = 'all',
}) => {
  const { t } = useTranslation();
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
      return minutes < 1 ? t('inbox.stream.time.justNow') : t('inbox.stream.time.minutesAgo', { count: minutes });
    }

    // Less than 24 hours
    if (diff < 86400000) {
      const hours = Math.floor(diff / 3600000);
      return t('inbox.stream.time.hoursAgo', { count: hours });
    }

    return date.toLocaleDateString();
  };

  return (
    <div className={cn('flex flex-col h-full bg-surface-2 rounded-2xl shadow-card overflow-hidden border border-edge', className)}>
      {/* Header */}
      <div className="px-4 py-3 border-b border-edge">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-lg font-semibold text-text-primary flex items-center gap-2">
            <MessageSquare className="w-5 h-5" />
            {t('inbox.stream.title')}
          </h2>
          <span className="text-sm text-text-muted">
            {t('inbox.stream.activeCount', { count: chats.length })}
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
              placeholder={t('inbox.stream.searchPlaceholder')}
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
                  <SelectValue placeholder={t('inbox.stream.filters.status.all')} />
                </SelectTrigger>
                <SelectContent>
                  {statusFilters.map((filter) => (
                    <SelectItem key={filter.value} value={filter.value}>
                      {t(filter.labelKey)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}

            <TenantSelector
              tenants={tenants}
              selectedTenantId={tenantFilter}
              onSelect={setTenantFilter}
              placeholder={t('inbox.stream.filters.allTenants')}
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
            <p>{t('inbox.stream.errorLoading')}</p>
            <button
              type="button"
              onClick={refresh}
              className="mt-2 text-primary-400 hover:text-primary-300 text-sm"
            >
              {t('inbox.stream.retry')}
            </button>
          </div>
        ) : chats.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-text-muted">
            <MessageSquare className="w-8 h-8 mb-2 opacity-40" />
            <p className="text-sm">{t('inbox.stream.empty.title')}</p>
            <p className="text-xs mt-1 text-text-muted/70">{t('inbox.stream.empty.subtitle')}</p>
          </div>
        ) : (
          chats.map((chat) => (
            <div
              key={chat.id}
              role="button"
              tabIndex={0}
              onClick={() => onChatSelect(chat)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onChatSelect(chat);
                }
              }}
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
                      {chat.userName || t('inbox.chat.anonymous')}
                    </span>
                    <ChatStatusBadge status={chat.status} size="sm" showLabel={true} />
                    {chat.aiAutoReplyEnabled === false && (
                      <span
                        className="inline-flex items-center gap-1 rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-600"
                        title={t('inbox.guardrail.pausedTooltip')}
                      >
                        <ShieldAlert className="w-3 h-3" />
                        {t('inbox.guardrail.pausedShort')}
                      </span>
                    )}
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
                    {t('inbox.takeover.button')}
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

