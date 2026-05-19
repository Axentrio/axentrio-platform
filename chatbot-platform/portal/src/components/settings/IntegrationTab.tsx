/**
 * Integration Tab Component
 * Webhook configuration, health status, and delivery log
 */

import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Key,
  Webhook,
  ExternalLink,
  Shield,
  Copy,
  RotateCw,
  Save,
  Activity,
  ArrowDownLeft,
  ArrowUpRight,
  ChevronLeft,
  ChevronRight,
} from 'lucide-react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@services/apiClient';
import { toast } from 'sonner';
import { useTenantSettings } from '../../queries/useTenantQueries';
import { CalcomSettings } from './CalcomSettings';
import { useWebhookStatus, useWebhookDeliveries, useSaveWebhookUrl, useTestWebhook } from '../../queries/useWebhookQueries';
import { queryKeys } from '../../queries/queryKeys';
import { cn } from '@/lib/utils';
import { Card, CardHeader, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
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
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction,
} from '@/components/ui/alert-dialog';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:5000/api';



interface WebhookStatusData {
  health: 'green' | 'yellow' | 'red';
  lastDelivery: {
    status: string;
    httpStatus: number;
    createdAt: string;
    durationMs: number;
  } | null;
  lastSuccessAt: string | null;
}

interface DeliveryLogEntry {
  id: string;
  event: string;
  direction: 'inbound' | 'outbound';
  status: 'success' | 'failed' | 'retrying' | 'dropped';
  httpStatus?: number;
  durationMs: number;
  error?: string;
  url: string;
  createdAt: string;
}

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

function formatTimeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export const IntegrationTab: React.FC = () => {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  // Tenant data
  const { data: tenantData, refetch: refetchTenant } = useTenantSettings();

  // Webhook status
  const { data: statusData } = useWebhookStatus();

  // Delivery log
  const [page, setPage] = useState(1);
  const { data: deliveries } = useWebhookDeliveries(page);

  // Form state
  const [webhookUrlInput, setWebhookUrlInput] = useState('');
  const [webhookUrlInitialized, setWebhookUrlInitialized] = useState(false);
  const [isRotatingKey, setIsRotatingKey] = useState(false);
  const [showRotateConfirm, setShowRotateConfirm] = useState(false);
  const [showRegenerateConfirm, setShowRegenerateConfirm] = useState(false);

  // Sync webhook URL input from tenant data
  if (tenantData?.webhookUrl && !webhookUrlInitialized) {
    setWebhookUrlInput(tenantData.webhookUrl as string);
    setWebhookUrlInitialized(true);
  }

  // Mutations
  const saveWebhookUrl = useSaveWebhookUrl();

  const testWebhook = useTestWebhook();

  const regenerateSecret = useMutation({
    mutationFn: () => api.post('/tenants/me/webhook-secret/regenerate'),
    onSuccess: () => {
      refetchTenant();
      setShowRegenerateConfirm(false);
      toast.success(t('settings.integrations.webhookSecret.regenerated'));
    },
    onError: () => toast.error(t('settings.integrations.webhookSecret.regenerateFailed')),
  });

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

  const inboundWebhookUrl = `${API_URL}/v1/webhooks/inbound`;

  const statusDataTyped = statusData as WebhookStatusData | undefined;
  const healthDot = statusDataTyped?.health;
  const healthColor = healthDot === 'green'
    ? 'bg-status-online'
    : healthDot === 'red'
      ? 'bg-red-500'
      : 'bg-yellow-500';

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

      {/* Cal.com Booking */}
      <CalcomSettings />

      {/* Webhook URL */}
      <Card variant="glass">
        <CardHeader>
          <h2 className="text-lg font-semibold text-text-primary flex items-center gap-2">
            <Webhook className="w-5 h-5" />
            {t('settings.integrations.webhookUrl.title')}
          </h2>
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            <div>
              <Label className="text-text-secondary mb-1 block">{t('settings.integrations.webhookUrl.label')}</Label>
              <div className="flex items-center gap-2">
                <Input
                  type="text"
                  value={webhookUrlInput}
                  onChange={(e) => setWebhookUrlInput(e.target.value)}
                  placeholder="https://your-webhook-endpoint.com/webhook/..."
                  className="flex-1 font-mono text-sm"
                />
              </div>
            </div>
            <div className="flex items-center gap-2 justify-end">
              <Button
                variant="outline"
                onClick={() => testWebhook.mutate()}
                disabled={testWebhook.isPending || !webhookUrlInput}
              >
                {testWebhook.isPending ? (
                  <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-text-secondary" />
                ) : (
                  <ExternalLink className="w-4 h-4" />
                )}
                {t('settings.integrations.webhookUrl.testConnection')}
              </Button>
              <Button
                onClick={() => saveWebhookUrl.mutate(webhookUrlInput)}
                disabled={saveWebhookUrl.isPending}
              >
                {saveWebhookUrl.isPending ? (
                  <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white" />
                ) : (
                  <Save className="w-4 h-4" />
                )}
                {t('common.save')}
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Connection Health */}
      <Card variant="glass">
        <CardHeader>
          <h2 className="text-lg font-semibold text-text-primary flex items-center gap-2">
            <Activity className="w-5 h-5" />
            {t('settings.integrations.health.title')}
          </h2>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-6">
            <div className="flex items-center gap-2">
              <span className={cn("w-3 h-3 rounded-full", healthColor)} />
              <span className="text-sm text-text-primary font-medium capitalize">
                {healthDot === 'green' ? t('settings.integrations.health.healthy') : healthDot === 'red' ? t('settings.integrations.health.unhealthy') : t('settings.integrations.health.unknown')}
              </span>
            </div>
            {statusDataTyped?.lastDelivery && (
              <div className="text-sm text-text-secondary">
                {t('settings.integrations.health.lastDelivery')}: {formatTimeAgo(statusDataTyped.lastDelivery.createdAt)}
                {' '}({statusDataTyped.lastDelivery.durationMs}ms)
              </div>
            )}
            {statusDataTyped?.lastSuccessAt && (
              <div className="text-sm text-text-secondary">
                {t('settings.integrations.health.lastSuccess')}: {formatTimeAgo(statusDataTyped.lastSuccessAt)}
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Inbound Webhook Endpoint */}
      <Card variant="glass">
        <CardHeader>
          <h2 className="text-lg font-semibold text-text-primary flex items-center gap-2">
            <ExternalLink className="w-5 h-5" />
            {t('settings.integrations.inbound.title')}
          </h2>
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            <div>
              <Label className="text-text-secondary mb-1 block">{t('settings.integrations.inbound.label')}</Label>
              <div className="flex items-center gap-2">
                <code className="flex-1 px-3 py-2 bg-surface-3 border border-edge rounded-xl text-text-primary font-mono text-sm">
                  {inboundWebhookUrl}
                </code>
                <Button
                  variant="outline"
                  size="icon"
                  onClick={() => copyToClipboard(inboundWebhookUrl, t('settings.integrations.inbound.copySuccess'), t('settings.integrations.copyFailed'))}
                  title={t('settings.integrations.inbound.copyTooltip')}
                >
                  <Copy className="w-4 h-4" />
                </Button>
              </div>
              <p className="text-xs text-text-muted mt-2">
                {t('settings.integrations.inbound.helper')}
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Webhook Secret */}
      <Card variant="glass">
        <CardHeader>
          <h2 className="text-lg font-semibold text-text-primary flex items-center gap-2">
            <Shield className="w-5 h-5" />
            {t('settings.integrations.webhookSecret.title')}
          </h2>
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            <div>
              <Label className="text-text-secondary mb-1 block">{t('settings.integrations.webhookSecret.label')}</Label>
              <div className="flex items-center gap-2">
                <code className="flex-1 px-3 py-2 bg-surface-3 border border-edge rounded-xl text-text-primary font-mono text-sm">
                  {maskSecret(tenantData?.webhookSecret)}
                </code>
                <Button
                  variant="outline"
                  size="icon"
                  onClick={() => tenantData?.webhookSecret && copyToClipboard(tenantData.webhookSecret, t('settings.integrations.webhookSecret.copySuccess'), t('settings.integrations.copyFailed'))}
                  disabled={!tenantData?.webhookSecret}
                  title={t('settings.integrations.webhookSecret.copyTooltip')}
                >
                  <Copy className="w-4 h-4" />
                </Button>
                <Button
                  variant="outline"
                  size="icon"
                  onClick={() => setShowRegenerateConfirm(true)}
                  disabled={regenerateSecret.isPending}
                  title={t('settings.integrations.webhookSecret.regenerateTooltip')}
                >
                  <RotateCw className={cn("w-4 h-4", regenerateSecret.isPending && "animate-spin")} />
                </Button>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Delivery Log */}
      <Card variant="glass">
        <CardHeader>
          <h2 className="text-lg font-semibold text-text-primary flex items-center gap-2">
            <Activity className="w-5 h-5" />
            {t('settings.integrations.deliveries.title')}
          </h2>
        </CardHeader>
        <CardContent>
          {Array.isArray(deliveries) && deliveries.length > 0 ? (
            <>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('settings.integrations.deliveries.columns.time')}</TableHead>
                    <TableHead>{t('settings.integrations.deliveries.columns.direction')}</TableHead>
                    <TableHead>{t('settings.integrations.deliveries.columns.event')}</TableHead>
                    <TableHead>{t('settings.integrations.deliveries.columns.status')}</TableHead>
                    <TableHead>{t('settings.integrations.deliveries.columns.http')}</TableHead>
                    <TableHead>{t('settings.integrations.deliveries.columns.duration')}</TableHead>
                    <TableHead>{t('settings.integrations.deliveries.columns.error')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(deliveries as DeliveryLogEntry[]).map((entry) => (
                    <TableRow key={entry.id}>
                      <TableCell className="text-xs text-text-secondary whitespace-nowrap">
                        {formatTimeAgo(entry.createdAt)}
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline" className="text-xs gap-1">
                          {entry.direction === 'inbound' ? (
                            <ArrowDownLeft className="w-3 h-3" />
                          ) : (
                            <ArrowUpRight className="w-3 h-3" />
                          )}
                          {t(`settings.integrations.deliveries.direction.${entry.direction}`)}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-xs font-mono">{entry.event}</TableCell>
                      <TableCell>
                        <Badge
                          className={cn(
                            "text-xs",
                            entry.status === 'success' && "bg-green-500/10 text-green-500 border-green-500/20",
                            entry.status === 'failed' && "bg-red-500/10 text-red-500 border-red-500/20",
                            entry.status === 'retrying' && "bg-yellow-500/10 text-yellow-500 border-yellow-500/20",
                            entry.status === 'dropped' && "bg-gray-500/10 text-gray-500 border-gray-500/20"
                          )}
                          variant="outline"
                        >
                          {t(`settings.integrations.deliveries.status.${entry.status}`)}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-xs">{entry.httpStatus || '-'}</TableCell>
                      <TableCell className="text-xs">{entry.durationMs}ms</TableCell>
                      <TableCell className="text-xs text-red-400 max-w-[200px] truncate" title={entry.error}>
                        {entry.error || '-'}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>

              {/* Pagination */}
              {(page > 1 || (Array.isArray(deliveries) && deliveries.length === 20)) && (
                <div className="flex items-center justify-between mt-4">
                  <span className="text-sm text-text-secondary">
                    {t('settings.integrations.deliveries.page', { page })}
                  </span>
                  <div className="flex items-center gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setPage(p => Math.max(1, p - 1))}
                      disabled={page <= 1}
                    >
                      <ChevronLeft className="w-4 h-4" />
                      {t('settings.integrations.deliveries.prev')}
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setPage(p => p + 1)}
                      disabled={!Array.isArray(deliveries) || deliveries.length < 20}
                    >
                      {t('settings.integrations.deliveries.next')}
                      <ChevronRight className="w-4 h-4" />
                    </Button>
                  </div>
                </div>
              )}
            </>
          ) : (
            <p className="text-sm text-text-muted text-center py-8">
              {t('settings.integrations.deliveries.empty')}
            </p>
          )}
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

      {/* Regenerate Webhook Secret Confirmation Dialog */}
      <AlertDialog open={showRegenerateConfirm} onOpenChange={setShowRegenerateConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('settings.integrations.webhookSecret.regenerateConfirm.title')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('settings.integrations.webhookSecret.regenerateConfirm.description')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => regenerateSecret.mutate()}
              disabled={regenerateSecret.isPending}
              className={cn(
                "bg-red-600 text-white hover:bg-red-500",
                regenerateSecret.isPending && "opacity-50 pointer-events-none"
              )}
            >
              {regenerateSecret.isPending ? (
                <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white" />
              ) : (
                <RotateCw className="w-4 h-4" />
              )}
              {t('settings.integrations.webhookSecret.regenerateConfirm.action')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
};

export default IntegrationTab;
