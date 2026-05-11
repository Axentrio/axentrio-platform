import React, { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { MessageSquareText, MessageSquare, Bot, BookOpen, Palette, Share2, SlidersHorizontal } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useAppAuth } from '@/auth/useAppAuth';
import { useGetAiSettings, useKnowledgeStats } from '@/queries/useKnowledgeQueries';
import DocumentsTab from './knowledge/DocumentsTab';
import AiBotForm from './knowledge/AiBotForm';
import TestChatPanel from './knowledge/TestChatPanel';
import { CannedResponsesContent } from './CannedResponses';
import ChatbotAppearancesForm from './knowledge/ChatbotAppearancesForm';

type Tab = 'bot' | 'knowledge' | 'canned' | 'appearances' | 'social' | 'extra';

const tabs: { key: Tab; label: string; icon: React.ElementType }[] = [
  { key: 'bot', label: 'AI Bot', icon: Bot },
  { key: 'knowledge', label: 'Knowledge base', icon: BookOpen },
  { key: 'canned', label: 'Custom Responses', icon: MessageSquareText },
  { key: 'appearances', label: 'Chatbot Appearances', icon: Palette },
  { key: 'social', label: 'Social Media Integrations', icon: Share2 },
  { key: 'extra', label: 'Extra Settings', icon: SlidersHorizontal },
];

type ComingSoonProps = {
  icon: React.ElementType;
  title: string;
  description: string;
};

const ComingSoonPanel: React.FC<ComingSoonProps> = ({ icon: Icon, title, description }) => (
  <div className="flex flex-col items-center justify-center py-20 text-center">
    <div className="p-4 rounded-2xl bg-primary-500/10 mb-4">
      <Icon className="w-8 h-8 text-primary-400" />
    </div>
    <h2 className="text-base font-semibold text-text-primary mb-1">{title}</h2>
    <p className="text-sm text-text-muted max-w-md">{description}</p>
  </div>
);

const PARAM_TO_TAB: Record<string, Tab> = {
  bot: 'bot',
  knowledge: 'knowledge',
  canned: 'canned',
  appearances: 'appearances',
  social: 'social',
  extra: 'extra',
};

const AiContent: React.FC = () => {
  const { isRole } = useAppAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const [isTestChatOpen, setIsTestChatOpen] = useState(false);
  const [activeFilter, setActiveFilter] = useState<string | undefined>();

  const isAdmin = isRole('admin');
  const isAdminOrSupervisor = isRole(['admin', 'supervisor']);

  // Derive active tab directly from the URL so browser back/forward works.
  const activeTab: Tab = PARAM_TO_TAB[searchParams.get('tab') ?? ''] ?? 'bot';
  const setActiveTab = (tab: Tab) => {
    const next = new URLSearchParams(searchParams);
    next.set('tab', tab);
    setSearchParams(next, { replace: true });
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: aiSettings } = useGetAiSettings({ enabled: isAdminOrSupervisor }) as { data: any };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: stats } = useKnowledgeStats() as { data: any };
  const indexed = parseInt(stats?.documents?.indexed || '0');
  const hasIndexedDocs = indexed > 0;

  const goToKnowledge = () => setActiveTab('knowledge');

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
              <h1 className="text-lg font-semibold text-text-primary">AI &amp; Content</h1>
              <p className="text-xs text-text-muted">Knowledge base, canned responses, and AI configuration</p>
            </div>
          </div>
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
      <div className="px-6 py-6">
        {activeTab === 'bot' && (
          <AiBotForm onGoToKnowledgeBase={goToKnowledge} />
        )}

        {activeTab === 'knowledge' && (
          <DocumentsTab
            initialFilter={activeFilter}
            onFilterChange={(f) => setActiveFilter(f === 'all' ? undefined : f)}
            showAiBanner={isAdminOrSupervisor && !aiSettings?.enabled}
            onConfigureAi={() => setActiveTab('bot')}
          />
        )}

        {activeTab === 'canned' && (
          <CannedResponsesContent />
        )}

        {activeTab === 'appearances' && <ChatbotAppearancesForm />}

        {activeTab === 'social' && (
          <ComingSoonPanel
            icon={Share2}
            title="Social Media Integrations"
            description="Connect Messenger, Instagram, WhatsApp, and other channels. Coming soon."
          />
        )}

        {activeTab === 'extra' && (
          <ComingSoonPanel
            icon={SlidersHorizontal}
            title="Extra Settings"
            description="Workspace-level preferences and account-wide AI defaults. Coming soon."
          />
        )}
      </div>

      {/* Test Chat Panel */}
      {isAdmin && (
        <TestChatPanel
          isOpen={isTestChatOpen}
          onClose={() => setIsTestChatOpen(false)}
          botName={aiSettings?.brandVoice?.name || 'AI Assistant'}
          provider={aiSettings?.provider || 'openai'}
          model={aiSettings?.model || 'gpt-4o-mini'}
          hasIndexedDocs={hasIndexedDocs}
        />
      )}
    </div>
  );
};

export default AiContent;
