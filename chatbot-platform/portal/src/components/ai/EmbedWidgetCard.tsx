/**
 * EmbedWidgetCard
 * Renders the website install snippet on the AI & Content "AI Bot" tab.
 * Gated to admin at the call site because the snippet contains the tenant API key.
 */

import React from 'react';
import { useTranslation } from 'react-i18next';
import { Copy } from 'lucide-react';
import { toast } from 'sonner';
import { Card, CardHeader, CardContent } from '@/components/ui/card';
import { useTenantSettings } from '@/queries/useTenantQueries';

export const EmbedWidgetCard: React.FC = () => {
  const { t } = useTranslation();
  const { data: tenant } = useTenantSettings() as { data: { apiKey?: string } | undefined };
  const apiKey = tenant?.apiKey;

  if (!apiKey) return null;

  const apiUrl = (import.meta.env.VITE_API_URL || '').replace('/api/v1', '') || window.location.origin;
  const embedSnippet = `<script src="${apiUrl}/widget.js"\n  data-api-key="${apiKey}"></script>`;

  return (
    <Card variant="glass" className="mb-6">
      <CardHeader>
        <h3 className="font-medium text-text-primary">{t('settings.widget.embed.title')}</h3>
        <p className="text-xs text-text-muted">{t('settings.widget.embed.description')}</p>
      </CardHeader>
      <CardContent>
        <div className="relative">
          <pre className="bg-black/20 rounded-lg p-3 font-mono text-xs text-text-secondary overflow-x-auto whitespace-pre-wrap break-all">
            {embedSnippet}
          </pre>
          <button
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
      </CardContent>
    </Card>
  );
};

export default EmbedWidgetCard;
