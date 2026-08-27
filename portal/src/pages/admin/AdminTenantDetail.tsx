/**
 * Admin Tenant Detail Page
 * Super admin view: tenant overview, members, invites, audit log.
 */

import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useParams, Link } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  Loader2,
  ArrowLeft,
  Users,
  MessageSquare,
  Activity,
  Key,
  Eye,
  EyeOff,
  RotateCw,
  X,
  Crown,
  UserPlus,
} from 'lucide-react';
import { api, extractApiErrorMessage } from '@services/apiClient';
import { PageSkeleton } from '@/components/ui/page-skeleton';
import { LoadingOverlay } from '@/components/ui/loading-overlay';
import {
  useAdminTenantDetail,
  useAdminTenantAudit,
  useOptimisticSuspendTenant,
  useOptimisticActivateTenant,
  useAdminInviteMember,
  useAdminResendInvite,
  useAdminCancelInvite,
  useSetTenantTier,
  useRetryLegalInvoice,
  type ManualTier,
} from '../../queries/useAdminQueries';
import { queryKeys } from '../../queries/queryKeys';
import {
  StripeDispositionField,
  dispositionComplete,
  type StripeDisposition,
} from '@/components/admin/StripeDispositionField';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectTrigger,
  SelectContent,
  SelectItem,
  SelectValue,
} from '@/components/ui/select';
import { InlineError } from '@/components/ui/inline-error';
import { TenantEntitlementsPanel } from '../../components/admin/TenantEntitlementsPanel';
import { LegalInvoiceStatusPills } from '@/components/admin/LegalInvoiceStatusPills';
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from '@/components/ui/table';
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

interface TenantDetailData {
  id: string;
  name: string;
  slug: string;
  tier: string;
  status: string;
  hasActiveStripeSubscription?: boolean;
  apiKeyMasked: string;
  createdAt: string;
  userCount: number;
  sessionCount: number;
  messageCount: number;
  users: Array<{
    id: string;
    name: string;
    email: string;
    role: string;
    isActive: boolean;
    lastLoginAt: string | null;
    createdAt: string;
  }>;
  pendingInvites: Array<{
    id: string;
    email: string;
    role: string;
    createdAt: string;
    expiresAt: string;
    isExpired: boolean;
  }>;
  recentAuditLogs: Array<{
    id: string;
    action: string;
    entityType: string;
    entityId: string;
    actorName: string;
    metadata: Record<string, unknown> | null;
    createdAt: string;
  }>;
  legalInvoices?: Array<{
    id: string;
    documentKind: string;
    stripeInvoiceId: string | null;
    billitInvoiceNumber: string | null;
    paymentStatus: string;
    invoiceStatus: string;
    peppolStatus: string;
    lastError: string | null;
    retryable?: boolean;
    amountInclCents?: number;
    currency?: string;
    createdAt: string;
  }>;
}

function tierBadgeClass(tier: string): string {
  switch (tier) {
    case 'enterprise': return 'bg-accent-500/10 text-accent-400 border-accent-500/20';
    case 'pro': return 'bg-primary-600/10 text-primary-400 border-primary-600/20';
    default: return 'bg-surface-3 text-text-muted border-edge';
  }
}

function statusBadgeClass(status: string): string {
  switch (status) {
    case 'active': return 'bg-status-online/10 text-status-online border-status-online/20';
    case 'suspended': return 'bg-status-busy/10 text-status-busy border-status-busy/20';
    default: return 'bg-surface-3 text-text-muted border-edge';
  }
}

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleString('en-US', {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

function formatAction(action: string): string {
  return action.replace(/\./g, ' ').replace(/_/g, ' ');
}

type LegalInvoiceRow = NonNullable<TenantDetailData['legalInvoices']>[number];

interface TierSubmitInput {
  tier: ManualTier;
  stripeDisposition: StripeDisposition | null;
  dispositionReason: string | null;
}

const TenantApiKeyCard: React.FC<{
  apiKeyMasked: string;
  showApiKey: boolean;
  revealedApiKey: string | null;
  isRevealing: boolean;
  onToggle: () => void;
  onRotate: () => void;
}> = ({ apiKeyMasked, showApiKey, revealedApiKey, isRevealing, onToggle, onRotate }) => {
  const { t } = useTranslation();
  return (
    <Card variant="glass" className="p-5">
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-lg bg-surface-3 flex items-center justify-center">
          <Key className="w-5 h-5 text-text-muted" />
        </div>
        <div>
          <p className="text-sm font-mono text-text-secondary truncate max-w-[140px]">
            {showApiKey && revealedApiKey ? revealedApiKey : apiKeyMasked}
          </p>
          <div className="flex items-center gap-2 mt-1">
            <Button
              variant="ghost"
              size="icon"
              onClick={onToggle}
              disabled={isRevealing}
              className="h-6 w-6 text-text-muted hover:text-text-secondary"
              aria-label={showApiKey ? t('admin.tenantDetail.apiKey.hide') : t('admin.tenantDetail.apiKey.reveal')}
            >
              {isRevealing ? (
                <Loader2 className="w-3 h-3 animate-spin" />
              ) : showApiKey ? (
                <EyeOff className="w-3 h-3" />
              ) : (
                <Eye className="w-3 h-3" />
              )}
            </Button>
            <Button
              variant="ghost"
              size="icon"
              onClick={onRotate}
              className="h-6 w-6 text-text-muted hover:text-text-secondary"
            >
              <RotateCw className="w-3 h-3" />
            </Button>
          </div>
        </div>
      </div>
    </Card>
  );
};

const LegalInvoicesCard: React.FC<{
  invoices: LegalInvoiceRow[] | undefined;
  isRetrying: boolean;
  onRetry: (invoiceId: string) => void;
}> = ({ invoices, isRetrying, onRetry }) => {
  const { t } = useTranslation();
  const rows = invoices ?? [];
  return (
    <Card variant="glass" className="overflow-hidden">
      <div className="px-6 py-4 border-b border-edge">
        <h3 className="font-semibold text-text-primary">{t('admin.tenantDetail.legalInvoices.title')}</h3>
      </div>
      {rows.length === 0 ? (
        <div className="px-6 py-8 text-text-muted text-center text-sm">
          {t('admin.tenantDetail.legalInvoices.empty')}
        </div>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('admin.tenantDetail.legalInvoices.columns.number')}</TableHead>
              <TableHead>{t('admin.legalInvoices.columns.status')}</TableHead>
              <TableHead>{t('admin.legalInvoices.columns.error')}</TableHead>
              <TableHead>{t('admin.tenantDetail.legalInvoices.columns.stripe')}</TableHead>
              <TableHead className="text-right">{t('admin.tenantDetail.legalInvoices.columns.actions')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => {
              const canRetry = row.retryable
                ?? (row.invoiceStatus === 'failed'
                  || row.invoiceStatus === 'manual_review'
                  || row.invoiceStatus === 'draft'
                  || row.peppolStatus === 'failed'
                  || row.peppolStatus === 'not_available');
              return (
                <TableRow key={row.id}>
                  <TableCell className="font-mono text-xs">
                    {row.billitInvoiceNumber ?? '—'}
                  </TableCell>
                  <TableCell>
                    <LegalInvoiceStatusPills
                      paymentStatus={row.paymentStatus}
                      invoiceStatus={row.invoiceStatus}
                      peppolStatus={row.peppolStatus}
                    />
                  </TableCell>
                  <TableCell className="text-xs text-status-busy max-w-[200px]">
                    {row.lastError ?? '—'}
                  </TableCell>
                  <TableCell className="font-mono text-xs">{row.stripeInvoiceId ?? '—'}</TableCell>
                  <TableCell className="text-right">
                    {canRetry ? (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={isRetrying}
                        onClick={() => onRetry(row.id)}
                      >
                        {t('admin.tenantDetail.legalInvoices.retry')}
                      </Button>
                    ) : null}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}
    </Card>
  );
};

const TenantTierDialog: React.FC<{
  open: boolean;
  tenantName: string;
  tenantTier: string;
  hasActiveStripeSubscription: boolean | undefined;
  pendingTier: ManualTier | null;
  setPendingTier: (tier: ManualTier | null) => void;
  disposition: StripeDisposition | null;
  setDisposition: (value: StripeDisposition | null) => void;
  dispositionReason: string;
  setDispositionReason: (value: string) => void;
  isPending: boolean;
  onSubmit: (input: TierSubmitInput) => void;
  onClose: () => void;
}> = ({
  open,
  tenantName,
  tenantTier,
  hasActiveStripeSubscription,
  pendingTier,
  setPendingTier,
  disposition,
  setDisposition,
  dispositionReason,
  setDispositionReason,
  isPending,
  onSubmit,
  onClose,
}) => {
  const { t } = useTranslation();

  const selectTier = (tier: ManualTier) => {
    setPendingTier(tier);
    setDisposition(null);
    setDispositionReason('');
  };

  const submit = (e: React.MouseEvent) => {
    e.preventDefault();
    if (!pendingTier) return;
    const requiresDisposition = pendingTier === 'free' && !!hasActiveStripeSubscription;
    onSubmit({
      tier: pendingTier,
      stripeDisposition: requiresDisposition ? disposition : null,
      dispositionReason:
        requiresDisposition && disposition === 'leave_active'
          ? dispositionReason.trim()
          : null,
    });
  };

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <AlertDialogContent>
        <div className="relative">
          <LoadingOverlay
            isLoading={isPending}
            message={t('admin.tenantDetail.tierDialog.updating')}
          />
          <AlertDialogHeader>
            <AlertDialogTitle>{t('admin.tenantDetail.tierDialog.title')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('admin.tenantDetail.tierDialog.descriptionBefore')} <strong>{tenantName}</strong>{t('admin.tenantDetail.tierDialog.descriptionAfter')}
            </AlertDialogDescription>
          </AlertDialogHeader>

          <div className="space-y-3 py-2">
            <div className="grid grid-cols-2 gap-2">
              {(['free', 'essential', 'pro', 'enterprise'] as ManualTier[]).map((tier) => (
                <TenantTierOption
                  key={tier}
                  tier={tier}
                  isCurrent={tenantTier === tier}
                  isSelected={pendingTier === tier}
                  onSelect={selectTier}
                />
              ))}
            </div>

            {pendingTier === 'free' && hasActiveStripeSubscription ? (
              <StripeDispositionField
                disposition={disposition}
                onDispositionChange={setDisposition}
                reason={dispositionReason}
                onReasonChange={setDispositionReason}
              />
            ) : (
              <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-300 leading-relaxed">
                <strong>{t('admin.tenantDetail.tierDialog.noteLabel')}</strong> {t('admin.tenantDetail.tierDialog.stripeWarning')}
              </div>
            )}
          </div>

          <AlertDialogFooter>
            <AlertDialogCancel disabled={isPending}>
              {t('common.cancel')}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={submit}
              disabled={
                !pendingTier ||
                isPending ||
                (pendingTier === 'free' &&
                  !!hasActiveStripeSubscription &&
                  !dispositionComplete(disposition, dispositionReason))
              }
              className="bg-accent-500 hover:bg-accent-500/90"
            >
              <TierDialogActionLabel isPending={isPending} pendingTier={pendingTier} />
            </AlertDialogAction>
          </AlertDialogFooter>
        </div>
      </AlertDialogContent>
    </AlertDialog>
  );
};

const TenantTierOption: React.FC<{
  tier: ManualTier;
  isCurrent: boolean;
  isSelected: boolean;
  onSelect: (tier: ManualTier) => void;
}> = ({ tier, isCurrent, isSelected, onSelect }) => {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      onClick={() => {
        if (isCurrent) return;
        onSelect(tier);
      }}
      disabled={isCurrent}
      className={`
                        text-left rounded-lg border px-3 py-2.5 transition-colors
                        ${isCurrent ? 'border-edge bg-surface-3 opacity-60 cursor-not-allowed' : ''}
                        ${isSelected ? 'border-accent-500/60 bg-accent-500/10' : ''}
                        ${!isCurrent && !isSelected ? 'border-edge hover:border-edge-strong hover:bg-surface-3' : ''}
                      `}
    >
      <div className="flex items-center justify-between">
        <span className="font-medium text-text-primary capitalize">{tier}</span>
        {isCurrent && (
          <span className="text-xs text-text-muted">{t('admin.tenantDetail.tierDialog.current')}</span>
        )}
        {isSelected && (
          <span className="text-xs text-accent-400">{t('admin.tenantDetail.tierDialog.selected')}</span>
        )}
      </div>
      <p className="text-xs text-text-muted mt-1">
        {tier === 'free' && t('admin.tenantDetail.tierDialog.tierDescriptions.free')}
        {tier === 'essential' && t('admin.tenantDetail.tierDialog.tierDescriptions.essential')}
        {tier === 'pro' && t('admin.tenantDetail.tierDialog.tierDescriptions.pro')}
        {tier === 'enterprise' && t('admin.tenantDetail.tierDialog.tierDescriptions.enterprise')}
      </p>
    </button>
  );
};

const TierDialogActionLabel: React.FC<{
  isPending: boolean;
  pendingTier: ManualTier | null;
}> = ({ isPending, pendingTier }) => {
  const { t } = useTranslation();
  if (isPending) return <Loader2 className="w-4 h-4 animate-spin" />;
  if (pendingTier) {
    return (
      <>
        {t('admin.tenantDetail.tierDialog.setTo', { tier: pendingTier.charAt(0).toUpperCase() + pendingTier.slice(1) })}
      </>
    );
  }
  return <>{t('admin.tenantDetail.tierDialog.pickATier')}</>;
};

const RotateApiKeyDialog: React.FC<{
  open: boolean;
  isPending: boolean;
  onConfirm: () => void;
  onClose: () => void;
}> = ({ open, isPending, onConfirm, onClose }) => {
  const { t } = useTranslation();
  return (
    <AlertDialog open={open} onOpenChange={(next) => !next && onClose()}>
      <AlertDialogContent>
        <div className="relative">
          <LoadingOverlay isLoading={isPending} message={t('admin.tenantDetail.rotateDialog.rotating')} />
          <AlertDialogHeader>
            <AlertDialogTitle>{t('admin.tenantDetail.rotateDialog.title')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('admin.tenantDetail.rotateDialog.description')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isPending}>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => { e.preventDefault(); onConfirm(); }}
              disabled={isPending}
              className="bg-status-busy hover:bg-status-busy/90"
            >
              {isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : t('admin.tenantDetail.rotateDialog.confirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </div>
      </AlertDialogContent>
    </AlertDialog>
  );
};

const AdminTenantDetail: React.FC = () => {
  const { t } = useTranslation();
  const { id } = useParams<{ id: string }>();
  const queryClient = useQueryClient();
  const [showApiKey, setShowApiKey] = useState(false);
  const [showRotateDialog, setShowRotateDialog] = useState(false);
  const [revealedApiKey, setRevealedApiKey] = useState<string | null>(null);
  const [showTierDialog, setShowTierDialog] = useState(false);
  const [pendingTier, setPendingTier] = useState<ManualTier | null>(null);
  const [disposition, setDisposition] = useState<StripeDisposition | null>(null);
  const [dispositionReason, setDispositionReason] = useState('');
  const [showInviteForm, setShowInviteForm] = useState(false);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState('agent');
  const [inviteError, setInviteError] = useState<string | null>(null);

  const { data, isLoading, isError } = useAdminTenantDetail(id ?? '');
  const { data: auditData } = useAdminTenantAudit(id ?? '');

  const suspendMutation = useOptimisticSuspendTenant();
  const activateMutation = useOptimisticActivateTenant();
  const inviteMember = useAdminInviteMember(id!);
  const resendInvite = useAdminResendInvite(id!);
  const cancelInvite = useAdminCancelInvite(id!);
  const retryLegalInvoice = useRetryLegalInvoice(id ?? '');

  const handleInvite = (e: React.FormEvent) => {
    e.preventDefault();
    if (!inviteEmail.trim()) return;
    setInviteError(null);
    inviteMember.mutate(
      { email: inviteEmail.trim(), role: inviteRole },
      {
        onSuccess: () => {
          setInviteEmail('');
          setInviteRole('agent');
          setShowInviteForm(false);
        },
        onError: (error: unknown) => {
          setInviteError(
            extractApiErrorMessage(error) ?? t('admin.tenantDetail.members.invite.errorFallback')
          );
        },
      }
    );
  };
  const setTierMutation = useSetTenantTier();

  const rotateMutation = useMutation({
    mutationFn: () => api.post<{ apiKey: string }>(`/admin/tenants/${id}/api-key/rotate`),
    onSuccess: (result) => {
      setRevealedApiKey(result.apiKey);
      setShowApiKey(true);
      queryClient.invalidateQueries({ queryKey: queryKeys.admin.tenantDetail(id ?? '') });
      toast.success(t('admin.tenantDetail.toast.apiKeyRotated'));
      setShowRotateDialog(false);
    },
    onError: () => toast.error(t('admin.tenantDetail.toast.apiKeyRotateFailed')),
  });

  // Reveal the full (unmasked) API key. Server audits each reveal so the
  // action is traceable. We cache the result in component state — clicking
  // the eye after a reveal toggles visibility without re-fetching.
  const revealMutation = useMutation({
    mutationFn: () => api.get<{ apiKey: string }>(`/admin/tenants/${id}/api-key/reveal`),
    onSuccess: (result) => {
      setRevealedApiKey(result.apiKey);
      setShowApiKey(true);
    },
    onError: () => toast.error(t('admin.tenantDetail.toast.apiKeyRevealFailed')),
  });

  const handleToggleApiKey = () => {
    if (showApiKey) {
      setShowApiKey(false);
      return;
    }
    if (revealedApiKey) {
      setShowApiKey(true);
      return;
    }
    revealMutation.mutate();
  };

  const closeTierDialog = () => {
    setShowTierDialog(false);
    setPendingTier(null);
    setDisposition(null);
    setDispositionReason('');
  };

  const submitTierChange = (input: TierSubmitInput) => {
    if (!id) return;
    setTierMutation.mutate({ id, ...input }, { onSuccess: closeTierDialog });
  };

  const tenant = data as TenantDetailData | undefined;
  const auditLogs = (auditData as TenantDetailData['recentAuditLogs'] | undefined) ?? tenant?.recentAuditLogs ?? [];

  if (isLoading) {
    return <PageSkeleton variant="list" rows={4} />;
  }

  if (isError || !tenant) {
    return (
      <div className="p-6">
        <p className="text-text-secondary">{t('admin.tenantDetail.errors.loadFailed')}</p>
        <Link to="/admin/tenants" className="text-primary-400 hover:underline mt-2 inline-block">
          {t('admin.tenantDetail.backToTenants')}
        </Link>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto p-6 space-y-6">
      {/* Breadcrumb + Header */}
      <div>
        <Link to="/admin/tenants" className="flex items-center gap-1 text-sm text-text-muted hover:text-text-secondary mb-3">
          <ArrowLeft className="w-4 h-4" />
          {t('admin.tenantDetail.breadcrumb.allTenants')}
        </Link>
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-bold text-text-primary">{tenant.name}</h1>
            <Badge className={tierBadgeClass(tenant.tier)}>
              {tenant.tier.charAt(0).toUpperCase() + tenant.tier.slice(1)}
            </Badge>
            <Badge className={statusBadgeClass(tenant.status)}>
              {tenant.status.charAt(0).toUpperCase() + tenant.status.slice(1)}
            </Badge>
          </div>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setPendingTier(null);
                setDisposition(null);
                setDispositionReason('');
                setShowTierDialog(true);
              }}
              disabled={setTierMutation.isPending}
              className="text-accent-400 border-accent-500/30 hover:bg-accent-500/10"
            >
              {setTierMutation.isPending ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Crown className="w-3.5 h-3.5" />
              )}
              {t('admin.tenantDetail.actions.setTier')}
            </Button>
            {tenant.status === 'active' ? (
              <Button
                size="sm"
                variant="outline"
                onClick={() => suspendMutation.mutate(id ?? '')}
                disabled={suspendMutation.isPending}
                className="text-status-busy border-status-busy/30 hover:bg-status-busy/10"
              >
                {t('admin.tenantDetail.actions.suspend')}
              </Button>
            ) : tenant.status === 'suspended' ? (
              <Button
                size="sm"
                variant="outline"
                onClick={() => activateMutation.mutate(id ?? '')}
                disabled={activateMutation.isPending}
                className="text-status-online border-status-online/30 hover:bg-status-online/10"
              >
                {t('admin.tenantDetail.actions.activate')}
              </Button>
            ) : null}
          </div>
        </div>
        <p className="text-text-muted text-sm mt-1">
          <span className="font-mono">{tenant.slug}</span> &middot; {t('admin.tenantDetail.header.createdOn', { date: formatDate(tenant.createdAt) })}
        </p>
      </div>

      {/* Overview Cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <Card variant="glass" className="p-5">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-primary-600/10 flex items-center justify-center">
              <Users className="w-5 h-5 text-primary-400" />
            </div>
            <div>
              <p className="text-2xl font-bold font-mono text-text-primary">{tenant.userCount}</p>
              <p className="text-xs text-text-muted">{t('admin.tenantDetail.overview.users')}</p>
            </div>
          </div>
        </Card>
        <Card variant="glass" className="p-5">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-accent-500/10 flex items-center justify-center">
              <Activity className="w-5 h-5 text-accent-400" />
            </div>
            <div>
              <p className="text-2xl font-bold font-mono text-text-primary">{tenant.sessionCount}</p>
              <p className="text-xs text-text-muted">{t('admin.tenantDetail.overview.sessions')}</p>
            </div>
          </div>
        </Card>
        <Card variant="glass" className="p-5">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-status-online/10 flex items-center justify-center">
              <MessageSquare className="w-5 h-5 text-status-online" />
            </div>
            <div>
              <p className="text-2xl font-bold font-mono text-text-primary">{tenant.messageCount}</p>
              <p className="text-xs text-text-muted">{t('admin.tenantDetail.overview.messages')}</p>
            </div>
          </div>
        </Card>
        <TenantApiKeyCard
          apiKeyMasked={tenant.apiKeyMasked}
          showApiKey={showApiKey}
          revealedApiKey={revealedApiKey}
          isRevealing={revealMutation.isPending}
          onToggle={handleToggleApiKey}
          onRotate={() => setShowRotateDialog(true)}
        />
      </div>

      {/* Entitlement controls — feature overrides + bespoke modules */}
      <TenantEntitlementsPanel tenantId={tenant.id} />

      {/* Members */}
      <Card variant="glass" className="overflow-hidden">
        <div className="flex items-center justify-between flex-wrap gap-2 px-6 py-4 border-b border-edge">
          <h3 className="font-semibold text-text-primary">
            {t('admin.tenantDetail.members.title')} <span className="text-text-muted font-normal">({tenant.userCount})</span>
          </h3>
          <div className="flex items-center gap-3">
            {tenant.userCount > 10 && (
              <Link
                to={`/admin/users?tenantId=${tenant.id}`}
                className="text-sm text-primary-400 hover:underline"
              >
                {t('admin.tenantDetail.members.viewAll')}
              </Link>
            )}
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setInviteError(null);
                setShowInviteForm((v) => !v);
              }}
            >
              <UserPlus className="w-4 h-4 mr-2" />
              {t('admin.tenantDetail.members.invite.button')}
            </Button>
          </div>
        </div>
        {showInviteForm && (
          <div className="px-6 py-4 border-b border-edge">
            <form onSubmit={handleInvite} className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
              <div className="flex-1">
                <Label className="mb-1 text-text-secondary">{t('admin.tenantDetail.members.invite.emailLabel')}</Label>
                <Input
                  type="email"
                  value={inviteEmail}
                  onChange={(e) => setInviteEmail(e.target.value)}
                  placeholder={t('admin.tenantDetail.members.invite.emailPlaceholder')}
                  required
                />
              </div>
              <div>
                <Label className="mb-1 text-text-secondary">{t('admin.tenantDetail.members.invite.roleLabel')}</Label>
                <Select value={inviteRole} onValueChange={setInviteRole}>
                  <SelectTrigger className="w-[140px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="admin">{t('roles.admin')}</SelectItem>
                    <SelectItem value="supervisor">{t('roles.supervisor')}</SelectItem>
                    <SelectItem value="agent">{t('roles.agent')}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <Button type="submit" disabled={inviteMember.isPending}>
                {inviteMember.isPending
                  ? t('admin.tenantDetail.members.invite.sending')
                  : t('admin.tenantDetail.members.invite.send')}
              </Button>
            </form>
            <InlineError message={inviteError} className="mt-2" />
          </div>
        )}
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('admin.tenantDetail.members.columns.name')}</TableHead>
              <TableHead>{t('admin.tenantDetail.members.columns.email')}</TableHead>
              <TableHead>{t('admin.tenantDetail.members.columns.role')}</TableHead>
              <TableHead>{t('admin.tenantDetail.members.columns.status')}</TableHead>
              <TableHead>{t('admin.tenantDetail.members.columns.lastLogin')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {tenant.users.map((user) => (
              <TableRow key={user.id}>
                <TableCell className="font-medium text-text-primary">{user.name}</TableCell>
                <TableCell className="text-text-secondary">{user.email}</TableCell>
                <TableCell>
                  <span className="capitalize text-text-secondary">{user.role.replace('_', ' ')}</span>
                </TableCell>
                <TableCell>
                  <Badge className={user.isActive
                    ? 'bg-status-online/10 text-status-online border-status-online/20'
                    : 'bg-surface-3 text-text-muted border-edge'
                  }>
                    {user.isActive ? t('admin.tenantDetail.status.active') : t('admin.tenantDetail.status.inactive')}
                  </Badge>
                </TableCell>
                <TableCell className="text-text-secondary text-sm">{formatDate(user.lastLoginAt)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>

      {/* Pending Invites */}
      {tenant.pendingInvites.length > 0 && (
        <Card variant="glass" className="overflow-hidden">
          <div className="px-6 py-4 border-b border-edge">
            <h3 className="font-semibold text-text-primary">
              {t('admin.tenantDetail.invites.title')} <span className="text-text-muted font-normal">({tenant.pendingInvites.length})</span>
            </h3>
          </div>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('admin.tenantDetail.invites.columns.email')}</TableHead>
                <TableHead>{t('admin.tenantDetail.invites.columns.role')}</TableHead>
                <TableHead>{t('admin.tenantDetail.invites.columns.sent')}</TableHead>
                <TableHead>{t('admin.tenantDetail.invites.columns.status')}</TableHead>
                <TableHead className="text-right">{t('admin.tenantDetail.invites.columns.actions')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {tenant.pendingInvites.map((inv) => (
                <TableRow key={inv.id}>
                  <TableCell className="text-text-primary">{inv.email}</TableCell>
                  <TableCell className="capitalize text-text-secondary">{inv.role}</TableCell>
                  <TableCell className="text-text-secondary text-sm">{formatDate(inv.createdAt)}</TableCell>
                  <TableCell>
                    {inv.isExpired ? (
                      <Badge className="bg-status-busy/10 text-status-busy border-status-busy/20">{t('admin.tenantDetail.invites.status.expired')}</Badge>
                    ) : (
                      <Badge className="bg-status-online/10 text-status-online border-status-online/20">{t('admin.tenantDetail.invites.status.pending')}</Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => resendInvite.mutate(inv.id)}
                        disabled={resendInvite.isPending}
                        title={t('admin.tenantDetail.invites.actions.resend')}
                      >
                        <RotateCw className="w-4 h-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => cancelInvite.mutate(inv.id)}
                        disabled={cancelInvite.isPending}
                        title={t('admin.tenantDetail.invites.actions.cancel')}
                      >
                        <X className="w-4 h-4" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}

      <LegalInvoicesCard
        invoices={tenant.legalInvoices}
        isRetrying={retryLegalInvoice.isPending}
        onRetry={(invoiceId) => retryLegalInvoice.mutate(invoiceId)}
      />

      {/* Audit Log */}
      <Card variant="glass" className="overflow-hidden">
        <div className="px-6 py-4 border-b border-edge">
          <h3 className="font-semibold text-text-primary">{t('admin.tenantDetail.audit.title')}</h3>
        </div>
        {auditLogs.length === 0 ? (
          <div className="px-6 py-8 text-text-muted text-center text-sm">{t('admin.tenantDetail.audit.empty')}</div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('admin.tenantDetail.audit.columns.time')}</TableHead>
                <TableHead>{t('admin.tenantDetail.audit.columns.actor')}</TableHead>
                <TableHead>{t('admin.tenantDetail.audit.columns.action')}</TableHead>
                <TableHead>{t('admin.tenantDetail.audit.columns.details')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {auditLogs.map((log) => (
                <TableRow key={log.id}>
                  <TableCell className="text-text-secondary text-sm whitespace-nowrap">
                    {formatTime(log.createdAt)}
                  </TableCell>
                  <TableCell className="text-text-primary text-sm">{log.actorName}</TableCell>
                  <TableCell>
                    <Badge className="bg-surface-3 text-text-secondary border-edge capitalize">
                      {formatAction(log.action)}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-text-muted text-xs font-mono max-w-[200px] truncate">
                    {log.metadata ? JSON.stringify(log.metadata) : '—'}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>

      {/* Set Tier (manual) Dialog */}
      <TenantTierDialog
        open={showTierDialog}
        tenantName={tenant.name}
        tenantTier={tenant.tier}
        hasActiveStripeSubscription={tenant.hasActiveStripeSubscription}
        pendingTier={pendingTier}
        setPendingTier={setPendingTier}
        disposition={disposition}
        setDisposition={setDisposition}
        dispositionReason={dispositionReason}
        setDispositionReason={setDispositionReason}
        isPending={setTierMutation.isPending}
        onSubmit={submitTierChange}
        onClose={closeTierDialog}
      />

      {/* Rotate API Key Dialog */}
      <RotateApiKeyDialog
        open={showRotateDialog}
        isPending={rotateMutation.isPending}
        onConfirm={() => rotateMutation.mutate()}
        onClose={() => setShowRotateDialog(false)}
      />
    </div>
  );
};

export default AdminTenantDetail;
