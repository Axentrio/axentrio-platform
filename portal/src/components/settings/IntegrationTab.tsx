/**
 * Integration Tab Component
 * API key management. (The external webhook / n8n integration was retired — its
 * Webhook URL, Connection Health, Inbound Endpoint, Webhook Secret, and Delivery
 * Log cards were removed because that path no longer exists; every AI bot is
 * answered by the in-house platform agent.)
 *
 * Widget embed-key rotation lives on the bot Deploy card, not here. This card
 * only shows the tenant's current key for copy.
 */

import React from 'react';
import { useTranslation } from 'react-i18next';
import { Key, Copy } from 'lucide-react';
import { toast } from 'sonner';
import { useTenantSettings } from '../../queries/useTenantQueries';
import { Card, CardHeader, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { EventWebhooksCard } from './EventWebhooksCard';

function maskSecret(value: string | undefined): string {
  if (!value) return '---';
  if (value.length <= 12) return value;
  return `${value.slice(0, 8)}...${value.slice(-4)}`;
}

async function copyToClipboard(text: string, successMessage: string, errorMessage: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(successMessage);
  } catch {
    toast.error(errorMessage);
  }
}

export const IntegrationTab: React.FC = () => {
  const { t } = useTranslation();
  const { data: tenantData } = useTenantSettings();

  return (
    <div className="space-y-6">
      <Card variant="glass">
        <CardHeader>
          <h2 className="text-lg font-semibold text-text-primary flex items-center gap-2">
            <Key className="w-5 h-5" />
            {t('settings.integrations.apiKey.title')}
          </h2>
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            <div>
              <Label className="text-text-secondary mb-1 block">{t('settings.integrations.apiKey.label')}</Label>
              <div className="flex items-center gap-2">
                <code className="flex-1 min-w-0 truncate px-3 py-2 bg-surface-3 border border-edge rounded-xl text-text-primary font-mono text-sm">
                  {maskSecret(tenantData?.apiKey)}
                </code>
                <Button
                  variant="outline"
                  size="icon"
                  onClick={() => tenantData?.apiKey && copyToClipboard(tenantData.apiKey, t('settings.integrations.apiKey.copySuccess'), t('settings.integrations.copyFailed'))}
                  disabled={!tenantData?.apiKey}
                  title={t('settings.integrations.apiKey.copyTooltip')}
                >
                  <Copy className="w-4 h-4" />
                </Button>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>
      <EventWebhooksCard />
    </div>
  );
};
