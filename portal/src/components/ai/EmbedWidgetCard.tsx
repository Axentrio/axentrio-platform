/**
 * EmbedWidgetCard — "Deploy" panel
 * Right-rail panel on the per-bot editor. Shows the bot's live status, the
 * website install snippet (built from THIS bot's `publicKey`), a Test-chat
 * shortcut, and a link to the install guide. Gated to admin at the call site
 * because the snippet contains the bot's embed key.
 */

import React from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Copy, MessageSquare, ExternalLink } from 'lucide-react';
import { toast } from 'sonner';
import { Card, CardHeader, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';

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
}

export const EmbedWidgetCard: React.FC<EmbedWidgetCardProps> = ({ enabled = false, onTestChat, publicKey }) => {
  const { t } = useTranslation();
  const apiKey = publicKey;

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

        <Link
          to="/help"
          className="inline-flex items-center gap-1 text-xs font-medium text-primary-400 hover:text-primary-300 transition-colors"
        >
          {t('settings.widget.embed.installGuide')}
          <ExternalLink className="h-3 w-3" />
        </Link>
      </CardContent>
    </Card>
  );
};

