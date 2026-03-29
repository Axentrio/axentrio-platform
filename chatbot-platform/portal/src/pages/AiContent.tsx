import React, { useState } from 'react';
import { MessageSquareText, Settings2, MessageSquare, Bot, MoreVertical, Sparkles, ChevronRight } from 'lucide-react';
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
  const [showAiSettings, setShowAiSettings] = useState(false);
  const [isTestChatOpen, setIsTestChatOpen] = useState(false);
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const [activeFilter, setActiveFilter] = useState<string | undefined>();
  const [showAddDoc, setShowAddDoc] = useState(false);
  const [skipOnboarding, setSkipOnboarding] = useState(false);

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

  // Show unified onboarding when nothing is set up yet
  const showOnboarding = !skipOnboarding && queriesReady && !hasAiConfigured && total === 0 && isAdmin;

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
          {isAdminOrSupervisor && !showOnboarding && (
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
          <>
            {showOnboarding ? (
              /* Unified onboarding — single flow, one CTA per step */
              <div className="max-w-lg mx-auto py-12">
                <div className="text-center mb-8">
                  <div className="inline-flex p-3 rounded-2xl bg-primary-500/5 mb-4">
                    <Sparkles className="w-8 h-8 text-primary-400" />
                  </div>
                  <h2 className="text-xl font-semibold text-text-primary">Get your AI bot up and running</h2>
                  <p className="text-sm text-text-muted mt-2 max-w-sm mx-auto">
                    Two steps to start answering your visitors' questions automatically.
                  </p>
                </div>

                <div className="space-y-3">
                  {/* Step 1: Configure AI */}
                  <button
                    onClick={() => { setSkipOnboarding(true); setShowAiSettings(true); }}
                    className="w-full flex items-center gap-4 p-4 rounded-xl border border-edge bg-surface-0 hover:bg-surface-2 hover:border-primary-500/30 transition-all group text-left"
                  >
                    <div className="flex-shrink-0 w-10 h-10 rounded-xl bg-primary-500/10 flex items-center justify-center">
                      <span className="text-sm font-bold text-primary-400">1</span>
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-text-primary">Connect your AI provider</p>
                      <p className="text-xs text-text-muted mt-0.5">Choose OpenAI or Anthropic, add your API key, and customize your bot's personality.</p>
                    </div>
                    <ChevronRight className="w-4 h-4 text-text-muted group-hover:text-primary-400 transition-colors flex-shrink-0" />
                  </button>

                  {/* Step 2: Add documents */}
                  <button
                    onClick={() => { setSkipOnboarding(true); setShowAddDoc(true); }}
                    className="w-full flex items-center gap-4 p-4 rounded-xl border border-edge bg-surface-0 hover:bg-surface-2 hover:border-primary-500/30 transition-all group text-left"
                  >
                    <div className="flex-shrink-0 w-10 h-10 rounded-xl bg-primary-500/10 flex items-center justify-center">
                      <span className="text-sm font-bold text-primary-400">2</span>
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-text-primary">Add knowledge base documents</p>
                      <p className="text-xs text-text-muted mt-0.5">Upload PDFs, paste text, or add FAQs so your bot can answer accurately.</p>
                    </div>
                    <ChevronRight className="w-4 h-4 text-text-muted group-hover:text-primary-400 transition-colors flex-shrink-0" />
                  </button>
                </div>

                <p className="text-xs text-text-muted text-center mt-6">
                  You can do these in any order — both are needed for your bot to work.
                </p>
              </div>
            ) : (
              /* Normal view — AI Settings collapsible + Documents */
              <div className="space-y-6">
                {/* AI Settings — collapsible section */}
                {isAdminOrSupervisor && (
                  <div className="border border-edge rounded-xl overflow-hidden">
                    <button
                      onClick={() => setShowAiSettings(!showAiSettings)}
                      className="w-full flex items-center justify-between px-4 py-3 bg-surface-2 hover:bg-surface-3 transition-colors"
                    >
                      <div className="flex items-center gap-2">
                        <Settings2 className="w-4 h-4 text-text-muted" />
                        <span className="text-sm font-medium text-text-primary">AI Settings</span>
                        {aiSettings?.enabled && (
                          <span className="px-1.5 py-0.5 text-xs rounded-full bg-status-online/10 text-status-online">Active</span>
                        )}
                        {!aiSettings?.enabled && queriesReady && (
                          <span className="px-1.5 py-0.5 text-xs rounded-full bg-accent-500/10 text-accent-400">Not configured</span>
                        )}
                      </div>
                      <div className="flex items-center gap-2">
                        {isAdmin && showAiSettings && (
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button variant="ghost" size="icon" className="h-7 w-7" onClick={(e) => e.stopPropagation()}>
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
                        <svg className={`w-4 h-4 text-text-muted transition-transform ${showAiSettings ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" /></svg>
                      </div>
                    </button>
                    {showAiSettings && (
                      <div className="px-4 py-4 border-t border-edge">
                        <div className="max-w-2xl">
                          <AiSettingsTab />
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {/* Knowledge Base documents */}
                <DocumentsTab
                  initialFilter={activeFilter}
                  onFilterChange={(f) => setActiveFilter(f === 'all' ? undefined : f)}
                  showAiBanner={queriesReady && total > 0 && !hasAiConfigured && isAdminOrSupervisor}
                  onConfigureAi={() => setShowAiSettings(true)}
                />
              </div>
            )}
          </>
        )}

        {activeTab === 'canned' && (
          <CannedResponsesContent />
        )}
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

      {/* Add Document Modal — used by onboarding */}
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
