/**
 * EmbedWidgetCard — "Deploy" panel
 * Right-rail panel on the per-bot editor. Shows the bot's live status, the
 * website install snippet (built from THIS bot's `publicKey`), a Test-chat
 * shortcut, and a link to the install guide. Gated to admin at the call site
 * because the snippet contains the bot's embed key.
 */

import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Copy, MessageSquare, ExternalLink, RotateCw } from 'lucide-react';
import { toast } from 'sonner';
import { Card, CardHeader, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction,
} from '@/components/ui/alert-dialog';
import { useEndKeyGrace, useRotateBotKey, useUpdateBot, type BotPreviousKey } from '@/queries/useBotsQueries';

const ORIGIN_LINE_RE = /^(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)*(:\d{1,5})?$/;

interface EmbedWidgetCardProps {
  /** Whether the AI bot is enabled — drives the status badge + Test-chat gating. */
  enabled?: boolean;
  /** Opens the test-chat panel. Omit to hide the Test-chat button. */
  onTestChat?: () => void;
  /**
   * The bot's own embed key (from `/bots/:id/embed`). The snippet binds to THIS
   * bot — never falls back to the tenant/anchor key. Render nothing until it
   * loads so a non-default bot can't show the anchor snippet.
   */
  publicKey?: string;
  botId: string;
  previousKey?: BotPreviousKey | null;
  allowedOrigins?: string[];
}

export const EmbedWidgetCard: React.FC<EmbedWidgetCardProps> = ({
  enabled = false,
  onTestChat,
  publicKey,
  botId,
  previousKey,
  allowedOrigins,
}) => {
  const { t } = useTranslation();
  const apiKey = publicKey;
  const rotate = useRotateBotKey();
  const endGrace = useEndKeyGrace();
  const updateBot = useUpdateBot();
  const [rotateOpen, setRotateOpen] = useState(false);
  const [endOpen, setEndOpen] = useState(false);
  const [originsText, setOriginsText] = useState(() => (allowedOrigins ?? []).join('\n'));

  useEffect(() => {
    setOriginsText((allowedOrigins ?? []).join('\n'));
  }, [allowedOrigins]);

  const originLines = originsText
    .split('\n')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const originsInvalid = originLines.some((line) => !ORIGIN_LINE_RE.test(line));
  const originsUnchanged =
    JSON.stringify(originLines) === JSON.stringify(allowedOrigins ?? []);

  if (!apiKey) return null;

  const apiUrl = (import.meta.env.VITE_API_URL || '').replace('/api/v1', '') || window.location.origin;
  const embedSnippet = `<script src="${apiUrl}/widget.js"\n  data-api-key="${apiKey}"></script>`;

  return (
    <Card variant="glass" className="mb-6">
      <CardHeader>
        <div className="flex items-center justify-between gap-3">
          <h3 className="font-medium text-text-primary">{t('settings.widget.embed.deployTitle')}</h3>
          <span
            className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${
              enabled
                ? 'bg-emerald-500/10 text-emerald-400'
                : 'bg-surface-3 text-text-muted'
            }`}
          >
            <span className={`h-1.5 w-1.5 rounded-full ${enabled ? 'bg-emerald-400' : 'bg-text-muted'}`} />
            {enabled ? t('settings.widget.embed.statusActive') : t('settings.widget.embed.statusInactive')}
          </span>
        </div>
        <p className="text-xs text-text-muted">{t('settings.widget.embed.description')}</p>
      </CardHeader>
      <CardContent className="space-y-4">
        <div>
          <p className="mb-1.5 text-xs font-medium text-text-secondary">{t('settings.widget.embed.snippetLabel')}</p>
          <div className="relative">
            <pre className="bg-black/20 rounded-lg p-3 font-mono text-xs text-text-secondary overflow-x-auto whitespace-pre-wrap break-all">
              {embedSnippet}
            </pre>
            <button
              type="button"
              onClick={() => {
                navigator.clipboard.writeText(embedSnippet);
                toast.success(t('settings.widget.embed.copied'));
              }}
              className="absolute top-2 right-2 p-1.5 rounded-md bg-surface-3/80 hover:bg-surface-3 text-text-muted hover:text-text-secondary transition-colors"
              title={t('settings.widget.embed.copyTitle')}
            >
              <Copy className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>

        <div className="space-y-2">
          <Label htmlFor="allowedOrigins">{t('settings.widget.embed.allowedOrigins.label')}</Label>
          <Textarea
            id="allowedOrigins"
            rows={4}
            placeholder={t('settings.widget.embed.allowedOrigins.placeholder')}
            value={originsText}
            onChange={(e) => setOriginsText(e.target.value)}
          />
          <p className="text-xs text-muted-foreground">{t('settings.widget.embed.allowedOrigins.helper')}</p>
          {originsInvalid ? (
            <p className="text-xs text-destructive">{t('settings.widget.embed.allowedOrigins.invalid')}</p>
          ) : null}
          <Button
            type="button"
            size="sm"
            disabled={originsInvalid || originsUnchanged || updateBot.isPending}
            onClick={() => {
              updateBot.mutate(
                { id: botId, allowedOrigins: originLines },
                {
                  onSuccess: () => toast.success(t('settings.widget.embed.allowedOrigins.saved')),
                  onError: () => toast.error(t('settings.widget.embed.allowedOrigins.saveFailed')),
                },
              );
            }}
          >
            {t('settings.widget.embed.allowedOrigins.save')}
          </Button>
        </div>


        {previousKey ? (
          <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-text-secondary space-y-2">
            <p>
              {t('settings.widget.embed.rotate.graceBanner', {
                date: new Date(previousKey.expiresAt).toLocaleDateString(),
              })}
            </p>
            <p>
              {previousKey.lastUsedAt
                ? t('settings.widget.embed.rotate.graceLastUsed', {
                    date: new Date(previousKey.lastUsedAt).toLocaleString(),
                  })
                : t('settings.widget.embed.rotate.graceNeverUsed')}
            </p>
            <Button type="button" variant="outline" size="sm" onClick={() => setEndOpen(true)}>
              {t('settings.widget.embed.rotate.endEarly')}
            </Button>
          </div>
        ) : null}

        {onTestChat && (
          <Button
            variant="outline"
            size="sm"
            onClick={onTestChat}
            disabled={!enabled}
            title={enabled ? t('ai.header.testChatTooltip') : t('ai.header.testChatDisabledTooltip')}
            className="w-full gap-1.5"
          >
            <MessageSquare className="h-3.5 w-3.5" />
            {t('ai.header.testChat')}
          </Button>
        )}

        <Button type="button" variant="outline" size="sm" onClick={() => setRotateOpen(true)} className="w-full gap-1.5">
          <RotateCw className="h-3.5 w-3.5" />
          {t('settings.widget.embed.rotate.button')}
        </Button>

        <Link
          to="/help"
          className="inline-flex items-center gap-1 text-xs font-medium text-primary-400 hover:text-primary-300 transition-colors"
        >
          {t('settings.widget.embed.installGuide')}
          <ExternalLink className="h-3 w-3" />
        </Link>
      </CardContent>

      <AlertDialog open={rotateOpen} onOpenChange={setRotateOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('settings.widget.embed.rotate.confirmTitle')}</AlertDialogTitle>
            <AlertDialogDescription>{t('settings.widget.embed.rotate.confirmDescription')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                rotate.mutate(botId, {
                  onSuccess: () => {
                    toast.success(t('settings.widget.embed.rotate.rotated'));
                    setRotateOpen(false);
                  },
                  onError: () => toast.error(t('settings.widget.embed.rotate.rotateFailed')),
                });
              }}
            >
              {t('settings.widget.embed.rotate.confirmAction')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={endOpen} onOpenChange={setEndOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('settings.widget.embed.rotate.endEarlyConfirmTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('settings.widget.embed.rotate.endEarlyConfirmDescription')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                endGrace.mutate(botId, {
                  onSuccess: () => {
                    toast.success(t('settings.widget.embed.rotate.ended'));
                    setEndOpen(false);
                  },
                  onError: () => toast.error(t('settings.widget.embed.rotate.endFailed')),
                });
              }}
            >
              {t('settings.widget.embed.rotate.endEarlyConfirmAction')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
};
