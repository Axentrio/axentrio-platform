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
} from 'lucide-react';
import { api } from '@services/apiClient';
import { PageSkeleton } from '@/components/ui/page-skeleton';
import { LoadingOverlay } from '@/components/ui/loading-overlay';
import {
  useAdminTenantDetail,
  useAdminTenantAudit,
  useOptimisticSuspendTenant,
  useOptimisticActivateTenant,
  useAdminResendInvite,
  useAdminCancelInvite,
  useSetTenantTier,
  type ManualTier,
} from '../../queries/useAdminQueries';
import { queryKeys } from '../../queries/queryKeys';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
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

const AdminTenantDetail: React.FC = () => {
  const { t } = useTranslation();
  const { id } = useParams<{ id: string }>();
  const queryClient = useQueryClient();
  const [showApiKey, setShowApiKey] = useState(false);
  const [showRotateDialog, setShowRotateDialog] = useState(false);
  const [revealedApiKey, setRevealedApiKey] = useState<string | null>(null);
  const [showTierDialog, setShowTierDialog] = useState(false);
  const [pendingTier, setPendingTier] = useState<ManualTier | null>(null);

  const { data, isLoading, isError } = useAdminTenantDetail(id ?? '');
  const { data: auditData } = useAdminTenantAudit(id ?? '');

  const suspendMutation = useOptimisticSuspendTenant();
  const activateMutation = useOptimisticActivateTenant();
  const resendInvite = useAdminResendInvite(id!);
  const cancelInvite = useAdminCancelInvite(id!);
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
        <div className="flex items-center justify-between">
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
        <Card variant="glass" className="p-5">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-surface-3 flex items-center justify-center">
              <Key className="w-5 h-5 text-text-muted" />
            </div>
            <div>
              <p className="text-sm font-mono text-text-secondary truncate max-w-[140px]">
                {showApiKey && revealedApiKey ? revealedApiKey : tenant.apiKeyMasked}
              </p>
              <div className="flex items-center gap-2 mt-1">
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={handleToggleApiKey}
                  disabled={revealMutation.isPending}
                  className="h-6 w-6 text-text-muted hover:text-text-secondary"
                  aria-label={showApiKey ? t('admin.tenantDetail.apiKey.hide') : t('admin.tenantDetail.apiKey.reveal')}
                >
                  {revealMutation.isPending ? (
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
                  onClick={() => setShowRotateDialog(true)}
                  className="h-6 w-6 text-text-muted hover:text-text-secondary"
                >
                  <RotateCw className="w-3 h-3" />
                </Button>
              </div>
            </div>
          </div>
        </Card>
      </div>

      {/* Members */}
      <Card variant="glass" className="overflow-hidden">
        <div className="flex items-center justify-between px-6 py-4 border-b border-edge">
          <h3 className="font-semibold text-text-primary">
            {t('admin.tenantDetail.members.title')} <span className="text-text-muted font-normal">({tenant.userCount})</span>
          </h3>
          {tenant.userCount > 10 && (
            <Link
              to={`/admin/users?tenantId=${tenant.id}`}
              className="text-sm text-primary-400 hover:underline"
            >
              {t('admin.tenantDetail.members.viewAll')}
            </Link>
          )}
        </div>
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
      <AlertDialog
        open={showTierDialog}
        onOpenChange={(open) => {
          if (!open) {
            setShowTierDialog(false);
            setPendingTier(null);
          }
        }}
      >
        <AlertDialogContent>
          <div className="relative">
            <LoadingOverlay
              isLoading={setTierMutation.isPending}
              message={t('admin.tenantDetail.tierDialog.updating')}
            />
            <AlertDialogHeader>
              <AlertDialogTitle>{t('admin.tenantDetail.tierDialog.title')}</AlertDialogTitle>
              <AlertDialogDescription>
                {t('admin.tenantDetail.tierDialog.descriptionBefore')} <strong>{tenant.name}</strong>{t('admin.tenantDetail.tierDialog.descriptionAfter')}
              </AlertDialogDescription>
            </AlertDialogHeader>

            <div className="space-y-3 py-2">
              <div className="grid grid-cols-2 gap-2">
                {(['free', 'essential', 'pro', 'enterprise'] as ManualTier[]).map((tier) => {
                  const isCurrent = tenant.tier === tier;
                  const isSelected = pendingTier === tier;
                  return (
                    <button
                      key={tier}
                      type="button"
                      onClick={() => !isCurrent && setPendingTier(tier)}
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
                })}
              </div>

              <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-300 leading-relaxed">
                <strong>{t('admin.tenantDetail.tierDialog.noteLabel')}</strong> {t('admin.tenantDetail.tierDialog.stripeWarning')}
              </div>
            </div>

            <AlertDialogFooter>
              <AlertDialogCancel disabled={setTierMutation.isPending}>
                {t('common.cancel')}
              </AlertDialogCancel>
              <AlertDialogAction
                onClick={(e) => {
                  e.preventDefault();
                  if (!id || !pendingTier) return;
                  setTierMutation.mutate(
                    { id, tier: pendingTier },
                    {
                      onSuccess: () => {
                        setShowTierDialog(false);
                        setPendingTier(null);
                      },
                    },
                  );
                }}
                disabled={!pendingTier || setTierMutation.isPending}
                className="bg-accent-500 hover:bg-accent-500/90"
              >
                {setTierMutation.isPending ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : pendingTier ? (
                  t('admin.tenantDetail.tierDialog.setTo', { tier: pendingTier.charAt(0).toUpperCase() + pendingTier.slice(1) })
                ) : (
                  t('admin.tenantDetail.tierDialog.pickATier')
                )}
              </AlertDialogAction>
            </AlertDialogFooter>
          </div>
        </AlertDialogContent>
      </AlertDialog>

      {/* Rotate API Key Dialog */}
      <AlertDialog open={showRotateDialog} onOpenChange={(open) => !open && setShowRotateDialog(false)}>
        <AlertDialogContent>
          <div className="relative">
            <LoadingOverlay isLoading={rotateMutation.isPending} message={t('admin.tenantDetail.rotateDialog.rotating')} />
            <AlertDialogHeader>
              <AlertDialogTitle>{t('admin.tenantDetail.rotateDialog.title')}</AlertDialogTitle>
              <AlertDialogDescription>
                {t('admin.tenantDetail.rotateDialog.description')}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={rotateMutation.isPending}>{t('common.cancel')}</AlertDialogCancel>
              <AlertDialogAction
                onClick={(e) => { e.preventDefault(); rotateMutation.mutate(); }}
                disabled={rotateMutation.isPending}
                className="bg-status-busy hover:bg-status-busy/90"
              >
                {rotateMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : t('admin.tenantDetail.rotateDialog.confirm')}
              </AlertDialogAction>
            </AlertDialogFooter>
          </div>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
};

export default AdminTenantDetail;
