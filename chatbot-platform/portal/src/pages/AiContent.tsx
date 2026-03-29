import React, { useState } from 'react';
import { BookOpen, MessageSquareText, Settings2, MessageSquare, Bot, MoreVertical } from 'lucide-react';
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
import { CannedResponsesContent } from './CannedResponses';

type Tab = 'knowledge' | 'canned' | 'ai-settings';

const tabs: { key: Tab; label: string; icon: React.ElementType }[] = [
  { key: 'knowledge', label: 'Knowledge Base', icon: BookOpen },
  { key: 'canned', label: 'Canned Responses', icon: MessageSquareText },
  { key: 'ai-settings', label: 'AI Settings', icon: Settings2 },
];

const AiContent: React.FC = () => {
  const { isRole } = useAppAuth();
  const [activeTab, setActiveTab] = useState<Tab>('knowledge');
  const [isTestChatOpen, setIsTestChatOpen] = useState(false);
  const [showResetConfirm, setShowResetConfirm] = useState(false);
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
        {activeTab === 'knowledge' && (
          <DocumentsTab
            initialFilter={activeFilter}
            onFilterChange={(f) => setActiveFilter(f === 'all' ? undefined : f)}
            showAiBanner={queriesReady && total > 0 && !hasAiConfigured && isRole(['admin', 'supervisor'])}
            onConfigureAi={() => setActiveTab('ai-settings')}
          />
        )}

        {activeTab === 'canned' && (
          <CannedResponsesContent />
        )}

        {activeTab === 'ai-settings' && (
          <div className="max-w-2xl">
            <div className="flex items-center justify-between mb-4">
              <div />
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
            </div>
            <AiSettingsTab />
          </div>
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
    </div>
  );
};

export default AiContent;
