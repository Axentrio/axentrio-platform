/**
 * ConnectionIndicator
 * Live / Reconnecting / Offline pill driven by the REAL socket connection
 * state (B-PR3b finding: the old header dot was decorative and permanently
 * green). Prop-driven so the Inbox wires it from useSocket() and tests can
 * exercise all three states directly.
 */

import React from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';

interface ConnectionIndicatorProps {
  isConnected: boolean;
  isConnecting: boolean;
  className?: string;
}

export const ConnectionIndicator: React.FC<ConnectionIndicatorProps> = ({
  isConnected,
  isConnecting,
  className,
}) => {
  const { t } = useTranslation();

  const state: 'live' | 'reconnecting' | 'offline' = isConnected
    ? 'live'
    : isConnecting
      ? 'reconnecting'
      : 'offline';

  const label =
    state === 'live'
      ? t('inbox.header.live')
      : state === 'reconnecting'
        ? t('inbox.header.reconnecting')
        : t('inbox.header.offline');

  return (
    <div
      data-testid="connection-indicator"
      data-state={state}
      className={cn('flex items-center gap-2 text-sm text-text-muted', className)}
    >
      <span
        className={cn(
          'w-2 h-2 rounded-full',
          state === 'live' &&
            'bg-status-online animate-pulse shadow-[0_0_6px_rgba(52,211,153,0.5)]',
          state === 'reconnecting' && 'bg-amber-400 animate-pulse',
          state === 'offline' && 'bg-red-500',
        )}
      />
      {label}
    </div>
  );
};
