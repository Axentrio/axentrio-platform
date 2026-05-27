/**
 * Admin Analytics Page
 * Super admin view: platform-wide stats and per-tenant breakdown.
 */

import React from 'react';
import { useTranslation } from 'react-i18next';
import { useAdminAnalytics } from '../../queries/useAdminQueries';
import { Loader2, Building2, Users, Activity, MessageSquare } from 'lucide-react';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from '@/components/ui/table';

/* ------------------------------------------------------------------ */
/*  Types                                                               */
/* ------------------------------------------------------------------ */

interface TenantBreakdownRow {
  tenantId: string;
  name: string;
  tier: string;
  userCount: string;
  sessionCount: string;
}

interface AdminAnalyticsData {
  totalTenants: number;
  totalUsers: number;
  totalSessions: number;
  activeSessions: number;
  messagesToday: number;
  tenantBreakdown: TenantBreakdownRow[];
}


/* ------------------------------------------------------------------ */
/*  Helpers                                                             */
/* ------------------------------------------------------------------ */

function tierBadgeClass(tier: string): string {
  switch (tier.toLowerCase()) {
    case 'enterprise':
      return 'bg-accent-500/10 text-accent-400 border-accent-500/20';
    case 'pro':
      return 'bg-primary-600/10 text-primary-400 border-primary-600/20';
    default:
      return 'bg-surface-3 text-text-muted border-edge';
  }
}

/* ------------------------------------------------------------------ */
/*  Sub-component: stat card                                            */
/* ------------------------------------------------------------------ */

interface StatCardProps {
  label: string;
  value: number | string;
  icon: React.ElementType;
  iconColor: string;
  iconBg: string;
}

const StatCard: React.FC<StatCardProps> = ({ label, value, icon: Icon, iconColor, iconBg }) => (
  <Card variant="glass">
    <CardContent className="p-6">
      <div className="flex items-start justify-between">
        <div>
          <p className="text-sm font-medium text-text-secondary">{label}</p>
          <p className="text-3xl font-bold font-mono text-text-primary mt-1">
            {typeof value === 'number' ? value.toLocaleString() : value}
          </p>
        </div>
        <div className={`p-3 rounded-xl ${iconBg}`}>
          <Icon className={`w-6 h-6 ${iconColor}`} />
        </div>
      </div>
    </CardContent>
  </Card>
);

/* ------------------------------------------------------------------ */
/*  Component                                                           */
/* ------------------------------------------------------------------ */

const AdminAnalytics: React.FC = () => {
  const { t } = useTranslation();
  const { data, isLoading, isError } = useAdminAnalytics();

  const analytics = data as AdminAnalyticsData | undefined;

  /* ---- Summary cards config ---- */
  const stats: StatCardProps[] = analytics
    ? [
        {
          label: t('admin.analytics.metrics.totalTenants'),
          value: analytics.totalTenants,
          icon: Building2,
          iconColor: 'text-primary-400',
          iconBg: 'bg-primary-600/10',
        },
        {
          label: t('admin.analytics.metrics.totalUsers'),
          value: analytics.totalUsers,
          icon: Users,
          iconColor: 'text-status-online',
          iconBg: 'bg-status-online/10',
        },
        {
          label: t('admin.analytics.metrics.activeSessions'),
          value: analytics.activeSessions,
          icon: Activity,
          iconColor: 'text-accent-400',
          iconBg: 'bg-accent-500/10',
        },
        {
          label: t('admin.analytics.metrics.messagesToday'),
          value: analytics.messagesToday,
          icon: MessageSquare,
          iconColor: 'text-chat-bot',
          iconBg: 'bg-chat-bot/10',
        },
      ]
    : [];

  /* ---- Render ---- */
  return (
    <div className="h-full overflow-y-auto p-6">
      {/* Header */}
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-text-primary">{t('admin.analytics.header.title')}</h1>
        <p className="text-text-secondary mt-1">{t('admin.analytics.header.subtitle')}</p>
      </div>

      {/* Loading state */}
      {isLoading && (
        <div className="flex items-center justify-center h-48">
          <Loader2 className="w-6 h-6 animate-spin text-text-muted" />
          <span className="ml-2 text-text-secondary">{t('admin.analytics.loading')}</span>
        </div>
      )}

      {/* Error state */}
      {isError && (
        <Card variant="glass">
          <CardContent className="p-6 text-text-secondary">
            {t('admin.analytics.errorLoading')}
          </CardContent>
        </Card>
      )}

      {/* Content */}
      {analytics && (
        <>
          {/* Summary cards */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
            {stats.map((stat) => (
              <StatCard key={stat.label} {...stat} />
            ))}
          </div>

          {/* Tenant breakdown table */}
          <Card variant="glass" className="overflow-hidden">
            <CardHeader className="border-b border-edge px-6 py-4">
              <h2 className="text-lg font-semibold text-text-primary">{t('admin.analytics.breakdown.title')}</h2>
            </CardHeader>
            <CardContent className="p-0">
              {analytics.tenantBreakdown.length === 0 ? (
                <div className="p-6 text-text-muted text-center">{t('admin.analytics.breakdown.empty')}</div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t('admin.analytics.breakdown.columns.tenant')}</TableHead>
                      <TableHead>{t('admin.analytics.breakdown.columns.tier')}</TableHead>
                      <TableHead className="text-right">{t('admin.analytics.breakdown.columns.users')}</TableHead>
                      <TableHead className="text-right">{t('admin.analytics.breakdown.columns.sessions')}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {analytics.tenantBreakdown.map((row) => (
                      <TableRow key={row.tenantId}>
                        <TableCell className="font-medium text-text-primary">{row.name}</TableCell>
                        <TableCell>
                          <Badge className={tierBadgeClass(row.tier)}>
                            {t(`admin.analytics.tiers.${row.tier.toLowerCase()}`, {
                              defaultValue: row.tier.charAt(0).toUpperCase() + row.tier.slice(1),
                            })}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-right text-text-secondary font-mono">
                          {Number(row.userCount).toLocaleString()}
                        </TableCell>
                        <TableCell className="text-right text-text-secondary font-mono">
                          {Number(row.sessionCount).toLocaleString()}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>

          {/* Totals footer */}
          <p className="text-sm text-text-muted mt-3">
            {t('admin.analytics.breakdown.footer', {
              count: analytics.tenantBreakdown.length,
              sessions: analytics.totalSessions.toLocaleString(),
            })}
          </p>
        </>
      )}
    </div>
  );
};

export default AdminAnalytics;
