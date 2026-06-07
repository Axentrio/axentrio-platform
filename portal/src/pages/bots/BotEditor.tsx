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
  // A bot's test chat must reflect ITS knowledge, not just the tenant-primary KB.
  // Dedicated bots answer only from their own KB (the primary may be empty), so
  // count the bot's own indexed docs; shared bots use the tenant-primary stats.
  const { data: botKnowledge } = useBotKnowledge(id, { enabled: isAdmin });
  const hasIndexedDocs =
    botKnowledge?.mode === 'dedicated'
      ? (botKnowledge.documents ?? []).some((d) => d.status === 'indexed')
      : parseInt(stats?.documents?.indexed || '0') > 0;

  const goToKnowledge = () => navigate('/ai?tab=knowledge');

  if (!isAdminOrSupervisor) {
    return <div className="py-16 text-center text-sm text-text-muted">{t('ai.bot.noPermission')}</div>;
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="px-6 pt-6 pb-4">
        <Link
          to="/ai?tab=bots"
          className="inline-flex items-center gap-1.5 text-xs text-text-muted hover:text-text-secondary mb-3"
        >
          <ArrowLeft className="w-3.5 h-3.5" />
          {t('bots.editor.backToBots')}
        </Link>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-xl bg-primary-500/10">
              <Bot className="w-5 h-5 text-primary-400" />
            </div>
            <div>
              <h1 className="text-lg font-semibold text-text-primary">
                {ai?.brandVoice?.name || t('bots.editor.title')}
              </h1>
              <p className="text-xs text-text-muted">{t('bots.editor.subtitle')}</p>
            </div>
          </div>
          {isAdmin && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setIsTestChatOpen(true)}
              disabled={!ai?.enabled}
              title={!ai?.enabled ? t('ai.header.testChatDisabledTooltip') : t('ai.header.testChatTooltip')}
              className="gap-1.5"
            >
              <MessageSquare className="w-3.5 h-3.5" />
              {t('ai.header.testChat')}
            </Button>
          )}
        </div>
      </div>

      <div className="px-6 py-6">
        {isLoading ? (
          <PageSkeleton variant="cards" />
        ) : error ? (
          <InlineError message={t('ai.bot.loadError')} />
        ) : (
          <div className="grid grid-cols-1 xl:grid-cols-[3fr_1fr] gap-6 items-start">
            <div className="min-w-0 space-y-6">
              <AiBotForm botId={id} onGoToKnowledgeBase={goToKnowledge} />
              <BotKnowledgePanel botId={id} readOnly={!isAdmin} />
            </div>
            {isAdmin && (
              <div className="xl:sticky xl:top-6">
                <EmbedWidgetCard
                  enabled={!!ai?.enabled}
                  publicKey={embed?.publicKey}
                  onTestChat={() => setIsTestChatOpen(true)}
                />
              </div>
            )}
          </div>
        )}
      </div>

      {isAdmin && (
        <TestChatPanel
          isOpen={isTestChatOpen}
          onClose={() => setIsTestChatOpen(false)}
          botId={id}
          botName={ai?.brandVoice?.name || t('ai.header.defaultBotName')}
          provider={ai?.provider || 'openai'}
          model={ai?.model || 'gpt-4o-mini'}
          hasIndexedDocs={hasIndexedDocs}
        />
      )}
    </div>
  );
};

export default BotEditor;
