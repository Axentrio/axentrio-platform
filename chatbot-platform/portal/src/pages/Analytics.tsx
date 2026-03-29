/**
 * Analytics Page
 * Response times, CSAT, bot vs human ratio
 */

import React, { useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAnalyticsTimeseries, useAnalyticsChatMetrics, useAnalyticsAgents } from '../queries/useAnalyticsQueries';
import { useDashboardMetrics } from '../queries/useDashboardQueries';
import { useAppAuth } from '@auth/useAppAuth';
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
import { Download, TrendingUp, Users, MessageSquare, Clock, Star, Headphones } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Card, CardHeader, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface TimeseriesPoint {
  date: string;
  bot: number;
  human: number;
  handoff: number;
}

interface ChatMetrics {
  total: number;
  closed: number;
  open: number;
  avgDurationSeconds: number;
}

interface AgentRow {
  id: string;
  name: string;
  status: string;
  totalChatsHandled: number;
  avgResponseTimeSeconds: number;
  satisfactionScore: number;
  currentChatCount: number;
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

/** Convert the dateRange selector value to a {startDate, endDate} pair. */
function dateRangeToISO(range: string): { startDate: string; endDate: string } {
  const end = new Date();
  const start = new Date();

  switch (range) {
    case '24h':
      start.setDate(end.getDate() - 1);
      break;
    case '30d':
      start.setDate(end.getDate() - 30);
      break;
    case '90d':
      start.setDate(end.getDate() - 90);
      break;
    case '7d':
    default:
      start.setDate(end.getDate() - 7);
      break;
  }

  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  return { startDate: fmt(start), endDate: fmt(end) };
}

/** Skeleton placeholder for loading charts. */
const ChartSkeleton: React.FC<{ height?: number }> = ({ height = 250 }) => (
  <Skeleton className="w-full rounded-xl" style={{ height }} />
);

/** Skeleton placeholder for loading tables. */
const TableSkeleton: React.FC = () => (
  <div className="space-y-3 p-6">
    {[...Array(5)].map((_, i) => (
      <Skeleton key={i} className="h-10 rounded-lg w-full" />
    ))}
  </div>
);

// TODO: wire responseTimeData when daily breakdown API available
const responseTimeData = [
  { date: 'Mon', avg: 32, target: 30 },
  { date: 'Tue', avg: 28, target: 30 },
  { date: 'Wed', avg: 35, target: 30 },
  { date: 'Thu', avg: 25, target: 30 },
  { date: 'Fri', avg: 40, target: 30 },
  { date: 'Sat', avg: 22, target: 30 },
  { date: 'Sun', avg: 20, target: 30 },
];

// TODO: wire csatData when daily breakdown API available
const csatData = [
  { rating: '5 Stars', count: 145 },
  { rating: '4 Stars', count: 68 },
  { rating: '3 Stars', count: 23 },
  { rating: '2 Stars', count: 12 },
  { rating: '1 Star', count: 8 },
];

const chartTooltipStyle = {
  backgroundColor: '#1e2030',
  border: '1px solid #2a2d3e',
  borderRadius: '12px',
  color: '#f1f3f9',
};

const Analytics: React.FC = () => {
  const navigate = useNavigate();
  const { user } = useAppAuth();
  const isAgent = user?.role === 'agent';
  const [dateRange, setDateRange] = useState('7d');
  const [activeTab, setActiveTab] = useState<'overview' | 'agents' | 'chats'>('overview');

  const { startDate, endDate } = useMemo(() => dateRangeToISO(dateRange), [dateRange]);

  /* ---------------------------------------------------------------- */
  /*  API Queries                                                      */
  /* ---------------------------------------------------------------- */

  // Timeseries — used in overview tab
  const {
    data: timeseriesRes,
    isLoading: isLoadingTimeseries,
  } = useAnalyticsTimeseries(startDate, endDate, activeTab === 'overview');

  // Chat metrics — used in overview tab (stats cards + resolution pie)
  const {
    data: metricsRes,
    isLoading: isLoadingMetrics,
  } = useAnalyticsChatMetrics(startDate, endDate, activeTab === 'overview' || activeTab === 'chats');

  // Agent performance — used in agents tab + stats cards
  const {
    data: agentsRes,
    isLoading: isLoadingAgents,
  } = useAnalyticsAgents(activeTab === 'agents' || activeTab === 'overview');

  // Dashboard real-time metrics (sessions, agents, etc.)
  const { data: rawDashboard } = useDashboardMetrics();
  const dashboard = (rawDashboard as any)?.dashboard;

  /* ---------------------------------------------------------------- */
  /*  Derived data                                                     */
  /* ---------------------------------------------------------------- */

  const chatVolumeData: TimeseriesPoint[] = (timeseriesRes as { timeseries?: TimeseriesPoint[] })?.timeseries ?? [];

  const metrics = (metricsRes as { metrics?: ChatMetrics })?.metrics;
  const agents: AgentRow[] = (agentsRes as { agents?: AgentRow[] })?.agents ?? [];

  // Resolution pie: bot resolved = closed minus human-handled, human = rest
  const resolutionData = useMemo(() => {
    if (!metrics) return [];
    const humanResolved = metrics.open; // open tickets still with humans
    const botResolved = Math.max(metrics.closed - humanResolved, 0);
    const total = botResolved + humanResolved || 1;
    return [
      { name: 'Bot Resolved', value: Math.round((botResolved / total) * 100), color: '#a78bfa' },
      { name: 'Human Resolved', value: Math.round((humanResolved / total) * 100), color: '#34d399' },
    ];
  }, [metrics]);

  // Agent table data mapped to the shape used by the table
  const agentPerformanceData = useMemo(
    () =>
      agents.map((a) => ({
        name: a.name,
        chats: a.totalChatsHandled,
        responseTime: a.avgResponseTimeSeconds,
        csat: a.satisfactionScore,
      })),
    [agents],
  );

  const activeAgentCount = agents.filter((a) => a.status === 'online').length;

  // Stats cards — 6 real-time metrics combining Dashboard + Analytics data
  const stats: Array<{
    label: string;
    value: string;
    change: string;
    icon: React.FC<any>;
    color: string;
    bgColor: string;
    onClick?: () => void;
  }> = [
    {
      label: 'Active Chats',
      value: dashboard ? String(dashboard.sessions.active + dashboard.sessions.bot) : '—',
      change: '',
      icon: MessageSquare,
      color: 'text-primary-400',
      bgColor: 'bg-primary-600/10',
      onClick: () => navigate('/inbox'),
    },
    {
      label: 'Pending Handoffs',
      value: dashboard ? String(dashboard.sessions.handoff) : '—',
      change: '',
      icon: Headphones,
      color: 'text-accent-400',
      bgColor: 'bg-accent-500/10',
      onClick: () => navigate('/inbox'),
    },
    {
      label: 'Online Agents',
      value: dashboard ? `${dashboard.agents.online}/${dashboard.agents.total}` : '—',
      change: '',
      icon: Users,
      color: 'text-status-online',
      bgColor: 'bg-status-online/10',
    },
    {
      label: 'Avg Response Time',
      value: dashboard ? `${dashboard.avgResponseTimeSeconds}s` : '—',
      change: '',
      icon: Clock,
      color: 'text-chat-bot',
      bgColor: 'bg-chat-bot/10',
    },
    {
      label: 'CSAT Score',
      value:
        dashboard?.csatScore != null
          ? `${dashboard.csatScore}/5`
          : '—',
      change: '',
      icon: Star,
      color: 'text-accent-400',
      bgColor: 'bg-accent-500/10',
    },
    {
      label: 'Total Chats',
      value: metrics ? metrics.total.toLocaleString() : '—',
      change: '',
      icon: TrendingUp,
      color: 'text-primary-400',
      bgColor: 'bg-primary-600/10',
    },
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
          <Select value={dateRange} onValueChange={setDateRange}>
            <SelectTrigger className="w-[180px]">
              <SelectValue placeholder="Select range" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="24h">Last 24 Hours</SelectItem>
              <SelectItem value="7d">Last 7 Days</SelectItem>
              <SelectItem value="30d">Last 30 Days</SelectItem>
              <SelectItem value="90d">Last 90 Days</SelectItem>
            </SelectContent>
          </Select>

          {/* Export Dropdown */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline">
                <Download className="w-4 h-4" />
                Export
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => handleExport('csv')}>CSV</DropdownMenuItem>
              <DropdownMenuItem onClick={() => handleExport('json')}>JSON</DropdownMenuItem>
              <DropdownMenuItem onClick={() => handleExport('xlsx')}>Excel</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {/* Stats Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-6 gap-4">
        {stats.map((stat, index) => (
          <Card
            key={index}
            variant="glass"
            className={cn("animate-fade-in-up", `stagger-${index + 1}`, stat.onClick && "cursor-pointer")}
            onClick={stat.onClick}
          >
            <CardContent className="p-6">
              <div className="flex items-start justify-between">
                <div>
                  <p className="text-sm font-medium text-text-secondary">{stat.label}</p>
                  <p className="text-2xl font-bold font-mono text-text-primary mt-1">{stat.value}</p>
                  {stat.change && (
                    <div className={cn("flex items-center gap-1 mt-2 text-sm", stat.change.startsWith('+') || stat.change.startsWith('-') ? 'text-status-online' : 'text-status-busy')}>
                      <TrendingUp className="w-4 h-4" />
                      <span>{stat.change}</span>
                    </div>
                  )}
                </div>
                <div className={cn("p-3 rounded-xl", stat.bgColor)}>
                  <stat.icon className={cn("w-6 h-6", stat.color)} />
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Tabs — agents only see a link to Inbox */}
      {isAgent ? (
        <div className="text-center py-12">
          <p className="text-text-secondary">
            <Button variant="link" onClick={() => navigate('/inbox')}>Go to Inbox</Button>
            {' '}to manage conversations
          </p>
        </div>
      ) : (
      <Tabs value={activeTab} onValueChange={(value) => setActiveTab(value as typeof activeTab)}>
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="agents">Agents</TabsTrigger>
          <TabsTrigger value="chats">Chats</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="space-y-6">
          {/* Chat Volume Chart */}
          <Card variant="glass">
            <CardHeader>
              <h3 className="text-lg font-semibold text-text-primary">Chat Volume</h3>
            </CardHeader>
            <CardContent>
              {isLoadingTimeseries ? (
                <ChartSkeleton height={300} />
              ) : (
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
              )}
            </CardContent>
          </Card>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Response Time Chart */}
            <Card variant="glass">
              <CardHeader>
                <h3 className="text-lg font-semibold text-text-primary">Average Response Time</h3>
              </CardHeader>
              <CardContent>
                {/* TODO: wire when daily breakdown API available */}
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
              </CardContent>
            </Card>

            {/* Resolution Distribution */}
            <Card variant="glass">
              <CardHeader>
                <h3 className="text-lg font-semibold text-text-primary">Resolution Distribution</h3>
              </CardHeader>
              <CardContent>
                {isLoadingMetrics ? (
                  <ChartSkeleton height={250} />
                ) : (
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
                )}
              </CardContent>
            </Card>
          </div>

          {/* CSAT Distribution */}
          <Card variant="glass">
            <CardHeader>
              <h3 className="text-lg font-semibold text-text-primary">CSAT Distribution</h3>
            </CardHeader>
            <CardContent>
              {/* TODO: wire when daily breakdown API available */}
              <ResponsiveContainer width="100%" height={200}>
                <BarChart data={csatData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#2a2d3e" />
                  <XAxis dataKey="rating" stroke="#6b7194" />
                  <YAxis stroke="#6b7194" />
                  <Tooltip contentStyle={chartTooltipStyle} />
                  <Bar dataKey="count" fill="#fbbf24" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="agents">
          <Card variant="glass" className="overflow-hidden">
            <CardHeader className="border-b border-edge">
              <h3 className="text-lg font-semibold text-text-primary">Agent Performance</h3>
            </CardHeader>
            <CardContent className="p-0">
              {isLoadingAgents ? (
                <TableSkeleton />
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Agent</TableHead>
                      <TableHead>Chats Handled</TableHead>
                      <TableHead>Avg Response Time</TableHead>
                      <TableHead>CSAT Score</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {agentPerformanceData.map((agent, index) => (
                      <TableRow key={index}>
                        <TableCell className="font-medium">{agent.name}</TableCell>
                        <TableCell>{agent.chats}</TableCell>
                        <TableCell>{agent.responseTime}s</TableCell>
                        <TableCell>
                          <div className="flex items-center gap-2">
                            <Star className="w-4 h-4 text-accent-400 fill-accent-400" />
                            <span>{agent.csat}</span>
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="chats">
          <Card variant="glass">
            <CardContent className="p-6">
              <h3 className="text-lg font-semibold text-text-primary mb-4">Chat Analysis</h3>
              <p className="text-text-secondary">Detailed chat analysis coming soon...</p>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
      )}
    </div>
  );
};

export default Analytics;
