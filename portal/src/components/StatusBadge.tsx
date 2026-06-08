/**
 * StatusBadge Component
 * Displays status indicators for chats, agents, and handoffs
 */

import React from 'react';
import { useTranslation } from 'react-i18next';
import { CHAT_STATUS_COLORS, USER_STATUS_COLORS, PRIORITY_COLORS } from '@config/api.config';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import type { ChatStatus, UserStatus, HandoffPriority } from '@app-types/index';

interface StatusBadgeProps {
  status: ChatStatus | UserStatus | HandoffPriority;
  type: 'chat' | 'user' | 'priority';
  size?: 'sm' | 'md' | 'lg';
  showLabel?: boolean;
  className?: string;
}

const statusLabelKeys: Record<string, string> = {
  // Chat statuses
  bot: 'inbox.statusBadge.bot',
  human: 'inbox.statusBadge.human',
  handsoff: 'inbox.statusBadge.handsoff',
  closed: 'inbox.statusBadge.closed',
  pending: 'inbox.statusBadge.pending',
  // User statuses
  online: 'inbox.userStatusBadge.online',
  away: 'inbox.userStatusBadge.away',
  offline: 'inbox.userStatusBadge.offline',
  busy: 'inbox.userStatusBadge.busy',
  // Priorities
  low: 'inbox.priorityBadge.low',
  medium: 'inbox.priorityBadge.medium',
  high: 'inbox.priorityBadge.high',
  urgent: 'inbox.priorityBadge.urgent',
};

const StatusBadge: React.FC<StatusBadgeProps> = ({
  status,
  type,
  size = 'md',
  showLabel = true,
  className = '',
}) => {
  const { t } = useTranslation();
  const getLabel = (s: string) => {
    const key = statusLabelKeys[s];
    return key ? t(key) : s;
  };
  const getColorClass = () => {
    switch (type) {
      case 'chat':
        return CHAT_STATUS_COLORS[status as ChatStatus] || 'bg-text-muted';
      case 'user':
        return USER_STATUS_COLORS[status as UserStatus] || 'bg-text-muted';
      case 'priority':
        return PRIORITY_COLORS[status as HandoffPriority] || 'bg-surface-3 text-text-secondary';
      default:
        return 'bg-text-muted';
    }
  };

  const getSizeClass = () => {
    switch (size) {
      case 'sm':
        return showLabel ? 'px-2 py-0.5 text-xs' : 'w-2 h-2';
      case 'md':
        return showLabel ? 'px-2.5 py-0.5 text-sm' : 'w-2.5 h-2.5';
      case 'lg':
        return showLabel ? 'px-3 py-1 text-base' : 'w-3 h-3';
      default:
        return showLabel ? 'px-2.5 py-0.5 text-sm' : 'w-2.5 h-2.5';
    }
  };

  const getDotSizeClass = () => {
    switch (size) {
      case 'sm':
        return 'w-2 h-2';
      case 'md':
        return 'w-2.5 h-2.5';
      case 'lg':
        return 'w-3 h-3';
      default:
        return 'w-2.5 h-2.5';
    }
  };

  const colorClass = getColorClass();
  const sizeClass = getSizeClass();

  if (!showLabel) {
    return (
      <span
        className={cn('inline-block rounded-full', colorClass, sizeClass, className)}
        title={getLabel(status)}
      />
    );
  }

  if (type === 'priority') {
    return (
      <Badge
        className={cn('border-transparent font-medium', colorClass, sizeClass, className)}
      >
        {getLabel(status)}
      </Badge>
    );
  }

  return (
    <span className={cn('inline-flex items-center gap-1.5', className)}>
      <span className={cn('inline-block rounded-full', colorClass, getDotSizeClass())} />
      <span className="text-sm text-text-secondary">{getLabel(status)}</span>
    </span>
  );
};

// Specialized badge components
export const ChatStatusBadge: React.FC<Omit<StatusBadgeProps, 'type'>> = (props) => (
  <StatusBadge {...props} type="chat" />
);

export const PriorityBadge: React.FC<Omit<StatusBadgeProps, 'type'>> = (props) => (
  <StatusBadge {...props} type="priority" />
);
