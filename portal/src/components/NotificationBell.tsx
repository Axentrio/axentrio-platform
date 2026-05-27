/**
 * NotificationBell Component
 * Shows notification count with sound toggle
 */

import React, { useEffect } from 'react';
import { Bell, Volume2, VolumeX } from 'lucide-react';
import { useNotificationSound } from '@websocket/notificationSound';
import type { Notification } from '@app-types/index';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

interface NotificationBellProps {
  notifications: Notification[];
  unreadCount: number;
  onMarkAsRead: (notificationId: string) => void;
  onMarkAllAsRead: () => void;
  onNotificationClick?: (notification: Notification) => void;
  className?: string;
}

export const NotificationBell: React.FC<NotificationBellProps> = ({
  notifications,
  unreadCount,
  onMarkAsRead,
  onMarkAllAsRead,
  onNotificationClick,
  className = '',
}) => {
  const { isMuted, toggleMute } = useNotificationSound();

  // Play sound for new notifications
  useEffect(() => {
    if (unreadCount > 0 && !isMuted) {
      // Sound is handled by the WebSocket context
    }
  }, [unreadCount, isMuted]);

  const getNotificationIcon = (type: Notification['type']) => {
    switch (type) {
      case 'handoff':
        return <span className="w-2 h-2 bg-accent-500 rounded-full" />;
      case 'message':
        return <span className="w-2 h-2 bg-primary-500 rounded-full" />;
      case 'alert':
        return <span className="w-2 h-2 bg-status-busy rounded-full" />;
      default:
        return <span className="w-2 h-2 bg-text-muted rounded-full" />;
    }
  };

  return (
    <DropdownMenu>
      <div className={cn('relative', className)}>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="relative p-2 text-text-secondary hover:text-text-primary hover:bg-surface-3 rounded-xl transition-colors"
          >
            <Bell className="w-5 h-5" />

            {/* Unread badge */}
            {unreadCount > 0 && (
              <Badge
                variant="destructive"
                className="absolute top-1 right-1 flex items-center justify-center min-w-4 h-4 px-1 text-xs rounded-full"
              >
                {unreadCount > 99 ? '99+' : unreadCount}
              </Badge>
            )}
          </button>
        </DropdownMenuTrigger>
      </div>

      <DropdownMenuContent
        align="end"
        className="w-80 bg-surface-2 border-edge rounded-2xl shadow-card p-0"
      >
        {/* Header */}
        <DropdownMenuLabel className="flex items-center justify-between px-4 py-3">
          <span className="font-semibold text-text-primary">Notifications</span>
          <div className="flex items-center gap-2">
            {/* Sound toggle */}
            <button
              type="button"
              onClick={(e) => {
                e.preventDefault();
                toggleMute();
              }}
              className="p-1.5 text-text-muted hover:text-text-secondary hover:bg-surface-3 rounded transition-colors"
              title={isMuted ? 'Unmute notifications' : 'Mute notifications'}
            >
              {isMuted ? <VolumeX className="w-4 h-4" /> : <Volume2 className="w-4 h-4" />}
            </button>

            {/* Mark all as read */}
            {unreadCount > 0 && (
              <button
                type="button"
                onClick={(e) => {
                  e.preventDefault();
                  onMarkAllAsRead();
                }}
                className="text-xs text-primary-400 hover:text-primary-300 font-medium"
              >
                Mark all read
              </button>
            )}
          </div>
        </DropdownMenuLabel>

        <DropdownMenuSeparator className="bg-edge" />

        {/* Notification list */}
        <div className="max-h-80 overflow-y-auto">
          {notifications.length > 0 ? (
            notifications.map((notification) => (
              <DropdownMenuItem
                key={notification.id}
                onClick={() => {
                  onNotificationClick?.(notification);
                  onMarkAsRead(notification.id);
                }}
                className={cn(
                  'flex items-start gap-3 px-4 py-3 cursor-pointer',
                  'hover:bg-surface-3 transition-colors border-b border-edge/50 last:border-b-0 rounded-none',
                  !notification.isRead && 'bg-primary-600/5'
                )}
              >
                {getNotificationIcon(notification.type)}
                <div className="flex-1 min-w-0">
                  <p
                    className={cn(
                      'text-sm',
                      !notification.isRead
                        ? 'font-medium text-text-primary'
                        : 'text-text-secondary'
                    )}
                  >
                    {notification.title}
                  </p>
                  <p className="text-xs text-text-muted mt-0.5 line-clamp-2">
                    {notification.message}
                  </p>
                  <p className="text-xs text-text-muted mt-1">
                    {new Date(notification.createdAt).toLocaleTimeString()}
                  </p>
                </div>
                {!notification.isRead && (
                  <span className="w-2 h-2 bg-primary-500 rounded-full flex-shrink-0 mt-1" />
                )}
              </DropdownMenuItem>
            ))
          ) : (
            <div className="px-4 py-8 text-center text-text-secondary">
              <Bell className="w-8 h-8 mx-auto mb-2 text-text-muted" />
              <p className="text-sm">No notifications</p>
            </div>
          )}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

export default NotificationBell;
