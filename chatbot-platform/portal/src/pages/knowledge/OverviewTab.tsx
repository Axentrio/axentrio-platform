import React from 'react';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { useKnowledgeStats } from '@/queries/useKnowledgeQueries';
import { PageSkeleton } from '@/components/ui/page-skeleton';
import { InlineError } from '@/components/ui/inline-error';

interface OverviewTabProps {
  onNavigateToDocuments: (filter?: string) => void;
}

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const minutes = Math.floor(diff / 60000);
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

  const documents = stats?.documents || {};
  const indexed = parseInt(documents.indexed || '0');
  const processing = parseInt(documents.processing || '0');
  const failed = parseInt(documents.failed || '0');
  const pending = parseInt(documents.pending || '0');
  const total = indexed + processing + failed + pending;

  return (
    <div className="space-y-4 mt-4">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Card className="p-5">
          <p className="text-sm text-text-muted mb-2">Total Documents</p>
          <p className="text-3xl font-bold text-text-primary">{total}</p>
        </Card>
        <Card className="p-5 border-l-4 border-l-status-online">
          <p className="text-sm text-text-muted mb-2">Indexed</p>
          <p className="text-3xl font-bold text-status-online">{indexed}</p>
        </Card>
        <Card className="p-5 border-l-4 border-l-status-away">
          <p className="text-sm text-text-muted mb-2">Processing</p>
          <p className="text-3xl font-bold text-status-away">{processing}</p>
        </Card>
        <Card className="p-5 border-l-4 border-l-status-offline">
          <p className="text-sm text-text-muted mb-2">Failed</p>
          <button
            onClick={() => onNavigateToDocuments('failed')}
            className="text-3xl font-bold text-status-offline underline hover:opacity-80"
          >
            {failed}
          </button>
        </Card>
      </div>

      <Card className="p-5">
        <div className="grid grid-cols-3 gap-6">
          <div>
            <p className="text-sm text-text-muted mb-1">Total Chunks</p>
            <p className="text-lg font-semibold text-text-primary">{stats?.totalChunks || 0}</p>
          </div>
          <div>
            <p className="text-sm text-text-muted mb-1">KB Status</p>
            <Badge variant={stats?.status === 'active' ? 'default' : 'secondary'}>
              {stats?.status === 'active' ? 'Active' : 'Inactive'}
            </Badge>
          </div>
          <div>
            <p className="text-sm text-text-muted mb-1">Last Indexed</p>
            <p className="text-sm text-text-primary">
              {stats?.lastIndexedAt
                ? timeAgo(stats.lastIndexedAt)
                : 'Never'}
            </p>
          </div>
        </div>
      </Card>
    </div>
  );
};

export default OverviewTab;
