import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Plus, MoreVertical, Pencil, Pause, Play, Code, Trash2, Settings2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
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
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { PageSkeleton } from '@/components/ui/page-skeleton';
import { InlineError } from '@/components/ui/inline-error';
import { extractApiErrorMessage } from '@services/apiClient';
import {
  useBots,
  useUpdateBot,
  useDeleteBot,
  extractApiErrorCode,
  type BotListItem,
} from '@/queries/useBotsQueries';
import CreateBotDialog from './CreateBotDialog';
import RenameBotDialog from './RenameBotDialog';
import EmbedSnippetDialog from './EmbedSnippetDialog';
import { OnboardingChecklist } from '@/components/ai/OnboardingChecklist';
import { useKnowledgeStats } from '@/queries/useKnowledgeQueries';
import { useChannelConnections } from '@/queries/useChannelQueries';

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString();
  } catch {
    return iso;
  }
}

export const BotsList: React.FC = () => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { data, isLoading, error } = useBots();
  const updateBot = useUpdateBot();
  const deleteBot = useDeleteBot();

  // Tenant-wide onboarding signals (relocated here from the removed AI Bot tab).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: stats } = useKnowledgeStats() as { data: any };
  const { data: channelConnections } = useChannelConnections();

  const [createOpen, setCreateOpen] = useState(false);
  const [renaming, setRenaming] = useState<BotListItem | null>(null);
  const [embedFor, setEmbedFor] = useState<string | null>(null);
  const [pauseTarget, setPauseTarget] = useState<BotListItem | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<BotListItem | null>(null);

  if (isLoading) return <PageSkeleton variant="list" rows={4} />;
  if (error) return <InlineError message={t('bots.errors.generic')} />;

  const bots = data?.bots ?? [];
  const used = data?.used ?? 0;
  const limit = data?.limit ?? null;
  const atQuota = limit !== null && used >= limit;

  const defaultBot = bots.find((b) => b.isDefault);
  const botEnabled = defaultBot?.aiEnabled ?? false;
  const hasIndexedDocs = parseInt(stats?.documents?.indexed || '0') > 0;
  const hasConnectedChannel = (channelConnections?.length ?? 0) > 0;

  const handleActivate = async (bot: BotListItem) => {
    try {
      await updateBot.mutateAsync({ id: bot.id, status: 'active' });
      toast.success(t('bots.toast.activated'));
    } catch (err) {
      // The interceptor already toasts 402. Surface the structured code so we
      // can additionally hint at the upgrade path in the activate flow.
      if (extractApiErrorCode(err) === 'plan_limit_bots') return;
      const message = extractApiErrorMessage(err) ?? t('bots.errors.generic');
      toast.error(message);
    }
  };

  const handlePause = async () => {
    if (!pauseTarget) return;
    try {
      await updateBot.mutateAsync({ id: pauseTarget.id, status: 'paused' });
      toast.success(t('bots.toast.paused'));
    } catch (err) {
      // Defend against an anchor-bot 403 even though the menu hides it.
      const code = (err as { response?: { status?: number } })?.response?.status;
      if (code === 403) {
        toast.error(t('bots.errors.anchorPauseBlocked'));
      } else {
        const message = extractApiErrorMessage(err) ?? t('bots.errors.generic');
        toast.error(message);
      }
    } finally {
      setPauseTarget(null);
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    try {
      await deleteBot.mutateAsync(deleteTarget.id);
      toast.success(t('bots.toast.deleted'));
    } catch (err) {
      const code = (err as { response?: { status?: number } })?.response?.status;
      if (code === 403) {
        toast.error(t('bots.errors.anchorDeleteBlocked'));
      } else {
        const message = extractApiErrorMessage(err) ?? t('bots.errors.generic');
        toast.error(message);
      }
    } finally {
      setDeleteTarget(null);
    }
  };

  const usageLabel =
    limit === null
      ? t('bots.quota.usageUnlimited', { used })
      : t('bots.quota.usage', { used, limit });

  const newBotButton = (
    <Button
      onClick={() => setCreateOpen(true)}
      disabled={atQuota}
      aria-label={t('bots.actions.newBot')}
    >
      <Plus className="w-4 h-4 mr-2" />
      {t('bots.actions.newBot')}
    </Button>
  );

  return (
    <TooltipProvider>
      <div className="space-y-6">
        <OnboardingChecklist
          botEnabled={botEnabled}
          hasIndexedDocs={hasIndexedDocs}
          hasConnectedChannel={hasConnectedChannel}
          onGoToKnowledge={() => navigate('/ai?tab=knowledge')}
          onGoToSocial={() => navigate('/ai?tab=social')}
        />

        {/* Header: usage + new bot button */}
        <div className="flex items-center justify-between">
          <p className="text-sm text-text-muted">{usageLabel}</p>
          {atQuota ? (
            <Tooltip>
              <TooltipTrigger asChild>
                {/* span wrapper so a disabled button still surfaces the tooltip */}
                <span>{newBotButton}</span>
              </TooltipTrigger>
              <TooltipContent>{t('bots.quota.upgradeCta')}</TooltipContent>
            </Tooltip>
          ) : (
            newBotButton
          )}
        </div>

        {/* Table */}
        <div className="rounded-lg border border-edge overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('bots.list.headers.name')}</TableHead>
                <TableHead>{t('bots.list.headers.status')}</TableHead>
                <TableHead>{t('bots.list.headers.default')}</TableHead>
                <TableHead>{t('bots.list.headers.created')}</TableHead>
                <TableHead className="w-[80px] text-right">
                  {t('bots.list.headers.actions')}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {bots.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="text-center py-12 text-text-muted">
                    {t('bots.list.empty')}
                  </TableCell>
                </TableRow>
              ) : (
                bots.map((bot) => (
                  <TableRow key={bot.id}>
                    <TableCell className="font-medium">{bot.name}</TableCell>
                    <TableCell>
                      <Badge variant={bot.status === 'active' ? 'default' : 'secondary'}>
                        {t(`bots.status.${bot.status}`)}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      {bot.isDefault && (
                        <Badge variant="outline">{t('bots.default')}</Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-text-muted">
                      {formatDate(bot.createdAt)}
                    </TableCell>
                    <TableCell className="text-right">
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon"
                            aria-label={t('bots.actions.menuAria', { name: bot.name })}
                          >
                            <MoreVertical className="w-4 h-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onClick={() => navigate(`/ai/bots/${bot.id}`)}>
                            <Settings2 className="w-4 h-4 mr-2" />
                            {t('bots.actions.editConfig')}
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => setRenaming(bot)}>
                            <Pencil className="w-4 h-4 mr-2" />
                            {t('bots.actions.rename')}
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => setEmbedFor(bot.id)}>
                            <Code className="w-4 h-4 mr-2" />
                            {t('bots.actions.showEmbed')}
                          </DropdownMenuItem>
                          {bot.status === 'active' && !bot.isDefault && (
                            <DropdownMenuItem onClick={() => setPauseTarget(bot)}>
                              <Pause className="w-4 h-4 mr-2" />
                              {t('bots.actions.pause')}
                            </DropdownMenuItem>
                          )}
                          {bot.status === 'paused' && (
                            <DropdownMenuItem onClick={() => handleActivate(bot)}>
                              <Play className="w-4 h-4 mr-2" />
                              {t('bots.actions.activate')}
                            </DropdownMenuItem>
                          )}
                          {!bot.isDefault && (
                            <>
                              <DropdownMenuSeparator />
                              <DropdownMenuItem
                                onClick={() => setDeleteTarget(bot)}
                                className="text-red-400 focus:text-red-400"
                              >
                                <Trash2 className="w-4 h-4 mr-2" />
                                {t('bots.actions.delete')}
                              </DropdownMenuItem>
                            </>
                          )}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>

        {/* Create dialog */}
        <CreateBotDialog open={createOpen} onOpenChange={setCreateOpen} />

        {/* Rename dialog */}
        <RenameBotDialog bot={renaming} onClose={() => setRenaming(null)} />

        {/* Embed dialog */}
        <EmbedSnippetDialog botId={embedFor} onClose={() => setEmbedFor(null)} />

        {/* Pause confirm */}
        <AlertDialog open={!!pauseTarget} onOpenChange={(o) => !o && setPauseTarget(null)}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{t('bots.pause.title')}</AlertDialogTitle>
              <AlertDialogDescription>
                {pauseTarget
                  ? t('bots.pause.description', { name: pauseTarget.name })
                  : ''}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
              <AlertDialogAction onClick={handlePause}>
                {t('bots.actions.pause')}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        {/* Delete confirm */}
        <AlertDialog open={!!deleteTarget} onOpenChange={(o) => !o && setDeleteTarget(null)}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{t('bots.delete.title')}</AlertDialogTitle>
              <AlertDialogDescription>
                {deleteTarget
                  ? t('bots.delete.description', { name: deleteTarget.name })
                  : ''}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
              <AlertDialogAction
                onClick={handleDelete}
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              >
                {t('common.delete')}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </TooltipProvider>
  );
};

export default BotsList;
