/**
 * Admin Tenants Page
 * Super admin view: list all tenants with suspend/activate actions.
 */

import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { Loader2, Search, Plus, MoreHorizontal, ChevronRight, Eye, Crown, Ban, Power } from 'lucide-react';
import { cn } from '@/lib/utils';
import { PageSkeleton } from '@/components/ui/page-skeleton';
import { LoadingOverlay } from '@/components/ui/loading-overlay';
import { InlineError } from '@/components/ui/inline-error';
import {
  useAdminTenants,
  useOptimisticSuspendTenant,
  useOptimisticActivateTenant,
  useCreateTenant,
  useSetTenantTier,
  type ManualTier,
} from '../../queries/useAdminQueries';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import {
  StripeDispositionField,
  dispositionComplete,
  type StripeDisposition,
} from '@/components/admin/StripeDispositionField';
import {
  Select,
  SelectTrigger,
  SelectContent,
  SelectItem,
  SelectValue,
} from '@/components/ui/select';
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
import { extractApiErrorMessage } from '@services/apiClient';

/* ------------------------------------------------------------------ */
/*  Types                                                               */
/* ------------------------------------------------------------------ */

type TenantTier = 'free' | 'essential' | 'pro' | 'enterprise';
type TenantStatus = 'active' | 'suspended' | 'cancelled';

const TIER_OPTIONS: TenantTier[] = ['free', 'essential', 'pro', 'enterprise'];

interface AdminTenant {
  id: string;
  name: string;
  slug: string;
  tier: TenantTier;
  status: TenantStatus;
  createdAt: string;
  // True when a live Stripe subscription exists (primary or demoted). Drives
  // the forced-disposition step when downgrading the tenant to Free.
  hasActiveStripeSubscription?: boolean;
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                             */
/* ------------------------------------------------------------------ */

function tierBadgeClass(tier: TenantTier): string {
  switch (tier) {
    case 'enterprise':
      return 'bg-accent-500/10 text-accent-400 border-accent-500/20';
    case 'pro':
      return 'bg-primary-600/10 text-primary-400 border-primary-600/20';
    case 'essential':
      return 'bg-sky-500/10 text-sky-400 border-sky-500/20';
    default:
      return 'bg-surface-3 text-text-muted border-edge';
  }
}

function statusBadgeClass(status: TenantStatus): string {
  switch (status) {
    case 'active':
      return 'bg-status-online/10 text-status-online border-status-online/20';
    case 'suspended':
      return 'bg-status-busy/10 text-status-busy border-status-busy/20';
    default:
      return 'bg-surface-3 text-text-muted border-edge';
  }
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

/* ------------------------------------------------------------------ */
/*  Component                                                           */
/* ------------------------------------------------------------------ */

const AdminTenants: React.FC = () => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const [tierFilter, setTierFilter] = useState<TenantTier | 'all'>('all');
  const [statusFilter, setStatusFilter] = useState<TenantStatus | 'all'>('all');
  const [showCreate, setShowCreate] = useState(false);
  const [newTenant, setNewTenant] = useState({ name: '', tier: 'free' as TenantTier, adminEmail: '' });
  const [createError, setCreateError] = useState<string | null>(null);
  const [mutatingRowIds, setMutatingRowIds] = useState<Set<string>>(new Set());

  /* ---- Tier dialog ---- */
  const [tierTarget, setTierTarget] = useState<AdminTenant | null>(null);
  const [pendingTier, setPendingTier] = useState<TenantTier | null>(null);
  const [disposition, setDisposition] = useState<StripeDisposition | null>(null);
  const [dispositionReason, setDispositionReason] = useState('');

  /* ---- Data ---- */
  const { data, isLoading, isError } = useAdminTenants();

  /* ---- Mutations ---- */
  const suspendMutation = useOptimisticSuspendTenant();
  const activateMutation = useOptimisticActivateTenant();
  const createMutation = useCreateTenant();
  const setTierMutation = useSetTenantTier();

  /* ---- Derived list ---- */
  const tenants = (data as AdminTenant[] | undefined) ?? [];
  const filtered = tenants.filter((t) => {
    const matchesSearch =
      search.trim() === '' ||
      t.name.toLowerCase().includes(search.toLowerCase()) ||
      t.slug.toLowerCase().includes(search.toLowerCase());
    const matchesTier = tierFilter === 'all' || t.tier === tierFilter;
    const matchesStatus = statusFilter === 'all' || t.status === statusFilter;
    return matchesSearch && matchesTier && matchesStatus;
  });

  const isMutating = suspendMutation.isPending || activateMutation.isPending;

  const addMutatingRow = (id: string) =>
    setMutatingRowIds((prev) => new Set(prev).add(id));
  const removeMutatingRow = (id: string) =>
    setMutatingRowIds((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });

  /* ---- Render ---- */
  return (
    <div className="h-full overflow-y-auto p-6">
      {/* Header */}
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-text-primary">{t('admin.tenants.header.title')}</h1>
          <p className="text-text-secondary mt-1">{t('admin.tenants.header.subtitle')}</p>
        </div>
        <Button onClick={() => setShowCreate(true)} className="gap-1.5">
          <Plus className="w-4 h-4" />
          {t('admin.tenants.actions.createTenant')}
        </Button>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-3 mb-5">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-text-muted" />
          <Input
            placeholder={t('admin.tenants.filters.searchPlaceholder')}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
          />
        </div>

        <Select value={tierFilter} onValueChange={(v) => setTierFilter(v as TenantTier | 'all')}>
          <SelectTrigger className="w-[140px]">
            <SelectValue placeholder={t('admin.tenants.filters.tierPlaceholder')} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t('admin.tenants.filters.allTiers')}</SelectItem>
            <SelectItem value="free">{t('admin.tenants.tiers.free')}</SelectItem>
            <SelectItem value="essential">{t('admin.tenants.tiers.essential')}</SelectItem>
            <SelectItem value="pro">{t('admin.tenants.tiers.pro')}</SelectItem>
            <SelectItem value="enterprise">{t('admin.tenants.tiers.enterprise')}</SelectItem>
          </SelectContent>
        </Select>

        <Select
          value={statusFilter}
          onValueChange={(v) => setStatusFilter(v as TenantStatus | 'all')}
        >
          <SelectTrigger className="w-[150px]">
            <SelectValue placeholder={t('admin.tenants.filters.statusPlaceholder')} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t('admin.tenants.filters.allStatuses')}</SelectItem>
            <SelectItem value="active">{t('admin.tenants.statuses.active')}</SelectItem>
            <SelectItem value="suspended">{t('admin.tenants.statuses.suspended')}</SelectItem>
            <SelectItem value="cancelled">{t('admin.tenants.statuses.cancelled')}</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Table */}
      <Card variant="glass" className="overflow-hidden">
        <CardContent className="p-0">
          {isLoading ? (
            <PageSkeleton variant="table" rows={5} />
          ) : isError ? (
            <div className="p-6 text-text-secondary">{t('admin.tenants.loadError')}</div>
          ) : filtered.length === 0 ? (
            <div className="p-6 text-text-muted text-center">{t('admin.tenants.empty')}</div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('admin.tenants.columns.name')}</TableHead>
                  <TableHead>{t('admin.tenants.columns.slug')}</TableHead>
                  <TableHead>{t('admin.tenants.columns.tier')}</TableHead>
                  <TableHead>{t('admin.tenants.columns.status')}</TableHead>
                  <TableHead>{t('admin.tenants.columns.created')}</TableHead>
                  <TableHead className="text-right">{t('admin.tenants.columns.actions')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((tenant) => {
                  const rowBusy = mutatingRowIds.has(tenant.id);
                  return (
                    <TableRow
                      key={tenant.id}
                      onClick={() => navigate(`/admin/tenants/${tenant.id}`)}
                      className={cn(
                        'group cursor-pointer',
                        rowBusy && 'opacity-60 pointer-events-none',
                      )}
                    >
                      <TableCell>
                        <div className="flex items-center gap-1.5">
                          <span className="font-medium text-text-primary transition-colors group-hover:text-primary-400">
                            {tenant.name}
                          </span>
                          <ChevronRight className="w-3.5 h-3.5 text-text-muted opacity-0 -translate-x-1 transition-all group-hover:opacity-100 group-hover:translate-x-0" />
                        </div>
                      </TableCell>
                      <TableCell className="text-text-secondary font-mono text-sm">
                        {tenant.slug}
                      </TableCell>
                      <TableCell>
                        <Badge className={tierBadgeClass(tenant.tier)}>
                          {t(`admin.tenants.tiers.${tenant.tier}`)}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <Badge className={statusBadgeClass(tenant.status)}>
                          {t(`admin.tenants.statuses.${tenant.status}`)}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-text-secondary">
                        {formatDate(tenant.createdAt)}
                      </TableCell>
                      {/* Actions: stop row-navigation when interacting with the menu */}
                      <TableCell className="text-right" onClick={(e) => e.stopPropagation()}>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button
                              size="icon"
                              variant="ghost"
                              className="h-8 w-8 text-text-muted hover:text-text-primary"
                              aria-label={t('admin.tenants.actions.openMenu')}
                            >
                              {rowBusy ? (
                                <Loader2 className="w-4 h-4 animate-spin" />
                              ) : (
                                <MoreHorizontal className="w-4 h-4" />
                              )}
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end" className="w-48">
                            <DropdownMenuItem onClick={() => navigate(`/admin/tenants/${tenant.id}`)}>
                              <Eye className="w-4 h-4 mr-2" />
                              {t('admin.tenants.actions.viewDetails')}
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              onClick={() => {
                                setTierTarget(tenant);
                                setPendingTier(null);
                                setDisposition(null);
                                setDispositionReason('');
                              }}
                            >
                              <Crown className="w-4 h-4 mr-2" />
                              {t('admin.tenants.actions.changeTier')}
                            </DropdownMenuItem>
                            {tenant.status !== 'cancelled' && <DropdownMenuSeparator />}
                            {tenant.status === 'active' ? (
                              <DropdownMenuItem
                                className="text-status-busy focus:text-status-busy"
                                disabled={isMutating}
                                onClick={() => {
                                  addMutatingRow(tenant.id);
                                  suspendMutation.mutate(tenant.id, {
                                    onSettled: () => removeMutatingRow(tenant.id),
                                  });
                                }}
                              >
                                <Ban className="w-4 h-4 mr-2" />
                                {t('admin.tenants.actions.suspend')}
                              </DropdownMenuItem>
                            ) : tenant.status === 'suspended' ? (
                              <DropdownMenuItem
                                className="text-status-online focus:text-status-online"
                                disabled={isMutating}
                                onClick={() => {
                                  addMutatingRow(tenant.id);
                                  activateMutation.mutate(tenant.id, {
                                    onSettled: () => removeMutatingRow(tenant.id),
                                  });
                                }}
                              >
                                <Power className="w-4 h-4 mr-2" />
                                {t('admin.tenants.actions.activate')}
                              </DropdownMenuItem>
                            ) : null}
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Footer count */}
      {!isLoading && !isError && (
        <p className="text-sm text-text-muted mt-3">
          {t('admin.tenants.footerCount', {
            count: tenants.length,
            shown: filtered.length,
            total: tenants.length,
          })}
        </p>
      )}

      {/* Create Tenant Dialog */}
      <AlertDialog open={showCreate} onOpenChange={(open) => !open && setShowCreate(false)}>
        <AlertDialogContent>
          <div className="relative">
            <LoadingOverlay isLoading={createMutation.isPending} message={t('admin.tenants.create.loading')} />
            <AlertDialogHeader>
              <AlertDialogTitle>{t('admin.tenants.create.title')}</AlertDialogTitle>
              <AlertDialogDescription>
                {t('admin.tenants.create.description')}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <div className="space-y-4 py-2">
              <div>
                <label className="text-sm font-medium text-text-secondary mb-1 block">
                  {t('admin.tenants.create.nameLabel')}
                </label>
                <Input
                  placeholder={t('admin.tenants.create.namePlaceholder')}
                  value={newTenant.name}
                  onChange={(e) => setNewTenant((s) => ({ ...s, name: e.target.value }))}
                  disabled={createMutation.isPending}
                />
              </div>
              <div>
                <label className="text-sm font-medium text-text-secondary mb-1 block">{t('admin.tenants.create.tierLabel')}</label>
                <Select
                  value={newTenant.tier}
                  onValueChange={(v) => setNewTenant((s) => ({ ...s, tier: v as TenantTier }))}
                  disabled={createMutation.isPending}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="free">{t('admin.tenants.tiers.free')}</SelectItem>
                    <SelectItem value="essential">{t('admin.tenants.tiers.essential')}</SelectItem>
                    <SelectItem value="pro">{t('admin.tenants.tiers.pro')}</SelectItem>
                    <SelectItem value="enterprise">{t('admin.tenants.tiers.enterprise')}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <label className="text-sm font-medium text-text-secondary mb-1 block">
                  {t('admin.tenants.create.adminEmailLabel')}
                </label>
                <Input
                  type="email"
                  placeholder={t('admin.tenants.create.adminEmailPlaceholder')}
                  value={newTenant.adminEmail}
                  onChange={(e) => setNewTenant((s) => ({ ...s, adminEmail: e.target.value }))}
                  disabled={createMutation.isPending}
                />
                <p className="text-xs text-text-muted mt-1">
                  {t('admin.tenants.create.adminEmailHelp')}
                </p>
              </div>
            </div>
            <InlineError message={createError} className="mt-2" />
            <AlertDialogFooter>
              <AlertDialogCancel disabled={createMutation.isPending}>{t('common.cancel')}</AlertDialogCancel>
              <AlertDialogAction
                disabled={!newTenant.name.trim() || createMutation.isPending}
                onClick={(e) => {
                  e.preventDefault();
                  setCreateError(null);
                  createMutation.mutate(
                    {
                      name: newTenant.name.trim(),
                      tier: newTenant.tier,
                      ...(newTenant.adminEmail.trim() && { adminEmail: newTenant.adminEmail.trim() }),
                    } as Parameters<typeof createMutation.mutate>[0],
                    {
                      onSuccess: () => {
                        setShowCreate(false);
                        setNewTenant({ name: '', tier: 'free', adminEmail: '' });
                        setCreateError(null);
                      },
                      onError: (error: any) => {
                        setCreateError(
                          extractApiErrorMessage(error) ?? t('admin.tenants.create.errorFallback')
                        );
                      },
                    }
                  );
                }}
              >
                {createMutation.isPending ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  t('admin.tenants.create.submit')
                )}
              </AlertDialogAction>
            </AlertDialogFooter>
          </div>
        </AlertDialogContent>
      </AlertDialog>

      {/* Change Tier Dialog (manual override) */}
      <AlertDialog
        open={tierTarget !== null}
        onOpenChange={(open) => {
          if (!open) {
            setTierTarget(null);
            setPendingTier(null);
            setDisposition(null);
            setDispositionReason('');
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
                {t('admin.tenantDetail.tierDialog.descriptionBefore')}{' '}
                <strong>{tierTarget?.name}</strong>
                {t('admin.tenantDetail.tierDialog.descriptionAfter')}
              </AlertDialogDescription>
            </AlertDialogHeader>

            <div className="space-y-3 py-2">
              <div className="grid grid-cols-2 gap-2">
                {TIER_OPTIONS.map((tier) => {
                  const isCurrent = tierTarget?.tier === tier;
                  const isSelected = pendingTier === tier;
                  return (
                    <button
                      key={tier}
                      type="button"
                      onClick={() => {
                        if (isCurrent) return;
                        setPendingTier(tier);
                        setDisposition(null);
                        setDispositionReason('');
                      }}
                      disabled={isCurrent}
                      className={cn(
                        'text-left rounded-lg border px-3 py-2.5 transition-colors',
                        isCurrent && 'border-edge bg-surface-3 opacity-60 cursor-not-allowed',
                        isSelected && 'border-accent-500/60 bg-accent-500/10',
                        !isCurrent && !isSelected && 'border-edge hover:border-edge-strong hover:bg-surface-3',
                      )}
                    >
                      <div className="flex items-center justify-between">
                        <span className="font-medium text-text-primary">{t(`admin.tenants.tiers.${tier}`)}</span>
                        {isCurrent && (
                          <span className="text-xs text-text-muted">{t('admin.tenantDetail.tierDialog.current')}</span>
                        )}
                        {isSelected && (
                          <span className="text-xs text-accent-400">{t('admin.tenantDetail.tierDialog.selected')}</span>
                        )}
                      </div>
                      <p className="text-xs text-text-muted mt-1">
                        {t(`admin.tenantDetail.tierDialog.tierDescriptions.${tier}`)}
                      </p>
                    </button>
                  );
                })}
              </div>

              {pendingTier === 'free' && tierTarget?.hasActiveStripeSubscription ? (
                <StripeDispositionField
                  disposition={disposition}
                  onDispositionChange={setDisposition}
                  reason={dispositionReason}
                  onReasonChange={setDispositionReason}
                />
              ) : (
                <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-300 leading-relaxed">
                  <strong>{t('admin.tenantDetail.tierDialog.noteLabel')}</strong>{' '}
                  {t('admin.tenantDetail.tierDialog.stripeWarning')}
                </div>
              )}
            </div>

            <AlertDialogFooter>
              <AlertDialogCancel disabled={setTierMutation.isPending}>
                {t('common.cancel')}
              </AlertDialogCancel>
              <AlertDialogAction
                onClick={(e) => {
                  e.preventDefault();
                  if (!tierTarget || !pendingTier) return;
                  const requiresDisposition =
                    pendingTier === 'free' && !!tierTarget.hasActiveStripeSubscription;
                  setTierMutation.mutate(
                    {
                      id: tierTarget.id,
                      tier: pendingTier as ManualTier,
                      stripeDisposition: requiresDisposition ? disposition : null,
                      dispositionReason:
                        requiresDisposition && disposition === 'leave_active'
                          ? dispositionReason.trim()
                          : null,
                    },
                    {
                      onSuccess: () => {
                        setTierTarget(null);
                        setPendingTier(null);
                        setDisposition(null);
                        setDispositionReason('');
                      },
                    },
                  );
                }}
                disabled={
                  !pendingTier ||
                  setTierMutation.isPending ||
                  (pendingTier === 'free' &&
                    !!tierTarget?.hasActiveStripeSubscription &&
                    !dispositionComplete(disposition, dispositionReason))
                }
                className="bg-accent-500 hover:bg-accent-500/90"
              >
                {setTierMutation.isPending ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : pendingTier ? (
                  t('admin.tenantDetail.tierDialog.setTo', {
                    tier: t(`admin.tenants.tiers.${pendingTier}`),
                  })
                ) : (
                  t('admin.tenantDetail.tierDialog.pickATier')
                )}
              </AlertDialogAction>
            </AlertDialogFooter>
          </div>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
};

export default AdminTenants;
