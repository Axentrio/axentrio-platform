/**
 * Analytics Page
 * Response times, CSAT, bot vs human ratio
 */

import React, { useState } from 'react';
import {
  LineChart,
  Line,
  BarChart,
  Bar,
  PieChart,
  Pie,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
  AreaChart,
  Area,
} from 'recharts';
import { Download, TrendingUp, Users, MessageSquare, Clock, Star } from 'lucide-react';

// Mock data - replace with actual API data
const chatVolumeData = [
  { date: 'Mon', bot: 45, human: 12, handoff: 8 },
  { date: 'Tue', bot: 52, human: 15, handoff: 10 },
  { date: 'Wed', bot: 48, human: 18, handoff: 12 },
  { date: 'Thu', bot: 55, human: 14, handoff: 9 },
  { date: 'Fri', bot: 60, human: 20, handoff: 15 },
  { date: 'Sat', bot: 35, human: 8, handoff: 5 },
  { date: 'Sun', bot: 30, human: 6, handoff: 4 },
];

const responseTimeData = [
  { date: 'Mon', avg: 32, target: 30 },
  { date: 'Tue', avg: 28, target: 30 },
  { date: 'Wed', avg: 35, target: 30 },
  { date: 'Thu', avg: 25, target: 30 },
  { date: 'Fri', avg: 40, target: 30 },
  { date: 'Sat', avg: 22, target: 30 },
  { date: 'Sun', avg: 20, target: 30 },
];

const resolutionData = [
  { name: 'Bot Resolved', value: 68, color: '#a78bfa' },
  { name: 'Human Resolved', value: 32, color: '#34d399' },
];

const csatData = [
  { rating: '5 Stars', count: 145 },
  { rating: '4 Stars', count: 68 },
  { rating: '3 Stars', count: 23 },
  { rating: '2 Stars', count: 12 },
  { rating: '1 Star', count: 8 },
];

const agentPerformanceData = [
  { name: 'John D.', chats: 45, responseTime: 28, csat: 4.8 },
  { name: 'Jane S.', chats: 52, responseTime: 32, csat: 4.6 },
  { name: 'Mike R.', chats: 38, responseTime: 35, csat: 4.5 },
  { name: 'Sarah L.', chats: 41, responseTime: 25, csat: 4.9 },
  { name: 'Tom H.', chats: 35, responseTime: 40, csat: 4.3 },
];

const chartTooltipStyle = {
  backgroundColor: '#1e2030',
  border: '1px solid #2a2d3e',
  borderRadius: '12px',
  color: '#f1f3f9',
};

const Analytics: React.FC = () => {
  const [dateRange, setDateRange] = useState('7d');
  const [activeTab, setActiveTab] = useState<'overview' | 'agents' | 'chats'>('overview');

  const stats = [
    { label: 'Total Chats', value: '1,245', change: '+12%', icon: MessageSquare, color: 'text-primary-400', bgColor: 'bg-primary-600/10' },
    { label: 'Avg Response Time', value: '28s', change: '-8%', icon: Clock, color: 'text-status-online', bgColor: 'bg-status-online/10' },
    { label: 'CSAT Score', value: '4.6/5', change: '+0.2', icon: Star, color: 'text-accent-400', bgColor: 'bg-accent-500/10' },
    { label: 'Active Agents', value: '12', change: '+2', icon: Users, color: 'text-chat-bot', bgColor: 'bg-chat-bot/10' },
  ];

  const handleExport = (format: 'csv' | 'json' | 'xlsx') => {
    // Implement export functionality
    console.log('Exporting as', format);
  };

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-text-primary">Analytics</h1>
          <p className="text-text-secondary">Performance metrics and insights</p>
        </div>

        <div className="flex items-center gap-4">
          {/* Date Range Selector */}
          <select
            value={dateRange}
            onChange={(e) => setDateRange(e.target.value)}
            className="px-3 py-2 bg-surface-3 border border-edge rounded-xl text-sm text-text-primary focus:outline-none focus:border-primary-500 focus:ring-1 focus:ring-primary-500/30"
          >
            <option value="24h">Last 24 Hours</option>
            <option value="7d">Last 7 Days</option>
            <option value="30d">Last 30 Days</option>
            <option value="90d">Last 90 Days</option>
          </select>

          {/* Export Button */}
          <div className="relative group">
            <button className="flex items-center gap-2 px-4 py-2 bg-surface-3 border border-edge rounded-xl text-sm font-medium text-text-primary hover:bg-surface-4 hover:border-edge-light transition-colors">
              <Download className="w-4 h-4" />
              Export
            </button>
            <div className="absolute right-0 mt-2 w-32 bg-surface-2 border border-edge rounded-xl shadow-card opacity-0 invisible group-hover:opacity-100 group-hover:visible transition-all">
              <button onClick={() => handleExport('csv')} className="block w-full px-4 py-2 text-left text-sm text-text-secondary hover:bg-surface-3 rounded-t-xl">CSV</button>
              <button onClick={() => handleExport('json')} className="block w-full px-4 py-2 text-left text-sm text-text-secondary hover:bg-surface-3">JSON</button>
              <button onClick={() => handleExport('xlsx')} className="block w-full px-4 py-2 text-left text-sm text-text-secondary hover:bg-surface-3 rounded-b-xl">Excel</button>
            </div>
          </div>
        </div>
      </div>

      {/* Stats Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        {stats.map((stat, index) => (
          <div key={index} className={`card p-6 animate-fade-in-up stagger-${index + 1}`}>
            <div className="flex items-start justify-between">
              <div>
                <p className="text-sm font-medium text-text-secondary">{stat.label}</p>
                <p className="text-2xl font-bold font-mono text-text-primary mt-1">{stat.value}</p>
                <div className={`flex items-center gap-1 mt-2 text-sm ${stat.change.startsWith('+') || stat.change.startsWith('-') ? 'text-status-online' : 'text-status-busy'}`}>
                  <TrendingUp className="w-4 h-4" />
                  <span>{stat.change}</span>
                </div>
              </div>
              <div className={`p-3 rounded-xl ${stat.bgColor}`}>
                <stat.icon className={`w-6 h-6 ${stat.color}`} />
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Tabs */}
      <div className="border-b border-edge">
        <nav className="flex gap-6">
          {(['overview', 'agents', 'chats'] as const).map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`
                py-3 text-sm font-medium border-b-2 transition-colors
                ${activeTab === tab
                  ? 'border-primary-500 text-primary-400'
                  : 'border-transparent text-text-secondary hover:text-text-primary'
                }
              `}
            >
              {tab.charAt(0).toUpperCase() + tab.slice(1)}
            </button>
          ))}
        </nav>
      </div>

      {/* Tab Content */}
      {activeTab === 'overview' && (
        <div className="space-y-6">
          {/* Chat Volume Chart */}
          <div className="card p-6">
            <h3 className="text-lg font-semibold text-text-primary mb-4">Chat Volume</h3>
            <ResponsiveContainer width="100%" height={300}>
              <AreaChart data={chatVolumeData}>
                <CartesianGrid strokeDasharray="3 3" stroke="#2a2d3e" />
                <XAxis dataKey="date" stroke="#6b7194" />
                <YAxis stroke="#6b7194" />
                <Tooltip contentStyle={chartTooltipStyle} />
                <Legend />
                <Area type="monotone" dataKey="bot" stackId="1" stroke="#a78bfa" fill="#a78bfa" fillOpacity={0.4} name="Bot" />
                <Area type="monotone" dataKey="human" stackId="1" stroke="#34d399" fill="#34d399" fillOpacity={0.4} name="Human" />
                <Area type="monotone" dataKey="handoff" stackId="1" stroke="#fbbf24" fill="#fbbf24" fillOpacity={0.4} name="Handoff" />
              </AreaChart>
            </ResponsiveContainer>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Response Time Chart */}
            <div className="card p-6">
              <h3 className="text-lg font-semibold text-text-primary mb-4">Average Response Time</h3>
              <ResponsiveContainer width="100%" height={250}>
                <LineChart data={responseTimeData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#2a2d3e" />
                  <XAxis dataKey="date" stroke="#6b7194" />
                  <YAxis stroke="#6b7194" />
                  <Tooltip contentStyle={chartTooltipStyle} />
                  <Legend />
                  <Line type="monotone" dataKey="avg" stroke="#818cf8" strokeWidth={2} name="Actual (seconds)" />
                  <Line type="monotone" dataKey="target" stroke="#34d399" strokeWidth={2} strokeDasharray="5 5" name="Target (seconds)" />
                </LineChart>
              </ResponsiveContainer>
            </div>

            {/* Resolution Distribution */}
            <div className="card p-6">
              <h3 className="text-lg font-semibold text-text-primary mb-4">Resolution Distribution</h3>
              <ResponsiveContainer width="100%" height={250}>
                <PieChart>
                  <Pie
                    data={resolutionData}
                    cx="50%"
                    cy="50%"
                    innerRadius={60}
                    outerRadius={80}
                    paddingAngle={5}
                    dataKey="value"
                  >
                    {resolutionData.map((entry, index) => (
                      <Cell key={`cell-${index}`} fill={entry.color} />
                    ))}
                  </Pie>
                  <Tooltip contentStyle={chartTooltipStyle} />
                  <Legend />
                </PieChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* CSAT Distribution */}
          <div className="card p-6">
            <h3 className="text-lg font-semibold text-text-primary mb-4">CSAT Distribution</h3>
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={csatData}>
                <CartesianGrid strokeDasharray="3 3" stroke="#2a2d3e" />
                <XAxis dataKey="rating" stroke="#6b7194" />
                <YAxis stroke="#6b7194" />
                <Tooltip contentStyle={chartTooltipStyle} />
                <Bar dataKey="count" fill="#fbbf24" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

      {activeTab === 'agents' && (
        <div className="card overflow-hidden">
          <div className="px-6 py-4 border-b border-edge">
            <h3 className="text-lg font-semibold text-text-primary">Agent Performance</h3>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-surface-3">
                <tr>
                  <th className="px-6 py-3 text-left text-xs font-medium text-text-secondary uppercase tracking-wider">Agent</th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-text-secondary uppercase tracking-wider">Chats Handled</th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-text-secondary uppercase tracking-wider">Avg Response Time</th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-text-secondary uppercase tracking-wider">CSAT Score</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-edge">
                {agentPerformanceData.map((agent, index) => (
                  <tr key={index} className="hover:bg-surface-3">
                    <td className="px-6 py-4 whitespace-nowrap font-medium text-text-primary">{agent.name}</td>
                    <td className="px-6 py-4 whitespace-nowrap text-text-secondary">{agent.chats}</td>
                    <td className="px-6 py-4 whitespace-nowrap text-text-secondary">{agent.responseTime}s</td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      <div className="flex items-center gap-2">
                        <Star className="w-4 h-4 text-accent-400 fill-accent-400" />
                        <span className="text-text-primary">{agent.csat}</span>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {activeTab === 'chats' && (
        <div className="card p-6">
          <h3 className="text-lg font-semibold text-text-primary mb-4">Chat Analysis</h3>
          <p className="text-text-secondary">Detailed chat analysis coming soon...</p>
        </div>
      )}
    </div>
  );
};

export default Analytics;
