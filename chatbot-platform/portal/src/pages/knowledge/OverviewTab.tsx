import React from 'react';
import { Card } from '@/components/ui/card';
import { FileText, CheckCircle2, Loader2, AlertCircle, Database, Activity, Clock } from 'lucide-react';
import { useKnowledgeStats } from '@/queries/useKnowledgeQueries';
import { PageSkeleton } from '@/components/ui/page-skeleton';
import { InlineError } from '@/components/ui/inline-error';

interface OverviewTabProps {
  onNavigateToDocuments: (filter?: string) => void;
}

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

const OverviewTab: React.FC<OverviewTabProps> = ({ onNavigateToDocuments }) => {
  const { data: stats, isLoading, error } = useKnowledgeStats();

  if (isLoading) return <PageSkeleton variant="cards" />;
  if (error) return <InlineError message="Failed to load stats" />;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const documents = (stats as any)?.documents || {};
  const indexed = parseInt(documents.indexed || '0');
  const processing = parseInt(documents.processing || '0');
  const failed = parseInt(documents.failed || '0');
  const pending = parseInt(documents.pending || '0');
  const total = indexed + processing + failed + pending;
  const indexedPercent = total > 0 ? Math.round((indexed / total) * 100) : 0;

  const statCards = [
    {
      label: 'Total Documents',
      value: total,
      icon: FileText,
      iconColor: 'text-primary-400',
      iconBg: 'bg-primary-400/10',
    },
    {
      label: 'Indexed',
      value: indexed,
      icon: CheckCircle2,
      iconColor: 'text-emerald-400',
      iconBg: 'bg-emerald-400/10',
      suffix: total > 0 ? `${indexedPercent}%` : undefined,
    },
    {
      label: 'Processing',
      value: processing,
      icon: Loader2,
      iconColor: 'text-amber-400',
      iconBg: 'bg-amber-400/10',
      animate: processing > 0,
    },
    {
      label: 'Failed',
      value: failed,
      icon: AlertCircle,
      iconColor: 'text-red-400',
      iconBg: 'bg-red-400/10',
      onClick: failed > 0 ? () => onNavigateToDocuments('failed') : undefined,
    },
  ];

  return (
    <div className="space-y-5 mt-5">
      {/* Stat Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {statCards.map((stat) => {
          const IconComponent = stat.icon;
          return (
            <Card
              key={stat.label}
              className={`p-4 ${stat.onClick ? 'cursor-pointer hover:shadow-card-hover hover:-translate-y-0.5 transition-all duration-200' : ''}`}
              onClick={stat.onClick}
            >
              <div className="flex items-center justify-between mb-3">
                <div className={`p-1.5 rounded-lg ${stat.iconBg}`}>
                  <IconComponent className={`w-3.5 h-3.5 ${stat.iconColor} ${stat.animate ? 'animate-spin' : ''}`} />
                </div>
                {stat.suffix && (
                  <span className="text-[10px] font-medium text-emerald-400 bg-emerald-400/10 px-1.5 py-0.5 rounded-full">
                    {stat.suffix}
                  </span>
                )}
              </div>
              <p className="text-2xl font-bold text-text-primary">{stat.value}</p>
              <p className="text-[11px] text-text-muted mt-0.5">{stat.label}</p>
            </Card>
          );
        })}
      </div>

      {/* Index Progress */}
      {total > 0 && (
        <Card className="p-4">
          <div className="flex items-center justify-between mb-2">
            <p className="text-xs font-medium text-text-secondary">Indexing Progress</p>
            <p className="text-xs text-text-muted">{indexed} of {total} documents</p>
          </div>
          <div className="h-2 rounded-full bg-surface-3 overflow-hidden">
            <div
              className="h-full rounded-full bg-emerald-400 transition-all duration-500"
              style={{ width: `${indexedPercent}%` }}
            />
          </div>
        </Card>
      )}

      {/* System Info */}
      <Card className="p-4">
        <div className="grid grid-cols-3 gap-6">
          <div className="flex items-center gap-3">
            <div className="p-1.5 rounded-lg bg-surface-3">
              <Database className="w-3.5 h-3.5 text-text-muted" />
            </div>
            <div>
              <p className="text-sm font-medium text-text-primary">{(stats as any)?.totalChunks || 0}</p>
              <p className="text-[11px] text-text-muted">Total Chunks</p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <div className="p-1.5 rounded-lg bg-surface-3">
              <Activity className="w-3.5 h-3.5 text-text-muted" />
            </div>
            <div>
              <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${
                (stats as any)?.status === 'active'
                  ? 'bg-emerald-400/10 text-emerald-400'
                  : 'bg-surface-3 text-text-muted'
              }`}>
                {(stats as any)?.status === 'active' ? 'Active' : 'Inactive'}
              </span>
              <p className="text-[11px] text-text-muted mt-1">KB Status</p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <div className="p-1.5 rounded-lg bg-surface-3">
              <Clock className="w-3.5 h-3.5 text-text-muted" />
            </div>
            <div>
              <p className="text-sm font-medium text-text-primary">
                {(stats as any)?.lastIndexedAt ? timeAgo((stats as any).lastIndexedAt) : 'Never'}
              </p>
              <p className="text-[11px] text-text-muted">Last Indexed</p>
            </div>
          </div>
        </div>
      </Card>
    </div>
  );
};

export default OverviewTab;
