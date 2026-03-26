/**
 * Dashboard Page
 * Main dashboard with metrics and overview
 */

import React from 'react';
import { useNavigate } from 'react-router-dom';
import { useDashboardMetrics } from '../queries/useDashboardQueries';
import {
  MessageSquare,
  Users,
  Clock,
  TrendingUp,
  AlertCircle,
  Headphones,
  ArrowRight
} from 'lucide-react';
import { useHandoffsQuery } from '../queries/useHandoffQueries';
import { useChatsQuery } from '../queries/useChatQueries';
import { ChatStatusBadge } from '@components/StatusBadge';
import { Card, CardHeader, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { DashboardMetrics } from '@app-types/index';

interface DashboardApiResponse {
  dashboard: {
    sessions: { total: number; active: number; waiting: number; handoff: number; bot: number };
    agents: { total: number; online: number };
    avgResponseTimeSeconds: number;
    csatScore: number | null;
    botResolutionRate: number | null;
  };
}

function mapApiToMetrics(data: DashboardApiResponse): DashboardMetrics {
  const { dashboard } = data;
  return {
    activeChats: dashboard.sessions.active + dashboard.sessions.bot,
    pendingHandoffs: dashboard.sessions.handoff,
    avgWaitTime: 0, // not returned by API yet
    avgResponseTime: dashboard.avgResponseTimeSeconds,
    onlineAgents: dashboard.agents.online,
    totalAgents: dashboard.agents.total,
    csatScore: dashboard.csatScore ?? 0,
    botResolutionRate: dashboard.botResolutionRate ?? 0,
  };
}

/** Skeleton placeholder for a metric card */
const MetricCardSkeleton: React.FC<{ index: number }> = ({ index }) => (
  <Card variant="glass" className={cn(`animate-fade-in-up stagger-${index + 1}`)}>
    <CardContent className="p-6">
      <div className="flex items-start justify-between">
        <div className="space-y-2">
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-8 w-16" />
        </div>
        <Skeleton className="p-3 rounded-xl w-12 h-12" />
      </div>
    </CardContent>
  </Card>
);

/** Skeleton placeholder for the performance sidebar */
const PerformanceSkeleton: React.FC = () => (
  <div className="p-6 space-y-6">
    {[0, 1, 2].map((i) => (
      <div key={i}>
        <div className="flex items-center justify-between mb-2">
          <Skeleton className="h-4 w-20" />
          <Skeleton className="h-5 w-12" />
        </div>
        <Skeleton className="h-2 w-full rounded-full" />
      </div>
    ))}
  </div>
);

const Dashboard: React.FC = () => {
  const navigate = useNavigate();
  const { handoffs, pendingCount } = useHandoffsQuery('pending');
  const { chats } = useChatsQuery({ filters: { status: 'handsoff' } });

  const {
    data: rawDashboard,
    isLoading,
    isError,
    error,
  } = useDashboardMetrics();

  const metrics = rawDashboard ? mapApiToMetrics(rawDashboard) : undefined;

  // Nullable fields for display — show "--" when API returned null
  const csatDisplay = rawDashboard?.dashboard.csatScore != null
    ? rawDashboard.dashboard.csatScore
    : '--';
  const botResolutionDisplay = rawDashboard?.dashboard.botResolutionRate != null
    ? rawDashboard.dashboard.botResolutionRate
    : '--';

  const stats = metrics
    ? [
        {
          label: 'Active Chats',
          value: metrics.activeChats,
          icon: MessageSquare,
          color: 'text-primary-400',
          bgColor: 'bg-primary-600/10',
          trend: '+12%',
          trendUp: true,
        },
        {
          label: 'Pending Handoffs',
          value: pendingCount,
          icon: Headphones,
          color: 'text-accent-400',
          bgColor: 'bg-accent-500/10',
          alert: pendingCount > 3,
        },
        {
          label: 'Online Agents',
          value: `${metrics.onlineAgents}/${metrics.totalAgents}`,
          icon: Users,
          color: 'text-status-online',
          bgColor: 'bg-status-online/10',
        },
        {
          label: 'Avg Response Time',
          value: `${metrics.avgResponseTime}s`,
          icon: Clock,
          color: 'text-chat-bot',
          bgColor: 'bg-chat-bot/10',
          trend: '-8%',
          trendUp: true,
        },
      ]
    : [];

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-text-primary">Dashboard</h1>
          <p className="text-text-secondary">Overview of your support operations</p>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-sm text-text-muted">
            Last updated: {new Date().toLocaleTimeString()}
          </span>
        </div>
      </div>

      {/* Error Banner */}
      {isError && (
        <div className="flex items-center gap-3 p-4 bg-accent-500/10 border border-accent-500/30 rounded-xl text-accent-400">
          <AlertCircle className="w-5 h-5 flex-shrink-0" />
          <div>
            <p className="font-medium">Failed to load dashboard metrics</p>
            <p className="text-sm text-text-secondary">
              {error instanceof Error ? error.message : 'An unexpected error occurred. Retrying...'}
            </p>
          </div>
        </div>
      )}

      {/* Stats Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        {isLoading
          ? [0, 1, 2, 3].map((i) => <MetricCardSkeleton key={i} index={i} />)
          : stats.map((stat, index) => (
              <Card
                key={index}
                variant="glass"
                hover
                className={cn(`animate-fade-in-up stagger-${index + 1}`)}
              >
                <CardContent className="p-6">
                  <div className="flex items-start justify-between">
                    <div>
                      <p className="text-sm font-medium text-text-secondary">{stat.label}</p>
                      <p className="text-2xl font-bold font-mono text-text-primary mt-1">{stat.value}</p>
                      {stat.trend && (
                        <div className={cn('flex items-center gap-1 mt-2 text-sm', stat.trendUp ? 'text-status-online' : 'text-status-busy')}>
                          <TrendingUp className="w-4 h-4" />
                          <span>{stat.trend}</span>
                        </div>
                      )}
                      {stat.alert && (
                        <div className="flex items-center gap-1 mt-2 text-sm text-accent-400">
                          <AlertCircle className="w-4 h-4" />
                          <span>Needs attention</span>
                        </div>
                      )}
                    </div>
                    <div className={cn('p-3 rounded-xl', stat.bgColor)}>
                      <stat.icon className={cn('w-6 h-6', stat.color)} />
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))}
      </div>

      {/* Main Content Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Pending Handoffs */}
        <Card variant="glass" className="lg:col-span-2">
          <CardHeader className="px-6 py-4 flex-row items-center justify-between space-y-0 border-b border-edge">
            <h2 className="text-lg font-semibold text-text-primary">Pending Handoffs</h2>
            <Button
              variant="link"
              onClick={() => navigate('/queue')}
              className="text-sm text-primary-400 hover:text-primary-300 gap-1 p-0 h-auto"
            >
              View All
              <ArrowRight className="w-4 h-4" />
            </Button>
          </CardHeader>
          <CardContent className="p-6">
            {handoffs.length > 0 ? (
              <div className="space-y-3">
                {handoffs.slice(0, 5).map((handoff) => (
                  <div
                    key={handoff.id}
                    onClick={() => navigate(`/takeover/${handoff.chatId}`)}
                    className="flex items-center justify-between p-4 bg-surface-3 rounded-xl hover:bg-surface-4 cursor-pointer transition-colors"
                  >
                    <div className="flex items-center gap-4">
                      <div className="w-10 h-10 rounded-full bg-accent-500/10 flex items-center justify-center">
                        <Headphones className="w-5 h-5 text-accent-400" />
                      </div>
                      <div>
                        <p className="font-medium text-text-primary">
                          {handoff.userName || 'Anonymous User'}
                        </p>
                        <p className="text-sm text-text-secondary">
                          {handoff.tenantName} • {handoff.reason.replace('_', ' ')}
                        </p>
                      </div>
                    </div>
                    <div className="text-right">
                      <p className="text-sm font-medium text-accent-400">
                        {Math.floor(handoff.waitTime / 60)}m {handoff.waitTime % 60}s
                      </p>
                      <p className="text-xs text-text-muted">waiting</p>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-center py-8 text-text-secondary">
                <Headphones className="w-12 h-12 mx-auto mb-3 text-text-muted" />
                <p>No pending handoffs</p>
                <p className="text-sm text-text-muted">Great job! The queue is clear.</p>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Quick Stats */}
        <Card variant="glass">
          <CardHeader className="px-6 py-4 space-y-0 border-b border-edge">
            <h2 className="text-lg font-semibold text-text-primary">Performance</h2>
          </CardHeader>
          {isLoading ? (
            <PerformanceSkeleton />
          ) : (
            <CardContent className="p-6 space-y-6">
              {/* CSAT Score */}
              <div>
                <div className="flex items-center justify-between mb-2">
                  <span className="text-sm text-text-secondary">CSAT Score</span>
                  <span className="text-lg font-bold font-mono text-text-primary">
                    {csatDisplay === '--' ? '--' : `${csatDisplay}/5`}
                  </span>
                </div>
                <div className="h-2 bg-surface-3 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-status-online rounded-full"
                    style={{
                      width: csatDisplay === '--' ? '0%' : `${(Number(csatDisplay) / 5) * 100}%`,
                    }}
                  />
                </div>
              </div>

              {/* Bot Resolution Rate */}
              <div>
                <div className="flex items-center justify-between mb-2">
                  <span className="text-sm text-text-secondary">Bot Resolution</span>
                  <span className="text-lg font-bold font-mono text-text-primary">
                    {botResolutionDisplay === '--' ? '--' : `${botResolutionDisplay}%`}
                  </span>
                </div>
                <div className="h-2 bg-surface-3 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-primary-500 rounded-full"
                    style={{
                      width: botResolutionDisplay === '--' ? '0%' : `${botResolutionDisplay}%`,
                    }}
                  />
                </div>
              </div>

              {/* Avg Wait Time */}
              <div>
                <div className="flex items-center justify-between mb-2">
                  <span className="text-sm text-text-secondary">Avg Wait Time</span>
                  <span className="text-lg font-bold font-mono text-text-primary">
                    {metrics ? `${metrics.avgWaitTime}s` : '--'}
                  </span>
                </div>
                <div className="h-2 bg-surface-3 rounded-full overflow-hidden">
                  <div
                    className={cn('h-full rounded-full', (metrics?.avgWaitTime ?? 0) < 60 ? 'bg-status-online' : 'bg-accent-500')}
                    style={{
                      width: `${Math.min(((metrics?.avgWaitTime ?? 0) / 120) * 100, 100)}%`,
                    }}
                  />
                </div>
              </div>
            </CardContent>
          )}
        </Card>
      </div>

      {/* Active Chats Preview */}
      <Card variant="glass">
        <CardHeader className="px-6 py-4 flex-row items-center justify-between space-y-0 border-b border-edge">
          <h2 className="text-lg font-semibold text-text-primary">Active Chats</h2>
          <Button
            variant="link"
            onClick={() => navigate('/monitor')}
            className="text-sm text-primary-400 hover:text-primary-300 gap-1 p-0 h-auto"
          >
            View All
            <ArrowRight className="w-4 h-4" />
          </Button>
        </CardHeader>
        <CardContent className="p-6">
          {chats.length > 0 ? (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {chats.slice(0, 6).map((chat) => (
                <div
                  key={chat.id}
                  onClick={() => navigate(`/takeover/${chat.id}`)}
                  className="p-4 border border-edge rounded-xl hover:border-primary-500/30 hover:shadow-glow-sm cursor-pointer transition-all"
                >
                  <div className="flex items-start justify-between mb-2">
                    <span className="font-medium text-text-primary truncate">
                      {chat.userName || 'Anonymous'}
                    </span>
                    <ChatStatusBadge status={chat.status} size="sm" />
                  </div>
                  <p className="text-sm text-text-secondary truncate mb-2">
                    {chat.messages?.[chat.messages.length - 1]?.content || 'No messages'}
                  </p>
                  <div className="flex items-center justify-between text-xs text-text-muted">
                    <span>{chat.tenantName}</span>
                    <span>{chat.assignedAgentName || 'Unassigned'}</span>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="text-center py-8 text-text-secondary">
              <MessageSquare className="w-12 h-12 mx-auto mb-3 text-text-muted" />
              <p>No active handoff chats</p>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
};

export default Dashboard;
