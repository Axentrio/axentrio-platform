import React, { useState } from 'react';
import { MessageSquareText, Settings2, MessageSquare, Bot, MoreVertical, X } from 'lucide-react';
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
import DocumentsTab from './knowledge/DocumentsTab';
import AiSettingsTab from './knowledge/AiSettingsTab';
import TestChatPanel from './knowledge/TestChatPanel';
import AddDocumentModal from './knowledge/AddDocumentModal';
import { CannedResponsesContent } from './CannedResponses';

type Tab = 'bot' | 'canned';

const tabs: { key: Tab; label: string; icon: React.ElementType }[] = [
  { key: 'bot', label: 'AI Bot', icon: Bot },
  { key: 'canned', label: 'Canned Responses', icon: MessageSquareText },
];

const AiContent: React.FC = () => {
  const { isRole } = useAppAuth();
  const [activeTab, setActiveTab] = useState<Tab>('bot');
  const [isSettingsPanelOpen, setIsSettingsPanelOpen] = useState(false);
  const [isTestChatOpen, setIsTestChatOpen] = useState(false);
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const [activeFilter, setActiveFilter] = useState<string | undefined>();
  const [showAddDoc, setShowAddDoc] = useState(false);
  const [skipInlineSetup, setSkipInlineSetup] = useState(false);

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
  const isAdmin = isRole('admin');
  const isAdminOrSupervisor = isRole(['admin', 'supervisor']);

  // When AI is not configured and no documents: show inline setup as primary content
  const showInlineSetup = !skipInlineSetup && queriesReady && !hasAiConfigured && isAdmin;

  const providerLabel = aiSettings?.provider === 'anthropic' ? 'Anthropic' : 'OpenAI';
  const modelLabel = aiSettings?.model || 'Not set';

  return (
    <div className="h-full overflow-y-auto">
      {/* Header */}
      <div className="px-6 pt-6 pb-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-xl bg-primary-500/10">
              <Bot className="w-5 h-5 text-primary-400" />
            </div>
            <div>
              <h1 className="text-lg font-semibold text-text-primary">AI & Content</h1>
              <p className="text-xs text-text-muted">Knowledge base, canned responses, and AI configuration</p>
            </div>
          </div>
          {isAdminOrSupervisor && (
            <div className="flex items-center gap-2">
              {isAdmin && (
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
            </div>
          )}
        </div>
      </div>

      {/* Tabs */}
      <div className="px-6 border-b border-edge">
        <div className="flex gap-1">
          {tabs.map((tab) => {
            const Icon = tab.icon;
            const isActive = activeTab === tab.key;
            return (
              <button
                key={tab.key}
                onClick={() => setActiveTab(tab.key)}
                className={`flex items-center gap-1.5 px-3 py-2 text-sm font-medium border-b-2 transition-colors ${
                  isActive
                    ? 'border-primary-500 text-primary-400'
                    : 'border-transparent text-text-muted hover:text-text-secondary'
                }`}
              >
                <Icon className="w-3.5 h-3.5" />
                {tab.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Tab Content */}
      <div className="px-6 py-4">
        {activeTab === 'bot' && (
          <div className="space-y-4">
            {showInlineSetup && total === 0 ? (
              /* ── Not configured + no documents: inline setup form ── */
              <div className="max-w-2xl">
                <div className="mb-6">
                  <h2 className="text-base font-semibold text-text-primary">Configure your AI bot</h2>
                  <p className="text-sm text-text-muted mt-1">
                    Set up a provider and add documents to start answering visitors automatically.
                  </p>
                </div>
                <AiSettingsTab />
                <div className="mt-4 pt-4 border-t border-edge">
                  <button
                    onClick={() => setSkipInlineSetup(true)}
                    className="text-xs text-text-muted hover:text-text-secondary transition-colors"
                  >
                    Skip to documents →
                  </button>
                </div>
              </div>
            ) : (
              /* ── Normal view: status bar + documents ── */
              <>
                {/* AI Status Bar — compact, clickable to open slide-over */}
                {isAdminOrSupervisor && (
                  <button
                    onClick={() => setIsSettingsPanelOpen(true)}
                    className="w-full flex items-center justify-between px-4 py-2.5 rounded-xl bg-surface-2 hover:bg-surface-3 transition-colors group"
                  >
                    <div className="flex items-center gap-3">
                      <Settings2 className="w-4 h-4 text-text-muted" />
                      {hasAiConfigured ? (
                        <>
                          <div className="flex items-center gap-1.5">
                            <span className="w-1.5 h-1.5 rounded-full bg-status-online" />
                            <span className="text-sm text-text-primary">{providerLabel}</span>
                          </div>
                          <span className="text-xs text-text-muted">{modelLabel}</span>
                          {aiSettings?.brandVoice?.name && aiSettings.brandVoice.name !== 'AI Assistant' && (
                            <>
                              <span className="text-text-muted">·</span>
                              <span className="text-xs text-text-muted">{aiSettings.brandVoice.name}</span>
                            </>
                          )}
                        </>
                      ) : (
                        <>
                          <div className="flex items-center gap-1.5">
                            <span className="w-1.5 h-1.5 rounded-full bg-accent-400" />
                            <span className="text-sm text-text-secondary">AI not configured</span>
                          </div>
                        </>
                      )}
                    </div>
                    <span className="text-xs text-text-muted group-hover:text-primary-400 transition-colors">
                      Configure →
                    </span>
                  </button>
                )}

                {/* Knowledge Base documents */}
                <DocumentsTab
                  initialFilter={activeFilter}
                  onFilterChange={(f) => setActiveFilter(f === 'all' ? undefined : f)}
                  showAiBanner={queriesReady && total > 0 && !hasAiConfigured && isAdminOrSupervisor}
                  onConfigureAi={() => setIsSettingsPanelOpen(true)}
                />
              </>
            )}
          </div>
        )}

        {activeTab === 'canned' && (
          <CannedResponsesContent />
        )}
      </div>

      {/* AI Settings Slide-over Panel */}
      {isSettingsPanelOpen && (
        <div className="fixed inset-0 z-50 flex justify-end">
          <div
            className="absolute inset-0 bg-black/40"
            onClick={() => setIsSettingsPanelOpen(false)}
          />
          <div className="relative w-full max-w-lg bg-surface-0 border-l border-edge shadow-2xl flex flex-col overflow-hidden">
            {/* Panel header */}
            <div className="flex items-center justify-between px-5 py-4 border-b border-edge flex-shrink-0">
              <div className="flex items-center gap-2">
                <Settings2 className="w-4 h-4 text-text-muted" />
                <h2 className="text-sm font-semibold text-text-primary">AI Settings</h2>
              </div>
              <div className="flex items-center gap-1">
                {isAdmin && (
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
                <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => setIsSettingsPanelOpen(false)}>
                  <X className="w-4 h-4" />
                </Button>
              </div>
            </div>
            {/* Panel body */}
            <div className="flex-1 overflow-y-auto px-5 py-4">
              <AiSettingsTab />
            </div>
          </div>
        </div>
      )}

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
                setIsSettingsPanelOpen(false);
              }}
            >
              Reset
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Add Document Modal */}
      <AddDocumentModal
        isOpen={showAddDoc}
        onClose={() => setShowAddDoc(false)}
      />

      {/* Test Chat Panel */}
      {isAdmin && (
        <TestChatPanel
          isOpen={isTestChatOpen}
          onClose={() => setIsTestChatOpen(false)}
          botName={aiSettings?.brandVoice?.name || 'AI Assistant'}
          provider={aiSettings?.provider || 'openai'}
          model={aiSettings?.model || ''}
          hasIndexedDocs={hasIndexedDocs}
        />
      )}
    </div>
  );
};

export default AiContent;
