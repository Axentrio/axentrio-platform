import React from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { MessageSquareText, Bot, BookOpen, Palette, Share2, Bot as BotsIcon } from 'lucide-react';
import { useAppAuth } from '@/auth/useAppAuth';
import { useBots } from '@/queries/useBotsQueries';
import DocumentsTab from './knowledge/DocumentsTab';
import { CannedResponsesContent } from './CannedResponses';
import ChatbotAppearancesForm from './knowledge/ChatbotAppearancesForm';
import { SocialChannelsContent } from '@/components/channels/SocialChannelsContent';
import BotsList from './bots/BotsList';

type Tab = 'bots' | 'knowledge' | 'canned' | 'appearances' | 'social';

const tabs: { key: Tab; labelKey: string; icon: React.ElementType }[] = [
  { key: 'bots', labelKey: 'bots.tab.title', icon: BotsIcon },
  { key: 'knowledge', labelKey: 'ai.tabs.knowledge', icon: BookOpen },
  { key: 'canned', labelKey: 'ai.tabs.canned', icon: MessageSquareText },
  { key: 'appearances', labelKey: 'ai.tabs.appearances', icon: Palette },
  { key: 'social', labelKey: 'ai.tabs.social', icon: Share2 },
];

const PARAM_TO_TAB: Record<string, Tab> = {
  // Legacy `?tab=bot` (the removed standalone AI Bot tab) now lands on the Bots list.
  bot: 'bots',
  bots: 'bots',
  knowledge: 'knowledge',
  canned: 'canned',
  appearances: 'appearances',
  social: 'social',
};

const AiContent: React.FC = () => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { isRole } = useAppAuth();
  const isAdminOrSupervisor = isRole(['admin', 'supervisor']);
  const [searchParams, setSearchParams] = useSearchParams();
  const [activeFilter, setActiveFilter] = React.useState<string | undefined>();

  // Derive active tab directly from the URL so browser back/forward works.
  const rawTab = searchParams.get('tab') ?? '';
  const activeTab: Tab = PARAM_TO_TAB[rawTab] ?? 'bots';
  const setActiveTab = (tab: Tab) => {
    const next = new URLSearchParams(searchParams);
    next.set('tab', tab);
    setSearchParams(next, { replace: true });
  };

  // Canonicalize the removed `?tab=bot` deep link to `?tab=bots` in the URL
  // (PARAM_TO_TAB already resolves it; this rewrites the address bar too).
  React.useEffect(() => {
    if (rawTab === 'bot') setActiveTab('bots');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rawTab]);

  // Default bot drives the Documents "configure AI" banner (AI enabled?) and the
  // "configure" jump target — per-bot config now lives on the bot editor page.
  const { data: botsData } = useBots();
  const defaultBot = botsData?.bots.find((b) => b.isDefault);
  const aiEnabled = defaultBot?.aiEnabled ?? false;

  const configureDefaultBot = () =>
    defaultBot ? navigate(`/ai/bots/${defaultBot.id}`) : setActiveTab('bots');

  return (
    <div className="h-full overflow-y-auto">
      {/* Header */}
      <div className="px-6 pt-6 pb-4">
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-xl bg-primary-500/10">
            <Bot className="w-5 h-5 text-primary-400" />
          </div>
          <div>
            <h1 className="text-lg font-semibold text-text-primary">{t('ai.header.title')}</h1>
            <p className="text-xs text-text-muted">{t('ai.header.subtitle')}</p>
          </div>
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
        {activeTab === 'bots' && <BotsList />}

        {activeTab === 'knowledge' && (
          <DocumentsTab
            initialFilter={activeFilter}
            onFilterChange={(f) => setActiveFilter(f === 'all' ? undefined : f)}
            showAiBanner={isAdminOrSupervisor && !aiEnabled}
            onConfigureAi={configureDefaultBot}
          />
        )}

        {activeTab === 'canned' && <CannedResponsesContent />}

        {activeTab === 'appearances' && <ChatbotAppearancesForm />}

        {activeTab === 'social' && <SocialChannelsContent />}
      </div>
    </div>
  );
};

export default AiContent;
