import React, { useState } from 'react';
import { BookOpen, Settings2, CheckCircle2, Loader2, AlertCircle, Database, Clock } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useAppAuth } from '@/auth/useAppAuth';
import { useKnowledgeStats } from '@/queries/useKnowledgeQueries';
import DocumentsTab from './knowledge/DocumentsTab';
import AiSettingsTab from './knowledge/AiSettingsTab';

const KnowledgeBase: React.FC = () => {
  const { isRole } = useAppAuth();
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: stats } = useKnowledgeStats() as { data: any };

  const documents = stats?.documents || {};
  const indexed = parseInt(documents.indexed || '0');
  const processing = parseInt(documents.processing || '0');
  const failed = parseInt(documents.failed || '0');
  const pending = parseInt(documents.pending || '0');
  const total = indexed + processing + failed + pending;
  const [docFilter, setDocFilter] = useState<string | undefined>();

  const statItems = [
    { label: 'Total', value: total, icon: Database, color: 'text-primary-400', bg: 'bg-primary-400/10' },
    { label: 'Indexed', value: indexed, icon: CheckCircle2, color: 'text-emerald-400', bg: 'bg-emerald-400/10' },
    { label: 'Processing', value: processing, icon: Loader2, color: 'text-amber-400', bg: 'bg-amber-400/10', animate: processing > 0 },
    { label: 'Failed', value: failed, icon: AlertCircle, color: 'text-red-400', bg: 'bg-red-400/10', onClick: failed > 0 ? () => setDocFilter('failed') : undefined },
  ];

  return (
    <div className="h-full overflow-y-auto">
      {/* Header */}
      <div className="px-6 pt-6 pb-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-xl bg-primary-500/10">
              <BookOpen className="w-5 h-5 text-primary-400" />
            </div>
            <div>
              <h1 className="text-lg font-semibold text-text-primary">Knowledge Base</h1>
              <p className="text-xs text-text-muted">
                Manage documents and configure your AI bot
              </p>
            </div>
          </div>
          {isRole(['admin', 'supervisor']) && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setIsSettingsOpen(true)}
              className="gap-1.5"
            >
              <Settings2 className="w-3.5 h-3.5" />
              AI Settings
            </Button>
          )}
        </div>
      </div>

      {/* Stats Strip */}
      <div className="px-6 pb-4">
        <div className="flex items-center gap-3 p-3 rounded-xl bg-surface-2">
          {statItems.map((stat, i) => {
            const Icon = stat.icon;
            return (
              <React.Fragment key={stat.label}>
                {i > 0 && <div className="w-px h-8 bg-edge" />}
                <button
                  className={`flex items-center gap-2 px-2 py-1 rounded-lg transition-colors ${
                    stat.onClick ? 'hover:bg-surface-3 cursor-pointer' : 'cursor-default'
                  }`}
                  onClick={stat.onClick}
                  disabled={!stat.onClick}
                >
                  <div className={`p-1 rounded-md ${stat.bg}`}>
                    <Icon className={`w-3 h-3 ${stat.color} ${stat.animate ? 'animate-spin' : ''}`} />
                  </div>
                  <div className="text-left">
                    <p className="text-sm font-semibold text-text-primary leading-none">{stat.value}</p>
                    <p className="text-[10px] text-text-muted leading-none mt-0.5">{stat.label}</p>
                  </div>
                </button>
              </React.Fragment>
            );
          })}

          <div className="w-px h-8 bg-edge" />

          <div className="flex items-center gap-2 px-2">
            <div className="p-1 rounded-md bg-surface-3">
              <Clock className="w-3 h-3 text-text-muted" />
            </div>
            <div className="text-left">
              <p className="text-xs text-text-primary leading-none">
                {stats?.lastIndexedAt
                  ? timeAgo(stats.lastIndexedAt)
                  : 'Never'}
              </p>
              <p className="text-[10px] text-text-muted leading-none mt-0.5">Last indexed</p>
            </div>
          </div>
        </div>
      </div>

      {/* Documents (main content) */}
      <div className="px-6">
        <DocumentsTab initialFilter={docFilter} />
      </div>

      <div className="h-6" />

      {/* AI Settings Slide-over */}
      {isSettingsOpen && (
        <>
          <div
            className="fixed inset-0 bg-black/30 z-40"
            onClick={() => setIsSettingsOpen(false)}
          />
          <div className="fixed top-0 right-0 h-full w-full max-w-lg bg-surface-0 border-l border-edge z-50 flex flex-col shadow-2xl animate-in slide-in-from-right duration-200">
            <div className="flex items-center justify-between px-5 py-4 border-b border-edge">
              <div className="flex items-center gap-2.5">
                <div className="p-1.5 rounded-lg bg-primary-500/10">
                  <Settings2 className="w-4 h-4 text-primary-400" />
                </div>
                <h2 className="text-sm font-semibold text-text-primary">AI Settings</h2>
              </div>
              <Button variant="ghost" size="icon" onClick={() => setIsSettingsOpen(false)}>
                <span className="text-lg leading-none">&times;</span>
              </Button>
            </div>
            <div className="flex-1 overflow-y-auto px-5 pb-6">
              <AiSettingsTab />
            </div>
          </div>
        </>
      )}
    </div>
  );
};

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

export default KnowledgeBase;
