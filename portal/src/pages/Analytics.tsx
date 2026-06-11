/**
 * Analytics Page
 * Business outcomes (conversations, bookings, leads — with vs-previous-period
 * deltas) over chat volume and bot vs human resolution. Response-time and
 * CSAT visuals return once their data sources are actually instrumented
 * (see .scratch/plan-success-meter.md / .scratch/plan-insights-tiering.md P1).
 */

import React, { useState, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import {
  useAnalyticsTimeseries,
  useAnalyticsChatMetrics,
  useAnalyticsOutcomes,
  useAnalyticsOutcomesTimeseries,
} from '../queries/useAnalyticsQueries';
import { useDashboardMetrics } from '../queries/useDashboardQueries';
import { useHasFeature } from '../queries/useEntitlementsQueries';
import { useAppAuth } from '@auth/useAppAuth';
import {
  PieChart,
  Pie,
  Cell,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
  AreaChart,
  Area,
} from 'recharts';
import { MessageSquare, Clock, Star, TrendingUp, CalendarCheck, UserPlus, Moon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { OnboardingBanner } from '@/components/dashboard/OnboardingBanner';
import { Card, CardHeader, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

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
  /** Closed sessions a human agent resolved (assigned_agent_id set). */
  humanResolved: number;
  avgDurationSeconds: number;
}

interface OutcomeBucket {
  total: number;
  byChannel?: Record<string, number>;
  bySource?: Record<string, number>;
}

interface OutcomeAggregates {
  conversations: OutcomeBucket;
  bookings: OutcomeBucket;
  leads: OutcomeBucket;
  /** null when the tenant has no scheduler business hours to classify against. */
  afterHours: { count: number; classifiable: number } | null;
}

interface OutcomesResponse {
  range: { from: string; to: string };
  previousRange: { from: string; to: string };
  current: OutcomeAggregates;
  previous: OutcomeAggregates;
}

interface OutcomeSeriesPoint {
  date: string;
  conversations: number;
  bookings: number;
  leads: number;
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

const chartTooltipStyle = {
  backgroundColor: '#1e2030',
  border: '1px solid #2a2d3e',
  borderRadius: '12px',
  color: '#f1f3f9',
};

const Analytics: React.FC = () => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { user } = useAppAuth();
  const isAgent = user?.role === 'agent';
  const hasBookings = useHasFeature('bookings');
  const [dateRange, setDateRange] = useState('7d');
  const [activeTab, setActiveTab] = useState<'overview' | 'chats'>('overview');

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

  // Business outcomes (conversations/bookings/leads + previous period)
  const {
    data: outcomesRes,
    isLoading: isLoadingOutcomes,
  } = useAnalyticsOutcomes(startDate, endDate, activeTab === 'overview');

  const {
    data: outcomesSeriesRes,
    isLoading: isLoadingOutcomesSeries,
  } = useAnalyticsOutcomesTimeseries(startDate, endDate, activeTab === 'overview');

  // Dashboard real-time metrics (sessions, agents, etc.)
  const { data: rawDashboard } = useDashboardMetrics();
  const dashboard = (rawDashboard as any)?.dashboard;

  /* ---------------------------------------------------------------- */
  /*  Derived data                                                     */
  /* ---------------------------------------------------------------- */

  const chatVolumeData: TimeseriesPoint[] = (timeseriesRes as { timeseries?: TimeseriesPoint[] })?.timeseries ?? [];

  const metrics = (metricsRes as { metrics?: ChatMetrics })?.metrics;
  const outcomes = outcomesRes as OutcomesResponse | undefined;
  const outcomesSeries: OutcomeSeriesPoint[] =
    (outcomesSeriesRes as { timeseries?: OutcomeSeriesPoint[] })?.timeseries ?? [];

  /**
   * "+23% vs previous period" / "−12% …" delta string for a stat card.
   * Empty while loading; "new" when the previous window had nothing.
   */
  const formatDelta = (current?: number, previous?: number): string => {
    if (current == null || previous == null) return '';
    if (previous === 0) {
      return current > 0
        ? `${t('analytics.outcomes.deltaNew', { defaultValue: 'new' })} ${t('analytics.outcomes.vsPrevious', { defaultValue: 'vs previous period' })}`
        : '';
    }
    const pct = Math.round(((current - previous) / previous) * 100);
    return `${pct >= 0 ? '+' : ''}${pct}% ${t('analytics.outcomes.vsPrevious', { defaultValue: 'vs previous period' })}`;
  };

  // Conversations-by-channel bar data (localised channel labels).
  const channelData = useMemo(() => {
    const byChannel = outcomes?.current?.conversations?.byChannel ?? {};
    return Object.entries(byChannel)
      .map(([channel, count]) => ({
        channel: t(`analytics.outcomes.channels.${channel}`, { defaultValue: channel }),
        count,
      }))
      .sort((a, b) => b.count - a.count);
  }, [outcomes, t]);

  // Resolution pie over closed sessions: human = closed with an agent
  // assigned (from the API), bot = the remaining closed sessions.
  const resolutionData = useMemo(() => {
    if (!metrics || metrics.closed === 0) return [];
    const humanResolved = metrics.humanResolved ?? 0;
    const botResolved = Math.max(metrics.closed - humanResolved, 0);
    const total = metrics.closed;
    return [
      { name: t('analytics.charts.resolutionDistribution.botResolved'), value: Math.round((botResolved / total) * 100), color: '#a78bfa' },
      { name: t('analytics.charts.resolutionDistribution.humanResolved'), value: Math.round((humanResolved / total) * 100), color: '#34d399' },
    ];
  }, [metrics, t]);

  // Stats cards — business outcomes for the selected range, each with a
  // vs-previous-period delta. The bookings card follows the existing
  // `bookings` feature flag (an Essential tenant has no bookings module, so
  // the card would only ever read 0). Avg Response Time and CSAT stay hidden
  // until their data sources are actually populated (response-time
  // instrumentation / rating collection) and reappear automatically.
  const hasResponseTimeData = (dashboard?.avgResponseTimeSeconds ?? 0) > 0;
  const hasCsatData = dashboard?.csatScore != null;
  const cur = outcomes?.current;
  const prev = outcomes?.previous;
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
      label: t('analytics.outcomes.kpis.conversations', { defaultValue: 'Conversations' }),
      value: cur ? cur.conversations.total.toLocaleString() : '—',
      change: formatDelta(cur?.conversations.total, prev?.conversations.total),
      icon: MessageSquare,
      color: 'text-primary-400',
      bgColor: 'bg-primary-600/10',
      onClick: () => navigate('/inbox'),
    },
    ...(hasBookings
      ? [{
          label: t('analytics.outcomes.kpis.bookings', { defaultValue: 'Bookings' }),
          value: cur ? cur.bookings.total.toLocaleString() : '—',
          change: formatDelta(cur?.bookings.total, prev?.bookings.total),
          icon: CalendarCheck,
          color: 'text-status-online',
          bgColor: 'bg-status-online/10',
          onClick: () => navigate('/bookings'),
        }]
      : []),
    {
      label: t('analytics.outcomes.kpis.leads', { defaultValue: 'Leads captured' }),
      value: cur ? cur.leads.total.toLocaleString() : '—',
      change: formatDelta(cur?.leads.total, prev?.leads.total),
      icon: UserPlus,
      color: 'text-accent-400',
      bgColor: 'bg-accent-500/10',
      onClick: () => navigate('/leads'),
    },
    // Only meaningful for tenants with scheduler business hours (null otherwise).
    ...(cur?.afterHours != null
      ? [{
          label: t('analytics.outcomes.kpis.afterHours', { defaultValue: 'After-hours conversations' }),
          value: cur.afterHours.count.toLocaleString(),
          change: formatDelta(cur.afterHours.count, prev?.afterHours?.count),
          icon: Moon,
          color: 'text-chat-bot',
          bgColor: 'bg-chat-bot/10',
        }]
      : []),
    ...(hasResponseTimeData
      ? [{
          label: t('analytics.kpis.avgResponseTime'),
          value: `${dashboard.avgResponseTimeSeconds}s`,
          change: '',
          icon: Clock,
          color: 'text-chat-bot',
          bgColor: 'bg-chat-bot/10',
        }]
      : []),
    ...(hasCsatData
      ? [{
          label: t('analytics.kpis.csatScore'),
          value: `${dashboard.csatScore}/5`,
          change: '',
          icon: Star,
          color: 'text-accent-400',
          bgColor: 'bg-accent-500/10',
        }]
      : []),
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
        </div>
      </div>

      {/* Stats Cards */}
      <div
        className={cn(
          'grid grid-cols-1 md:grid-cols-2 gap-4',
          { 2: 'lg:grid-cols-2', 3: 'lg:grid-cols-3', 4: 'lg:grid-cols-4', 5: 'lg:grid-cols-5', 6: 'lg:grid-cols-6' }[stats.length] ?? 'lg:grid-cols-4',
        )}
      >
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
          <TabsTrigger value="chats">{t('analytics.tabs.chats')}</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="space-y-6">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Outcomes over time */}
            <Card variant="glass">
              <CardHeader>
                <h3 className="text-lg font-semibold text-text-primary">
                  {t('analytics.outcomes.charts.overTime.title', { defaultValue: 'Outcomes over time' })}
                </h3>
              </CardHeader>
              <CardContent>
                {isLoadingOutcomesSeries ? (
                  <ChartSkeleton height={250} />
                ) : (
                  <ResponsiveContainer width="100%" height={250}>
                    <AreaChart data={outcomesSeries}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#2a2d3e" />
                      <XAxis dataKey="date" stroke="#6b7194" />
                      <YAxis stroke="#6b7194" allowDecimals={false} />
                      <Tooltip contentStyle={chartTooltipStyle} />
                      <Legend />
                      <Area type="monotone" dataKey="conversations" stroke="#a78bfa" fill="#a78bfa" fillOpacity={0.25} name={t('analytics.outcomes.kpis.conversations', { defaultValue: 'Conversations' })} />
                      {hasBookings && (
                        <Area type="monotone" dataKey="bookings" stroke="#34d399" fill="#34d399" fillOpacity={0.25} name={t('analytics.outcomes.kpis.bookings', { defaultValue: 'Bookings' })} />
                      )}
                      <Area type="monotone" dataKey="leads" stroke="#fbbf24" fill="#fbbf24" fillOpacity={0.25} name={t('analytics.outcomes.kpis.leads', { defaultValue: 'Leads captured' })} />
                    </AreaChart>
                  </ResponsiveContainer>
                )}
              </CardContent>
            </Card>

            {/* Conversations by channel */}
            <Card variant="glass">
              <CardHeader>
                <h3 className="text-lg font-semibold text-text-primary">
                  {t('analytics.outcomes.charts.byChannel.title', { defaultValue: 'Conversations by channel' })}
                </h3>
              </CardHeader>
              <CardContent>
                {isLoadingOutcomes ? (
                  <ChartSkeleton height={250} />
                ) : (
                  <ResponsiveContainer width="100%" height={250}>
                    <BarChart data={channelData}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#2a2d3e" />
                      <XAxis dataKey="channel" stroke="#6b7194" />
                      <YAxis stroke="#6b7194" allowDecimals={false} />
                      <Tooltip contentStyle={chartTooltipStyle} />
                      <Bar dataKey="count" fill="#818cf8" radius={[4, 4, 0, 0]} name={t('analytics.outcomes.kpis.conversations', { defaultValue: 'Conversations' })} />
                    </BarChart>
                  </ResponsiveContainer>
                )}
              </CardContent>
            </Card>
          </div>

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
