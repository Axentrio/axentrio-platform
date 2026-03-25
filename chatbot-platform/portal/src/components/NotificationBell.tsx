/**
 * NotificationBell Component
 * Shows notification count with sound toggle
 */

import React, { useState, useEffect, useRef } from 'react';
import { Bell, Volume2, VolumeX } from 'lucide-react';
import { useNotificationSound } from '@websocket/notificationSound';
import type { Notification } from '@app-types/index';

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
  const [isOpen, setIsOpen] = useState(false);
  const { isMuted, toggleMute } = useNotificationSound();
  const containerRef = useRef<HTMLDivElement>(null);

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

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
    <div ref={containerRef} className={`relative ${className}`}>
      {/* Bell button */}
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className="relative p-2 text-text-secondary hover:text-text-primary hover:bg-surface-3 rounded-xl transition-colors"
      >
        <Bell className="w-5 h-5" />

        {/* Unread badge */}
        {unreadCount > 0 && (
          <span className="absolute top-1 right-1 flex items-center justify-center min-w-4 h-4 px-1 text-xs font-medium text-white bg-red-500 rounded-full">
            {unreadCount > 99 ? '99+' : unreadCount}
          </span>
        )}
      </button>

      {/* Dropdown */}
      {isOpen && (
        <div className="absolute right-0 z-50 mt-2 w-80 bg-surface-2 border border-edge rounded-2xl shadow-card overflow-hidden">
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-edge">
            <h3 className="font-semibold text-text-primary">Notifications</h3>
            <div className="flex items-center gap-2">
              {/* Sound toggle */}
              <button
                type="button"
                onClick={toggleMute}
                className="p-1.5 text-text-muted hover:text-text-secondary hover:bg-surface-3 rounded transition-colors"
                title={isMuted ? 'Unmute notifications' : 'Mute notifications'}
              >
                {isMuted ? <VolumeX className="w-4 h-4" /> : <Volume2 className="w-4 h-4" />}
              </button>

              {/* Mark all as read */}
              {unreadCount > 0 && (
                <button
                  type="button"
                  onClick={onMarkAllAsRead}
                  className="text-xs text-primary-400 hover:text-primary-300 font-medium"
                >
                  Mark all read
                </button>
              )}
            </div>
          </div>

          {/* Notification list */}
          <div className="max-h-80 overflow-y-auto">
            {notifications.length > 0 ? (
              notifications.map((notification) => (
                <div
                  key={notification.id}
                  onClick={() => {
                    onNotificationClick?.(notification);
                    onMarkAsRead(notification.id);
                    setIsOpen(false);
                  }}
                  className={`
                    flex items-start gap-3 px-4 py-3 cursor-pointer
                    hover:bg-surface-3 transition-colors border-b border-edge/50 last:border-b-0
                    ${!notification.isRead ? 'bg-primary-600/5' : ''}
                  `}
                >
                  {getNotificationIcon(notification.type)}
                  <div className="flex-1 min-w-0">
                    <p className={`text-sm ${!notification.isRead ? 'font-medium text-text-primary' : 'text-text-secondary'}`}>
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
                </div>
              ))
            ) : (
              <div className="px-4 py-8 text-center text-text-secondary">
                <Bell className="w-8 h-8 mx-auto mb-2 text-text-muted" />
                <p className="text-sm">No notifications</p>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export default NotificationBell;
