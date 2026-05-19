/**
 * Admin Tenants Page
 * Super admin view: list all tenants with suspend/activate actions.
 */

import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { Loader2, Search, Plus } from 'lucide-react';
import { cn } from '@/lib/utils';
import { PageSkeleton } from '@/components/ui/page-skeleton';
import { LoadingOverlay } from '@/components/ui/loading-overlay';
import { InlineError } from '@/components/ui/inline-error';
import {
  useAdminTenants,
  useOptimisticSuspendTenant,
  useOptimisticActivateTenant,
  useCreateTenant,
} from '../../queries/useAdminQueries';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
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

/* ------------------------------------------------------------------ */
/*  Types                                                               */
/* ------------------------------------------------------------------ */

type TenantTier = 'free' | 'pro' | 'enterprise';
type TenantStatus = 'active' | 'suspended' | 'cancelled';

interface AdminTenant {
  id: string;
  name: string;
  slug: string;
  tier: TenantTier;
  status: TenantStatus;
  createdAt: string;
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
  const [search, setSearch] = useState('');
  const [tierFilter, setTierFilter] = useState<TenantTier | 'all'>('all');
  const [statusFilter, setStatusFilter] = useState<TenantStatus | 'all'>('all');
  const [showCreate, setShowCreate] = useState(false);
  const [newTenant, setNewTenant] = useState({ name: '', tier: 'free' as TenantTier, adminEmail: '' });
  const [createError, setCreateError] = useState<string | null>(null);
  const [mutatingRowIds, setMutatingRowIds] = useState<Set<string>>(new Set());

  /* ---- Data ---- */
  const { data, isLoading, isError } = useAdminTenants();

  /* ---- Mutations ---- */
  const suspendMutation = useOptimisticSuspendTenant();
  const activateMutation = useOptimisticActivateTenant();
  const createMutation = useCreateTenant();

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
                {filtered.map((tenant) => (
                  <TableRow
                    key={tenant.id}
                    className={cn(
                      mutatingRowIds.has(tenant.id) && 'opacity-60 pointer-events-none',
                    )}
                  >
                    <TableCell>
                      <Link to={`/admin/tenants/${tenant.id}`} className="font-medium text-text-primary hover:text-primary-400 transition-colors">
                        {tenant.name}
                      </Link>
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
                    <TableCell className="text-right">
                      {tenant.status === 'active' ? (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={isMutating}
                          onClick={() => {
                            addMutatingRow(tenant.id);
                            suspendMutation.mutate(tenant.id, {
                              onSettled: () => removeMutatingRow(tenant.id),
                            });
                          }}
                          className="text-status-busy border-status-busy/30 hover:bg-status-busy/10"
                        >
                          {suspendMutation.isPending ? (
                            <Loader2 className="w-3 h-3 animate-spin" />
                          ) : (
                            t('admin.tenants.actions.suspend')
                          )}
                        </Button>
                      ) : tenant.status === 'suspended' ? (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={isMutating}
                          onClick={() => {
                            addMutatingRow(tenant.id);
                            activateMutation.mutate(tenant.id, {
                              onSettled: () => removeMutatingRow(tenant.id),
                            });
                          }}
                          className="text-status-online border-status-online/30 hover:bg-status-online/10"
                        >
                          {activateMutation.isPending ? (
                            <Loader2 className="w-3 h-3 animate-spin" />
                          ) : (
                            t('admin.tenants.actions.activate')
                          )}
                        </Button>
                      ) : (
                        <span className="text-text-muted text-sm">—</span>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
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
                          error?.response?.data?.error?.message
                          || error?.response?.data?.error
                          || error?.message
                          || t('admin.tenants.create.errorFallback')
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
    </div>
  );
};

export default AdminTenants;
