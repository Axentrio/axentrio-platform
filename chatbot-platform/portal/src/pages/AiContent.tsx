import React, { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { MessageSquareText, MessageSquare, Bot, BookOpen, Palette, Share2, Bot as BotsIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useAppAuth } from '@/auth/useAppAuth';
import { useGetAiSettings, useKnowledgeStats } from '@/queries/useKnowledgeQueries';
import { useChannelConnections } from '@/queries/useChannelQueries';
import DocumentsTab from './knowledge/DocumentsTab';
import AiBotForm from './knowledge/AiBotForm';
import TestChatPanel from './knowledge/TestChatPanel';
import { CannedResponsesContent } from './CannedResponses';
import ChatbotAppearancesForm from './knowledge/ChatbotAppearancesForm';
import { SocialChannelsContent } from '@/components/channels/SocialChannelsContent';
import { OnboardingChecklist } from '@/components/ai/OnboardingChecklist';
import { EmbedWidgetCard } from '@/components/ai/EmbedWidgetCard';
import BotsList from './bots/BotsList';

type Tab = 'bot' | 'bots' | 'knowledge' | 'canned' | 'appearances' | 'social';

const tabs: { key: Tab; labelKey: string; icon: React.ElementType }[] = [
  { key: 'bot', labelKey: 'ai.tabs.bot', icon: Bot },
  { key: 'bots', labelKey: 'bots.tab.title', icon: BotsIcon },
  { key: 'knowledge', labelKey: 'ai.tabs.knowledge', icon: BookOpen },
  { key: 'canned', labelKey: 'ai.tabs.canned', icon: MessageSquareText },
  { key: 'appearances', labelKey: 'ai.tabs.appearances', icon: Palette },
  { key: 'social', labelKey: 'ai.tabs.social', icon: Share2 },
];

const PARAM_TO_TAB: Record<string, Tab> = {
  bot: 'bot',
  bots: 'bots',
  knowledge: 'knowledge',
  canned: 'canned',
  appearances: 'appearances',
  social: 'social',
};

const AiContent: React.FC = () => {
  const { t } = useTranslation();
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
  const { data: channelConnections } = useChannelConnections();
  const indexed = parseInt(stats?.documents?.indexed || '0');
  const hasIndexedDocs = indexed > 0;
  const hasConnectedChannel = (channelConnections?.length ?? 0) > 0;

  const goToKnowledge = () => setActiveTab('knowledge');
  const goToSocial = () => setActiveTab('social');

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
              <h1 className="text-lg font-semibold text-text-primary">{t('ai.header.title')}</h1>
              <p className="text-xs text-text-muted">
                {t('ai.header.subtitle')}
              </p>
            </div>
          </div>
          {isAdmin && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setIsTestChatOpen(true)}
              disabled={!aiSettings?.enabled}
              title={!aiSettings?.enabled ? t('ai.header.testChatDisabledTooltip') : t('ai.header.testChatTooltip')}
              className="gap-1.5"
            >
              <MessageSquare className="w-3.5 h-3.5" />
              {t('ai.header.testChat')}
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
                {t(tab.labelKey)}
              </button>
            );
          })}
        </div>
      </div>

      {/* Tab Content */}
      <div className="px-6 py-6">
        {activeTab === 'bot' && (
          <>
            {isAdminOrSupervisor && (
              <OnboardingChecklist
                botEnabled={!!aiSettings?.enabled}
                hasIndexedDocs={hasIndexedDocs}
                hasConnectedChannel={hasConnectedChannel}
                onGoToKnowledge={goToKnowledge}
                onGoToSocial={goToSocial}
              />
            )}
            {isAdmin && <EmbedWidgetCard />}
            <AiBotForm onGoToKnowledgeBase={goToKnowledge} />
          </>
        )}

        {activeTab === 'bots' && <BotsList />}

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

        {activeTab === 'social' && <SocialChannelsContent />}
      </div>

      {/* Test Chat Panel */}
      {isAdmin && (
        <TestChatPanel
          isOpen={isTestChatOpen}
          onClose={() => setIsTestChatOpen(false)}
          botName={aiSettings?.brandVoice?.name || t('ai.header.defaultBotName')}
          provider={aiSettings?.provider || 'openai'}
          model={aiSettings?.model || 'gpt-4o-mini'}
          hasIndexedDocs={hasIndexedDocs}
        />
      )}
    </div>
  );
};

export default AiContent;
