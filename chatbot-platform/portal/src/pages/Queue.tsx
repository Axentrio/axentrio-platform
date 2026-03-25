/**
 * Queue Page
 * Handoff request queue management
 */

import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Headphones,
  Clock,
  User,
  MessageSquare,
  AlertCircle,
  XCircle,
  Filter,
  ArrowRight
} from 'lucide-react';
import { useHandoffs } from '@hooks/useHandoffs';
import { PriorityBadge } from '@components/StatusBadge';
import { useNotificationSound } from '@websocket/notificationSound';
import type { HandoffRequest, HandoffPriority } from '@app-types/index';

const priorityOrder: HandoffPriority[] = ['urgent', 'high', 'medium', 'low'];

const Queue: React.FC = () => {
  const navigate = useNavigate();
  const { handoffs, pendingCount, isLoading, acceptHandoff, declineHandoff } = useHandoffs({
    status: 'pending',
    autoRefresh: true,
  });
  useNotificationSound();

  const [filterPriority, setFilterPriority] = useState<HandoffPriority | 'all'>('all');

  // Sort and filter handoffs
  const sortedHandoffs = [...handoffs].sort((a, b) => {
    // Sort by priority first
    const priorityDiff = priorityOrder.indexOf(a.priority) - priorityOrder.indexOf(b.priority);
    if (priorityDiff !== 0) return priorityDiff;

    // Then by wait time (longer wait = higher priority)
    return b.waitTime - a.waitTime;
  });

  const filteredHandoffs = filterPriority === 'all'
    ? sortedHandoffs
    : sortedHandoffs.filter((h) => h.priority === filterPriority);

  const handleAccept = async (handoff: HandoffRequest) => {
    try {
      await acceptHandoff(handoff.id);
      navigate(`/takeover/${handoff.chatId}`);
    } catch (error) {
      console.error('Failed to accept handoff:', error);
    }
  };

  const handleDecline = async (handoffId: string) => {
    try {
      await declineHandoff(handoffId, 'Agent unavailable');
    } catch (error) {
      console.error('Failed to decline handoff:', error);
    }
  };

  const formatWaitTime = (seconds: number) => {
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;

    if (minutes > 0) {
      return `${minutes}m ${remainingSeconds}s`;
    }
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

  const getReasonLabel = (reason: HandoffRequest['reason']) => {
    return reason.replace(/_/g, ' ').replace(/\b\w/g, (l) => l.toUpperCase());
  };

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="px-6 py-4 border-b border-edge bg-surface-2">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-text-primary">Handoff Queue</h1>
            <p className="text-text-secondary">
              {pendingCount} pending request{pendingCount !== 1 ? 's' : ''}
            </p>
          </div>

          <div className="flex items-center gap-4">
            {/* Priority filter */}
            <div className="flex items-center gap-2">
              <Filter className="w-4 h-4 text-text-muted" />
              <select
                value={filterPriority}
                onChange={(e) => setFilterPriority(e.target.value as HandoffPriority | 'all')}
                className="px-3 py-2 bg-surface-3 border border-edge rounded-xl text-sm text-text-primary focus:outline-none focus:border-primary-500 focus:ring-1 focus:ring-primary-500/30"
              >
                <option value="all">All Priorities</option>
                <option value="urgent">Urgent</option>
                <option value="high">High</option>
                <option value="medium">Medium</option>
                <option value="low">Low</option>
              </select>
            </div>
          </div>
        </div>
      </div>

      {/* Queue List */}
      <div className="flex-1 overflow-y-auto p-6">
        {isLoading && filteredHandoffs.length === 0 ? (
          <div className="flex items-center justify-center h-64">
            <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary-600" />
          </div>
        ) : filteredHandoffs.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-64 text-text-secondary">
            <Headphones className="w-16 h-16 mb-4 text-text-muted" />
            <p className="text-lg font-medium">No pending handoffs</p>
            <p className="text-sm text-text-muted">The queue is clear. Great job!</p>
          </div>
        ) : (
          <div className="space-y-4 max-w-4xl mx-auto">
            {filteredHandoffs.map((handoff) => (
              <div
                key={handoff.id}
                className={`
                  card overflow-hidden border-2
                  ${handoff.priority === 'urgent' ? 'border-red-500/30 bg-red-500/5' : ''}
                  ${handoff.priority === 'high' ? 'border-accent-500/30 bg-accent-500/5' : ''}
                  ${handoff.priority === 'medium' ? 'border-accent-300/20' : ''}
                  ${handoff.priority === 'low' ? 'border-edge' : ''}
                `}
              >
                <div className="p-6">
                  <div className="flex items-start justify-between gap-4">
                    {/* Left: User info */}
                    <div className="flex items-start gap-4">
                      <div className={`
                        w-12 h-12 rounded-full flex items-center justify-center flex-shrink-0
                        ${handoff.priority === 'urgent' ? 'bg-red-500/10' : ''}
                        ${handoff.priority === 'high' ? 'bg-accent-500/10' : ''}
                        ${handoff.priority === 'medium' ? 'bg-accent-300/10' : ''}
                        ${handoff.priority === 'low' ? 'bg-surface-3' : ''}
                      `}>
                        <Headphones className={`
                          w-6 h-6
                          ${handoff.priority === 'urgent' ? 'text-red-400' : ''}
                          ${handoff.priority === 'high' ? 'text-accent-400' : ''}
                          ${handoff.priority === 'medium' ? 'text-accent-300' : ''}
                          ${handoff.priority === 'low' ? 'text-text-secondary' : ''}
                        `} />
                      </div>

                      <div>
                        <div className="flex items-center gap-2 mb-1">
                          <h3 className="font-semibold text-text-primary">
                            {handoff.userName || 'Anonymous User'}
                          </h3>
                          <PriorityBadge status={handoff.priority} size="sm" />
                        </div>

                        <div className="flex items-center gap-4 text-sm text-text-secondary">
                          <span className="flex items-center gap-1">
                            {getReasonIcon(handoff.reason)}
                            {getReasonLabel(handoff.reason)}
                          </span>
                          <span>•</span>
                          <span>{handoff.tenantName}</span>
                          <span>•</span>
                          <span className="flex items-center gap-1">
                            <MessageSquare className="w-4 h-4" />
                            {handoff.messageCount} messages
                          </span>
                        </div>

                        {handoff.reasonDetails && (
                          <p className="mt-2 text-sm text-text-secondary bg-surface-3 p-2 rounded-xl">
                            {handoff.reasonDetails}
                          </p>
                        )}
                      </div>
                    </div>

                    {/* Right: Wait time and actions */}
                    <div className="text-right flex-shrink-0">
                      <div className={`
                        text-lg font-bold font-mono mb-3
                        ${handoff.waitTime > 300 ? 'text-status-busy' : 'text-text-primary'}
                      `}>
                        {formatWaitTime(handoff.waitTime)}
                      </div>
                      <p className="text-xs text-text-muted mb-4">waiting time</p>

                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => handleDecline(handoff.id)}
                          className="px-4 py-2 border border-edge text-text-secondary rounded-xl hover:bg-surface-3 hover:border-edge-light transition-colors text-sm font-medium"
                        >
                          Decline
                        </button>
                        <button
                          onClick={() => handleAccept(handoff)}
                          className="px-4 py-2 bg-primary-600 text-white rounded-xl hover:bg-primary-500 hover:shadow-glow transition-all text-sm font-medium flex items-center gap-2"
                        >
                          Accept
                          <ArrowRight className="w-4 h-4" />
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

export default Queue;
