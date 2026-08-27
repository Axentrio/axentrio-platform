/**
 * BotEditor — full-page per-bot AI config editor (`/ai/bots/:id`).
 *
 * Reached from the Bots list "Edit config" action. Hosts the parameterized
 * AiBotForm plus this bot's embed-snippet card and test-chat panel. Supervisors
 * may read the form (it renders read-only for non-admins); the save controls,
 * embed card, and test chat are admin/super_admin-only.
 */
import React, { useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, Bot, MessageSquare } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useAppAuth } from '@/auth/useAppAuth';
import { useBotAiSettings, useBotEmbed, useBotKnowledge } from '@/queries/useBotsQueries';
import { useKnowledgeStats } from '@/queries/useKnowledgeQueries';
import { PageSkeleton } from '@/components/ui/page-skeleton';
import { InlineError } from '@/components/ui/inline-error';
import AiBotForm from '@/pages/knowledge/AiBotForm';
import TestChatPanel from '@/pages/knowledge/TestChatPanel';
import { EmbedWidgetCard } from '@/components/ai/EmbedWidgetCard';
import BotKnowledgePanel from './BotKnowledgePanel';

type KnowledgeStatsView = { documents?: { indexed?: string } };
type BotKnowledgeView = { mode?: string; documents?: Array<{ status: string }> };

// A bot's test chat must reflect ITS knowledge, not just the tenant-primary KB.
// Dedicated bots answer only from their own KB (the primary may be empty), so
// count the bot's own indexed docs; shared bots use the tenant-primary stats.
function resolveHasIndexedDocs(
  botKnowledge: BotKnowledgeView | undefined,
  stats: KnowledgeStatsView | undefined,
): boolean {
  if (botKnowledge?.mode === 'dedicated') {
    return (botKnowledge.documents ?? []).some((d) => d.status === 'indexed');
  }
  return parseInt(stats?.documents?.indexed || '0') > 0;
}

const BotEditorHeader: React.FC<{
  botName: string;
  isAdmin: boolean;
  aiEnabled: boolean;
  onTestChat: () => void;
}> = ({ botName, isAdmin, aiEnabled, onTestChat }) => {
  const { t } = useTranslation();
  return (
    <div className="px-4 md:px-6 pt-6 pb-4">
      <Link
        to="/ai?tab=bots"
        className="inline-flex items-center gap-1.5 text-xs text-text-muted hover:text-text-secondary mb-3"
      >
        <ArrowLeft className="w-3.5 h-3.5" />
        {t('bots.editor.backToBots')}
      </Link>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-xl bg-primary-500/10">
            <Bot className="w-5 h-5 text-primary-400" />
          </div>
          <div>
            <h1 className="text-lg font-semibold text-text-primary">{botName}</h1>
            <p className="text-xs text-text-muted">{t('bots.editor.subtitle')}</p>
          </div>
        </div>
        {isAdmin && (
          <Button
            variant="outline"
            size="sm"
            onClick={onTestChat}
            disabled={!aiEnabled}
            title={!aiEnabled ? t('ai.header.testChatDisabledTooltip') : t('ai.header.testChatTooltip')}
            className="gap-1.5"
          >
            <MessageSquare className="w-3.5 h-3.5" />
            {t('ai.header.testChat')}
          </Button>
        )}
      </div>
    </div>
  );
};

const BotEditorBody: React.FC<{
  botId: string;
  isAdmin: boolean;
  isLoading: boolean;
  hasError: boolean;
  aiEnabled: boolean;
  publicKey?: string;
  onGoToKnowledge: () => void;
  onTestChat: () => void;
}> = ({ botId, isAdmin, isLoading, hasError, aiEnabled, publicKey, onGoToKnowledge, onTestChat }) => {
  const { t } = useTranslation();
  return (
    <div className="px-4 md:px-6 py-6">
      {isLoading ? (
        <PageSkeleton variant="cards" />
      ) : hasError ? (
        <InlineError message={t('ai.bot.loadError')} />
      ) : (
        <div className="grid grid-cols-1 xl:grid-cols-[3fr_1fr] gap-6 items-start">
          <div className="min-w-0 space-y-6">
            <AiBotForm botId={botId} onGoToKnowledgeBase={onGoToKnowledge} />
            <BotKnowledgePanel botId={botId} readOnly={!isAdmin} />
          </div>
          {isAdmin && (
            <div className="xl:sticky xl:top-6">
              <EmbedWidgetCard
                enabled={aiEnabled}
                publicKey={publicKey}
                onTestChat={onTestChat}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
};

const BotEditor: React.FC = () => {
  const { t } = useTranslation();
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const { isRole } = useAppAuth();
  const isAdmin = isRole('admin');
  const isAdminOrSupervisor = isRole(['admin', 'supervisor']);

  const [isTestChatOpen, setIsTestChatOpen] = useState(false);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: ai, isLoading, error } = useBotAiSettings(id, { enabled: isAdminOrSupervisor }) as {
    data: any;
    isLoading: boolean;
    error: any;
  };
  const { data: embed } = useBotEmbed(isAdmin ? id : null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: stats } = useKnowledgeStats() as { data: any };
  const { data: botKnowledge } = useBotKnowledge(id, { enabled: isAdmin });
  const hasIndexedDocs = resolveHasIndexedDocs(botKnowledge, stats);

  const brandName: string | undefined = ai?.brandVoice?.name;
  const aiEnabled = !!ai?.enabled;

  const goToKnowledge = () => navigate('/ai?tab=knowledge');
  const openTestChat = () => setIsTestChatOpen(true);

  if (!isAdminOrSupervisor) {
    return <div className="py-16 text-center text-sm text-text-muted">{t('ai.bot.noPermission')}</div>;
  }

  return (
    <div className="h-full overflow-y-auto">
      <BotEditorHeader
        botName={brandName || t('bots.editor.title')}
        isAdmin={isAdmin}
        aiEnabled={aiEnabled}
        onTestChat={openTestChat}
      />

      <BotEditorBody
        botId={id}
        isAdmin={isAdmin}
        isLoading={isLoading}
        hasError={!!error}
        aiEnabled={aiEnabled}
        publicKey={embed?.publicKey}
        onGoToKnowledge={goToKnowledge}
        onTestChat={openTestChat}
      />

      {isAdmin && (
        <TestChatPanel
          isOpen={isTestChatOpen}
          onClose={() => setIsTestChatOpen(false)}
          botId={id}
          botName={brandName || t('ai.header.defaultBotName')}
          provider={ai?.provider || 'openai'}
          model={ai?.model || 'gpt-4o-mini'}
          hasIndexedDocs={hasIndexedDocs}
        />
      )}
    </div>
  );
};

export default BotEditor;
