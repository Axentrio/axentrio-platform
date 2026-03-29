import React, { useState } from 'react';
import { BookOpen, Settings2, CheckCircle2, Loader2, AlertCircle, Database, Clock, MessageSquare, X, MoreVertical, Upload } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { useAppAuth } from '@/auth/useAppAuth';
import { useKnowledgeStats, useGetAiSettings, useUpdateAiSettings } from '@/queries/useKnowledgeQueries';
import { timeAgo } from '@/utils/timeAgo';
import DocumentsTab from './knowledge/DocumentsTab';
import AiSettingsTab from './knowledge/AiSettingsTab';
import TestChatPanel from './knowledge/TestChatPanel';
import AddDocumentModal from './knowledge/AddDocumentModal';

const KnowledgeBase: React.FC = () => {
  const { isRole } = useAppAuth();
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isTestChatOpen, setIsTestChatOpen] = useState(false);
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const [showAddDoc, setShowAddDoc] = useState(false);
  const [activeFilter, setActiveFilter] = useState<string | undefined>();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: stats, isLoading: statsLoading } = useKnowledgeStats() as { data: any; isLoading: boolean };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: aiSettings, isLoading: aiLoading } = useGetAiSettings() as { data: any; isLoading: boolean };
  const updateSettings = useUpdateAiSettings();

  const documents = stats?.documents || {};
  const indexed = parseInt(documents.indexed || '0');
  const processing = parseInt(documents.processing || '0');
  const failed = parseInt(documents.failed || '0');
  const pending = parseInt(documents.pending || '0');
  const total = indexed + processing + failed + pending;

  const hasAiConfigured = aiSettings?.enabled && aiSettings?.hasApiKey;
  const queriesReady = !statsLoading && !aiLoading;
  const hasIndexedDocs = indexed > 0;

  const statItems = [
    { label: 'Total', value: total, icon: Database, color: 'text-primary-400', bg: 'bg-primary-400/10', filterKey: undefined as string | undefined },
    { label: 'Indexed', value: indexed, icon: CheckCircle2, color: 'text-emerald-400', bg: 'bg-emerald-400/10', filterKey: 'indexed', onClick: indexed > 0 ? () => setActiveFilter('indexed') : undefined },
    { label: 'Processing', value: processing, icon: Loader2, color: 'text-amber-400', bg: 'bg-amber-400/10', animate: processing > 0, filterKey: 'processing', onClick: processing > 0 ? () => setActiveFilter('processing') : undefined },
    { label: 'Failed', value: failed, icon: AlertCircle, color: 'text-red-400', bg: 'bg-red-400/10', filterKey: 'failed', onClick: failed > 0 ? () => setActiveFilter('failed') : undefined },
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
              <p className="text-xs text-text-muted">Manage documents and configure your AI bot</p>
            </div>
          </div>
          {isRole(['admin', 'supervisor']) && (
            <div className="flex items-center gap-2">
              {isRole('admin') && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setIsTestChatOpen(true)}
                  disabled={!aiSettings?.enabled}
                  title={!aiSettings?.enabled ? 'Enable AI bot first' : 'Test your AI bot'}
                  className="gap-1.5"
                >
                  <MessageSquare className="w-3.5 h-3.5" />
                  Test Chat
                </Button>
              )}
              <Button
                variant="outline"
                size="sm"
                onClick={() => setIsSettingsOpen(true)}
                className="gap-1.5"
              >
                <Settings2 className="w-3.5 h-3.5" />
                AI Settings
              </Button>
            </div>
          )}
        </div>
      </div>

      {/* Unified first-time empty state */}
      {queriesReady && total === 0 && !hasAiConfigured && isRole('admin') && (
        <div className="px-6 pb-4">
          <div className="flex flex-col items-center text-center py-12">
            <div className="p-4 rounded-2xl bg-primary-500/5 mb-5">
              <BookOpen className="w-10 h-10 text-primary-400/60" />
            </div>
            <h2 className="text-lg font-semibold text-text-primary">Set up your Knowledge Base</h2>
            <p className="text-sm text-text-muted mt-2 max-w-md leading-relaxed">
              Add documents and configure AI to start answering visitor questions automatically.
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-6 w-full max-w-lg">
              <button
                onClick={() => setShowAddDoc(true)}
                className="flex items-start gap-3 p-4 rounded-xl bg-surface-2 hover:bg-surface-3 transition-colors text-left"
              >
                <div className="p-2 rounded-lg bg-primary-500/10 flex-shrink-0">
                  <Upload className="w-4 h-4 text-primary-400" />
                </div>
                <div>
                  <p className="text-sm font-medium text-text-primary">Add your first document</p>
                  <p className="text-xs text-text-muted mt-0.5">Upload PDFs, paste text, or add FAQs</p>
                </div>
              </button>
              <button
                onClick={() => setIsSettingsOpen(true)}
                className="flex items-start gap-3 p-4 rounded-xl bg-surface-2 hover:bg-surface-3 transition-colors text-left"
              >
                <div className="p-2 rounded-lg bg-primary-500/10 flex-shrink-0">
                  <Settings2 className="w-4 h-4 text-primary-400" />
                </div>
                <div>
                  <p className="text-sm font-medium text-text-primary">Configure AI</p>
                  <p className="text-xs text-text-muted mt-0.5">Choose provider, set brand voice</p>
                </div>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Stats + Documents (when not in unified empty state) */}
      {!(queriesReady && total === 0 && !hasAiConfigured && isRole('admin')) && (
        <>
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
                      } ${activeFilter === stat.filterKey && stat.filterKey ? 'ring-1 ring-primary-500/40 bg-surface-3' : ''}`}
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
                    {stats?.lastIndexedAt ? timeAgo(stats.lastIndexedAt) : 'Never'}
                  </p>
                  <p className="text-[10px] text-text-muted leading-none mt-0.5">Last indexed</p>
                </div>
              </div>
            </div>
          </div>

          {/* Documents */}
          <div className="px-6">
            <DocumentsTab
              initialFilter={activeFilter}
              onFilterChange={(f) => setActiveFilter(f === 'all' ? undefined : f)}
              showAiBanner={queriesReady && total > 0 && !hasAiConfigured && isRole(['admin', 'supervisor'])}
              onConfigureAi={() => setIsSettingsOpen(true)}
            />
          </div>
        </>
      )}

      <div className="h-6" />

      {/* AI Settings Slide-over */}
      {isSettingsOpen && (
        <>
          <div className="fixed inset-0 bg-black/30 z-40" onClick={() => setIsSettingsOpen(false)} />
          <div className="fixed top-0 right-0 h-full w-full max-w-lg bg-surface-0 border-l border-edge z-50 flex flex-col shadow-2xl animate-in slide-in-from-right duration-200">
            <div className="flex items-center justify-between px-5 py-4 border-b border-edge">
              <div className="flex items-center gap-2.5">
                <div className="p-1.5 rounded-lg bg-primary-500/10">
                  <Settings2 className="w-4 h-4 text-primary-400" />
                </div>
                <h2 className="text-sm font-semibold text-text-primary">AI Settings</h2>
              </div>
              <div className="flex items-center gap-1">
                {isRole('admin') && (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="icon" className="h-7 w-7">
                        <MoreVertical className="w-4 h-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onClick={() => setShowResetConfirm(true)} className="text-red-400">
                        Reset AI Settings
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                )}
                <Button variant="ghost" size="icon" onClick={() => setIsSettingsOpen(false)}>
                  <X className="w-4 h-4" />
                </Button>
              </div>
            </div>
            <div className="flex-1 overflow-y-auto px-5 pb-6">
              <AiSettingsTab />
            </div>

            {/* Reset Confirmation */}
            <AlertDialog open={showResetConfirm} onOpenChange={setShowResetConfirm}>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Reset AI Settings</AlertDialogTitle>
                  <AlertDialogDescription>
                    This will disable the AI bot and clear all configuration. This cannot be undone.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction
                    className="bg-red-500 hover:bg-red-600"
                    onClick={() => {
                      updateSettings.mutate({
                        enabled: false,
                        apiKey: null,
                        brandVoice: { name: 'AI Assistant', tone: 'friendly', customInstructions: '' },
                        guardrails: { greetingMessage: '', confidenceThreshold: 0.7, maxResponseLength: 500, escalationKeywords: [], topicsToAvoid: [], fallbackMessage: '', offHoursMessage: '' },
                      });
                      setShowResetConfirm(false);
                    }}
                  >
                    Reset
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        </>
      )}

      {/* Test Chat Panel */}
      {isRole('admin') && (
        <TestChatPanel
          isOpen={isTestChatOpen}
          onClose={() => setIsTestChatOpen(false)}
          botName={aiSettings?.brandVoice?.name || 'AI Assistant'}
          provider={aiSettings?.provider || 'openai'}
          model={aiSettings?.model || ''}
          hasIndexedDocs={hasIndexedDocs}
        />
      )}

      {/* Add Document Modal (for unified empty state) */}
      <AddDocumentModal isOpen={showAddDoc} onClose={() => setShowAddDoc(false)} />
    </div>
  );
};

export default KnowledgeBase;
