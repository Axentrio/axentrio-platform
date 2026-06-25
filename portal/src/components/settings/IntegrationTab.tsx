/**
 * Integration Tab Component
 * API key management. (The external webhook / n8n integration was retired — its
 * Webhook URL, Connection Health, Inbound Endpoint, Webhook Secret, and Delivery
 * Log cards were removed because that path no longer exists; every AI bot is
 * answered by the in-house platform agent.)
 */

import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Key, Copy, RotateCw } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '@services/apiClient';
import { toast } from 'sonner';
import { useTenantSettings } from '../../queries/useTenantQueries';
import { queryKeys } from '../../queries/queryKeys';
import { cn } from '@/lib/utils';
import { Card, CardHeader, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
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
  const queryClient = useQueryClient();

  // Tenant data
  const { data: tenantData } = useTenantSettings();

  const [isRotatingKey, setIsRotatingKey] = useState(false);
  const [showRotateConfirm, setShowRotateConfirm] = useState(false);

  const handleRotateApiKey = async () => {
    setIsRotatingKey(true);
    try {
      await api.post('/tenants/me/api-key/rotate');
      queryClient.invalidateQueries({ queryKey: queryKeys.tenants.me() });
      toast.success(t('settings.integrations.apiKey.rotated'));
    } catch {
      toast.error(t('settings.integrations.apiKey.rotateFailed'));
    } finally {
      setIsRotatingKey(false);
      setShowRotateConfirm(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* API Key */}
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
                <code className="flex-1 px-3 py-2 bg-surface-3 border border-edge rounded-xl text-text-primary font-mono text-sm">
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
                <Button
                  variant="outline"
                  size="icon"
                  onClick={() => setShowRotateConfirm(true)}
                  disabled={isRotatingKey}
                  title={t('settings.integrations.apiKey.rotateTooltip')}
                >
                  <RotateCw className={cn("w-4 h-4", isRotatingKey && "animate-spin")} />
                </Button>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Rotate API Key Confirmation Dialog */}
      <AlertDialog open={showRotateConfirm} onOpenChange={setShowRotateConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('settings.integrations.apiKey.rotateConfirm.title')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('settings.integrations.apiKey.rotateConfirm.description')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleRotateApiKey}
              disabled={isRotatingKey}
              className={cn(
                "bg-red-600 text-white hover:bg-red-500",
                isRotatingKey && "opacity-50 pointer-events-none"
              )}
            >
              {isRotatingKey ? (
                <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white" />
              ) : (
                <RotateCw className="w-4 h-4" />
              )}
              {t('settings.integrations.apiKey.rotateConfirm.action')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
};
