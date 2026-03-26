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
import { useHandoffsQuery, useAcceptHandoff, useRejectHandoff } from '../queries/useHandoffQueries';
import { PriorityBadge } from '@components/StatusBadge';
import { useNotificationSound } from '@websocket/notificationSound';
import type { HandoffRequest, HandoffPriority } from '@app-types/index';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectTrigger,
  SelectContent,
  SelectItem,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';

const priorityOrder: HandoffPriority[] = ['urgent', 'high', 'medium', 'low'];

const Queue: React.FC = () => {
  const navigate = useNavigate();
  const { handoffs, pendingCount, isLoading } = useHandoffsQuery('pending');
  const acceptHandoffMutation = useAcceptHandoff();
  const rejectHandoffMutation = useRejectHandoff();
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
      await acceptHandoffMutation.mutateAsync(handoff.id);
      navigate(`/takeover/${handoff.chatId}`);
    } catch (error) {
      console.error('Failed to accept handoff:', error);
    }
  };

  const handleDecline = async (handoffId: string) => {
    try {
      await rejectHandoffMutation.mutateAsync({ handoffId, reason: 'Agent unavailable' });
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
              <Select
                value={filterPriority}
                onValueChange={(value) => setFilterPriority(value as HandoffPriority | 'all')}
              >
                <SelectTrigger className="w-[160px]">
                  <SelectValue placeholder="All Priorities" />
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
              <Card
                key={handoff.id}
                variant="glass"
                className={cn(
                  'overflow-hidden border-2',
                  handoff.priority === 'urgent' && 'border-red-500/30 bg-red-500/5',
                  handoff.priority === 'high' && 'border-accent-500/30 bg-accent-500/5',
                  handoff.priority === 'medium' && 'border-accent-300/20',
                  handoff.priority === 'low' && 'border-edge',
                )}
              >
                <div className="p-6">
                  <div className="flex items-start justify-between gap-4">
                    {/* Left: User info */}
                    <div className="flex items-start gap-4">
                      <div className={cn(
                        'w-12 h-12 rounded-full flex items-center justify-center flex-shrink-0',
                        handoff.priority === 'urgent' && 'bg-red-500/10',
                        handoff.priority === 'high' && 'bg-accent-500/10',
                        handoff.priority === 'medium' && 'bg-accent-300/10',
                        handoff.priority === 'low' && 'bg-surface-3',
                      )}>
                        <Headphones className={cn(
                          'w-6 h-6',
                          handoff.priority === 'urgent' && 'text-red-400',
                          handoff.priority === 'high' && 'text-accent-400',
                          handoff.priority === 'medium' && 'text-accent-300',
                          handoff.priority === 'low' && 'text-text-secondary',
                        )} />
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
                      <div className={cn(
                        'text-lg font-bold font-mono mb-3',
                        handoff.waitTime > 300 ? 'text-status-busy' : 'text-text-primary',
                      )}>
                        {formatWaitTime(handoff.waitTime)}
                      </div>
                      <p className="text-xs text-text-muted mb-4">waiting time</p>

                      <div className="flex items-center gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => handleDecline(handoff.id)}
                        >
                          Decline
                        </Button>
                        <Button
                          size="sm"
                          onClick={() => handleAccept(handoff)}
                        >
                          Accept
                          <ArrowRight className="w-4 h-4 ml-2" />
                        </Button>
                      </div>
                    </div>
                  </div>
                </div>
              </Card>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

export default Queue;
