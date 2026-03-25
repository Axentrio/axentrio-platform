/**
 * Dashboard Page
 * Main dashboard with metrics and overview
 */

import React from 'react';
import { useNavigate } from 'react-router-dom';
import {
  MessageSquare,
  Users,
  Clock,
  TrendingUp,
  AlertCircle,
  Headphones,
  ArrowRight
} from 'lucide-react';
import { useHandoffs } from '@hooks/useHandoffs';
import { useChats } from '@hooks/useChats';
import { ChatStatusBadge } from '@components/StatusBadge';
import type { DashboardMetrics } from '@app-types/index';

// Mock metrics - replace with actual data
const mockMetrics: DashboardMetrics = {
  activeChats: 24,
  pendingHandoffs: 5,
  avgWaitTime: 45,
  avgResponseTime: 32,
  onlineAgents: 8,
  totalAgents: 12,
  csatScore: 4.6,
  botResolutionRate: 68,
};

const Dashboard: React.FC = () => {
  const navigate = useNavigate();
  const { handoffs, pendingCount } = useHandoffs({ status: 'pending' });
  const { chats } = useChats({ filters: { status: 'handsoff' }, autoRefresh: true });

  const stats = [
    {
      label: 'Active Chats',
      value: mockMetrics.activeChats,
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
      value: `${mockMetrics.onlineAgents}/${mockMetrics.totalAgents}`,
      icon: Users,
      color: 'text-status-online',
      bgColor: 'bg-status-online/10',
    },
    {
      label: 'Avg Response Time',
      value: `${mockMetrics.avgResponseTime}s`,
      icon: Clock,
      color: 'text-chat-bot',
      bgColor: 'bg-chat-bot/10',
      trend: '-8%',
      trendUp: true,
    },
  ];

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

      {/* Stats Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        {stats.map((stat, index) => (
          <div
            key={index}
            className={`card p-6 hover:shadow-card-hover transition-all animate-fade-in-up stagger-${index + 1}`}
          >
            <div className="flex items-start justify-between">
              <div>
                <p className="text-sm font-medium text-text-secondary">{stat.label}</p>
                <p className="text-2xl font-bold font-mono text-text-primary mt-1">{stat.value}</p>
                {stat.trend && (
                  <div className={`flex items-center gap-1 mt-2 text-sm ${stat.trendUp ? 'text-status-online' : 'text-status-busy'}`}>
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
              <div className={`p-3 rounded-xl ${stat.bgColor}`}>
                <stat.icon className={`w-6 h-6 ${stat.color}`} />
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Main Content Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Pending Handoffs */}
        <div className="lg:col-span-2 card">
          <div className="px-6 py-4 border-b border-edge flex items-center justify-between">
            <h2 className="text-lg font-semibold text-text-primary">Pending Handoffs</h2>
            <button
              onClick={() => navigate('/queue')}
              className="text-sm text-primary-400 hover:text-primary-300 flex items-center gap-1"
            >
              View All
              <ArrowRight className="w-4 h-4" />
            </button>
          </div>
          <div className="p-6">
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
          </div>
        </div>

        {/* Quick Stats */}
        <div className="card">
          <div className="px-6 py-4 border-b border-edge">
            <h2 className="text-lg font-semibold text-text-primary">Performance</h2>
          </div>
          <div className="p-6 space-y-6">
            {/* CSAT Score */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm text-text-secondary">CSAT Score</span>
                <span className="text-lg font-bold font-mono text-text-primary">{mockMetrics.csatScore}/5</span>
              </div>
              <div className="h-2 bg-surface-3 rounded-full overflow-hidden">
                <div
                  className="h-full bg-status-online rounded-full"
                  style={{ width: `${(mockMetrics.csatScore / 5) * 100}%` }}
                />
              </div>
            </div>

            {/* Bot Resolution Rate */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm text-text-secondary">Bot Resolution</span>
                <span className="text-lg font-bold font-mono text-text-primary">{mockMetrics.botResolutionRate}%</span>
              </div>
              <div className="h-2 bg-surface-3 rounded-full overflow-hidden">
                <div
                  className="h-full bg-primary-500 rounded-full"
                  style={{ width: `${mockMetrics.botResolutionRate}%` }}
                />
              </div>
            </div>

            {/* Avg Wait Time */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm text-text-secondary">Avg Wait Time</span>
                <span className="text-lg font-bold font-mono text-text-primary">{mockMetrics.avgWaitTime}s</span>
              </div>
              <div className="h-2 bg-surface-3 rounded-full overflow-hidden">
                <div
                  className={`h-full rounded-full ${mockMetrics.avgWaitTime < 60 ? 'bg-status-online' : 'bg-accent-500'}`}
                  style={{ width: `${Math.min((mockMetrics.avgWaitTime / 120) * 100, 100)}%` }}
                />
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Active Chats Preview */}
      <div className="card">
        <div className="px-6 py-4 border-b border-edge flex items-center justify-between">
          <h2 className="text-lg font-semibold text-text-primary">Active Chats</h2>
          <button
            onClick={() => navigate('/monitor')}
            className="text-sm text-primary-400 hover:text-primary-300 flex items-center gap-1"
          >
            View All
            <ArrowRight className="w-4 h-4" />
          </button>
        </div>
        <div className="p-6">
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
        </div>
      </div>
    </div>
  );
};

export default Dashboard;
