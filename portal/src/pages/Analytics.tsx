/**
 * Analytics Page
 * Response times, CSAT, bot vs human ratio
 */

import React, { useState, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
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
import { OnboardingBanner } from '@/components/dashboard/OnboardingBanner';
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
const responseTimeDataRaw = [
  { dayKey: 'mon', avg: 32, target: 30 },
  { dayKey: 'tue', avg: 28, target: 30 },
  { dayKey: 'wed', avg: 35, target: 30 },
  { dayKey: 'thu', avg: 25, target: 30 },
  { dayKey: 'fri', avg: 40, target: 30 },
  { dayKey: 'sat', avg: 22, target: 30 },
  { dayKey: 'sun', avg: 20, target: 30 },
];

// TODO: wire csatData when daily breakdown API available
const csatDataRaw = [
  { ratingKey: 'fiveStars', count: 145 },
  { ratingKey: 'fourStars', count: 68 },
  { ratingKey: 'threeStars', count: 23 },
  { ratingKey: 'twoStars', count: 12 },
  { ratingKey: 'oneStar', count: 8 },
];

const chartTooltipStyle = {
  backgroundColor: '#1e2030',
  border: '1px solid #2a2d3e',
  borderRadius: '12px',
  color: '#f1f3f9',
};

const handleExport = (format: 'csv' | 'json' | 'xlsx'): void => {
  // Implement export functionality
  console.log('Exporting as', format);
};

const Analytics: React.FC = () => {
  const { t } = useTranslation();
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
  const agents: AgentRow[] = useMemo(
    () => (agentsRes as { agents?: AgentRow[] })?.agents ?? [],
    [agentsRes],
  );

  // Resolution pie: bot resolved = closed minus human-handled, human = rest
  const resolutionData = useMemo(() => {
    if (!metrics) return [];
    const humanResolved = metrics.open; // open tickets still with humans
    const botResolved = Math.max(metrics.closed - humanResolved, 0);
    const total = botResolved + humanResolved || 1;
    return [
      { name: t('analytics.charts.resolutionDistribution.botResolved'), value: Math.round((botResolved / total) * 100), color: '#a78bfa' },
      { name: t('analytics.charts.resolutionDistribution.humanResolved'), value: Math.round((humanResolved / total) * 100), color: '#34d399' },
    ];
  }, [metrics, t]);

  // Localised response-time data (day labels for chart x-axis)
  const responseTimeData = useMemo(
    () => responseTimeDataRaw.map((p) => ({ ...p, date: t(`analytics.days.${p.dayKey}`) })),
    [t],
  );

  // Localised CSAT data (rating labels for chart x-axis)
  const csatData = useMemo(
    () => csatDataRaw.map((p) => ({ ...p, rating: t(`analytics.csat.${p.ratingKey}`) })),
    [t],
  );

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
      label: t('analytics.kpis.activeChats'),
      value: dashboard ? String((dashboard?.sessions?.active ?? 0) + (dashboard?.sessions?.bot ?? 0)) : '—',
      change: '',
      icon: MessageSquare,
      color: 'text-primary-400',
      bgColor: 'bg-primary-600/10',
      onClick: () => navigate('/inbox'),
    },
    {
      label: t('analytics.kpis.pendingHandoffs'),
      value: dashboard ? String(dashboard?.sessions?.handoff ?? 0) : '—',
      change: '',
      icon: Headphones,
      color: 'text-accent-400',
      bgColor: 'bg-accent-500/10',
      onClick: () => navigate('/inbox'),
    },
    {
      label: t('analytics.kpis.onlineAgents'),
      value: dashboard ? `${dashboard?.agents?.online ?? 0}/${dashboard?.agents?.total ?? 0}` : '—',
      change: '',
      icon: Users,
      color: 'text-status-online',
      bgColor: 'bg-status-online/10',
    },
    {
      label: t('analytics.kpis.avgResponseTime'),
      value: dashboard ? `${dashboard?.avgResponseTimeSeconds ?? 0}s` : '—',
      change: '',
      icon: Clock,
      color: 'text-chat-bot',
      bgColor: 'bg-chat-bot/10',
    },
    {
      label: t('analytics.kpis.csatScore'),
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
      label: t('analytics.kpis.totalChats'),
      value: metrics ? metrics.total.toLocaleString() : '—',
      change: '',
      icon: TrendingUp,
      color: 'text-primary-400',
      bgColor: 'bg-primary-600/10',
    },
  ];

  return (
    <div className="h-full overflow-y-auto p-6 space-y-6">
      {/* Onboarding */}
      <OnboardingBanner />

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-text-primary">{t('analytics.header.title')}</h1>
          <p className="text-text-secondary">{t('analytics.header.subtitle')}</p>
        </div>

        <div className="flex items-center gap-4">
          {/* Date Range Selector */}
          <Select value={dateRange} onValueChange={setDateRange}>
            <SelectTrigger className="w-[180px]">
              <SelectValue placeholder={t('analytics.timeRange.placeholder')} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="24h">{t('analytics.timeRange.last24Hours')}</SelectItem>
              <SelectItem value="7d">{t('analytics.timeRange.last7Days')}</SelectItem>
              <SelectItem value="30d">{t('analytics.timeRange.last30Days')}</SelectItem>
              <SelectItem value="90d">{t('analytics.timeRange.last90Days')}</SelectItem>
            </SelectContent>
          </Select>

          {/* Export Dropdown */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline">
                <Download className="w-4 h-4" />
                {t('analytics.export.button')}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => handleExport('csv')}>{t('analytics.export.csv')}</DropdownMenuItem>
              <DropdownMenuItem onClick={() => handleExport('json')}>{t('analytics.export.json')}</DropdownMenuItem>
              <DropdownMenuItem onClick={() => handleExport('xlsx')}>{t('analytics.export.excel')}</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {/* Stats Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-6 gap-4">
        {stats.map((stat, index) => (
          <Card
            key={stat.label}
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
            <Button variant="link" onClick={() => navigate('/inbox')}>{t('analytics.agentRedirect.goToInbox')}</Button>
            {' '}{t('analytics.agentRedirect.toManage')}
          </p>
        </div>
      ) : (
      <Tabs value={activeTab} onValueChange={(value) => setActiveTab(value as typeof activeTab)}>
        <TabsList>
          <TabsTrigger value="overview">{t('analytics.tabs.overview')}</TabsTrigger>
          <TabsTrigger value="agents">{t('analytics.tabs.agents')}</TabsTrigger>
          <TabsTrigger value="chats">{t('analytics.tabs.chats')}</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="space-y-6">
          {/* Chat Volume Chart */}
          <Card variant="glass">
            <CardHeader>
              <h3 className="text-lg font-semibold text-text-primary">{t('analytics.charts.chatVolume.title')}</h3>
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
                    <Area type="monotone" dataKey="bot" stackId="1" stroke="#a78bfa" fill="#a78bfa" fillOpacity={0.4} name={t('analytics.charts.chatVolume.legend.bot')} />
                    <Area type="monotone" dataKey="human" stackId="1" stroke="#34d399" fill="#34d399" fillOpacity={0.4} name={t('analytics.charts.chatVolume.legend.human')} />
                    <Area type="monotone" dataKey="handoff" stackId="1" stroke="#fbbf24" fill="#fbbf24" fillOpacity={0.4} name={t('analytics.charts.chatVolume.legend.handoff')} />
                  </AreaChart>
                </ResponsiveContainer>
              )}
            </CardContent>
          </Card>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Response Time Chart */}
            <Card variant="glass">
              <CardHeader>
                <h3 className="text-lg font-semibold text-text-primary">{t('analytics.charts.responseTime.title')}</h3>
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
                    <Line type="monotone" dataKey="avg" stroke="#818cf8" strokeWidth={2} name={t('analytics.charts.responseTime.legend.actual')} />
                    <Line type="monotone" dataKey="target" stroke="#34d399" strokeWidth={2} strokeDasharray="5 5" name={t('analytics.charts.responseTime.legend.target')} />
                  </LineChart>
                </ResponsiveContainer>
              </CardContent>
            </Card>

            {/* Resolution Distribution */}
            <Card variant="glass">
              <CardHeader>
                <h3 className="text-lg font-semibold text-text-primary">{t('analytics.charts.resolutionDistribution.title')}</h3>
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
                        {resolutionData.map((entry) => (
                          <Cell key={entry.name} fill={entry.color} />
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
              <h3 className="text-lg font-semibold text-text-primary">{t('analytics.charts.csatDistribution.title')}</h3>
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
              <h3 className="text-lg font-semibold text-text-primary">{t('analytics.agentPerformance.title')}</h3>
            </CardHeader>
            <CardContent className="p-0">
              {isLoadingAgents ? (
                <TableSkeleton />
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t('analytics.agentPerformance.columns.agent')}</TableHead>
                      <TableHead>{t('analytics.agentPerformance.columns.chatsHandled')}</TableHead>
                      <TableHead>{t('analytics.agentPerformance.columns.avgResponseTime')}</TableHead>
                      <TableHead>{t('analytics.agentPerformance.columns.csatScore')}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {agentPerformanceData.map((agent) => (
                      <TableRow key={agent.name}>
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
              <h3 className="text-lg font-semibold text-text-primary mb-4">{t('analytics.chatAnalysis.title')}</h3>
              <p className="text-text-secondary">{t('analytics.chatAnalysis.comingSoon')}</p>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
      )}
    </div>
  );
};

export default Analytics;
