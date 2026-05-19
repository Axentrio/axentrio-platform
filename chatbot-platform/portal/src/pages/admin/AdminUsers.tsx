/**
 * Admin Users Page
 * Super admin view: list all users across tenants, promote/demote super admin.
 */

import React, { useState } from 'react';
import { useTranslation, Trans } from 'react-i18next';
import { Loader2, Search, ShieldCheck, ShieldOff, Trash2, UserX, UserCheck } from 'lucide-react';
import { cn } from '@/lib/utils';
import { PageSkeleton } from '@/components/ui/page-skeleton';
import { LoadingOverlay } from '@/components/ui/loading-overlay';
import {
  useAdminUsers,
  useOptimisticPromoteUser,
  useOptimisticDemoteUser,
  useOptimisticDeactivateUser,
  useOptimisticReactivateUser,
  useDeleteUser,
} from '../../queries/useAdminQueries';
import { useAppAuth } from '@/auth';
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

type UserRole = 'super_admin' | 'admin' | 'supervisor' | 'agent';

interface AdminUser {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  isActive: boolean;
  tenantId: string;
  tenantName: string;
  lastLoginAt: string | null;
  createdAt: string;
}

type ConfirmAction = { type: 'promote' | 'demote' | 'deactivate' | 'reactivate' | 'delete'; user: AdminUser } | null;

/* ------------------------------------------------------------------ */
/*  Helpers                                                             */
/* ------------------------------------------------------------------ */

function roleBadgeClass(role: UserRole): string {
  switch (role) {
    case 'super_admin':
      return 'bg-accent-500/10 text-accent-400 border-accent-500/20';
    case 'admin':
      return 'bg-primary-600/10 text-primary-400 border-primary-600/20';
    case 'supervisor':
      return 'bg-status-online/10 text-status-online border-status-online/20';
    default:
      return 'bg-surface-3 text-text-muted border-edge';
  }
}

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

const confirmDialogClassMap: Record<
  'promote' | 'demote' | 'deactivate' | 'reactivate' | 'delete',
  string
> = {
  promote: 'bg-accent-500 hover:bg-accent-600',
  demote: 'bg-status-busy hover:bg-status-busy/90',
  deactivate: 'bg-yellow-600 hover:bg-yellow-700',
  reactivate: 'bg-green-600 hover:bg-green-700',
  delete: 'bg-red-600 hover:bg-red-700',
};

/* ------------------------------------------------------------------ */
/*  Component                                                           */
/* ------------------------------------------------------------------ */

const AdminUsers: React.FC = () => {
  const { t } = useTranslation();
  const [search, setSearch] = useState('');
  const [roleFilter, setRoleFilter] = useState<UserRole | 'all'>('all');
  const [confirmAction, setConfirmAction] = useState<ConfirmAction>(null);
  const [mutatingRowIds, setMutatingRowIds] = useState<Set<string>>(new Set());

  /* ---- Data ---- */
  const { user: currentUser, tenantId: currentTenantId } = useAppAuth();
  const { data, isLoading, isError } = useAdminUsers();

  /* ---- Mutations ---- */
  const promoteMutation = useOptimisticPromoteUser();
  const demoteMutation = useOptimisticDemoteUser();
  const deactivateMutation = useOptimisticDeactivateUser();
  const reactivateMutation = useOptimisticReactivateUser();
  const deleteMutation = useDeleteUser();

  const addMutatingRow = (id: string) =>
    setMutatingRowIds((prev) => new Set(prev).add(id));
  const removeMutatingRow = (id: string) =>
    setMutatingRowIds((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });

  /* ---- Confirm handler ---- */
  const handleConfirm = () => {
    if (!confirmAction) return;
    const userId = confirmAction.user.id;
    addMutatingRow(userId);

    const mutationMap = {
      promote: promoteMutation,
      demote: demoteMutation,
      deactivate: deactivateMutation,
      reactivate: reactivateMutation,
      delete: deleteMutation,
    } as const;
    const mutation = mutationMap[confirmAction.type];
    mutation.mutate(userId, {
      onSettled: () => {
        removeMutatingRow(userId);
        setConfirmAction(null);
      },
    });
  };

  /* ---- Derived list ---- */
  const users = (data as AdminUser[] | undefined) ?? [];
  const filtered = users.filter((u) => {
    const matchesSearch =
      search.trim() === '' ||
      u.name.toLowerCase().includes(search.toLowerCase()) ||
      u.email.toLowerCase().includes(search.toLowerCase()) ||
      u.tenantName.toLowerCase().includes(search.toLowerCase());
    const matchesRole = roleFilter === 'all' || u.role === roleFilter;
    return matchesSearch && matchesRole;
  });

  const isMutating = promoteMutation.isPending || demoteMutation.isPending || deactivateMutation.isPending || reactivateMutation.isPending || deleteMutation.isPending;

  /* ---- Render ---- */
  return (
    <div className="h-full overflow-y-auto p-6">
      {/* Header */}
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-text-primary">{t('admin.users.header.title')}</h1>
        <p className="text-text-secondary mt-1">{t('admin.users.header.subtitle')}</p>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-3 mb-5">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-text-muted" />
          <Input
            placeholder={t('admin.users.searchPlaceholder')}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
          />
        </div>

        <Select value={roleFilter} onValueChange={(v) => setRoleFilter(v as UserRole | 'all')}>
          <SelectTrigger className="w-[160px]">
            <SelectValue placeholder={t('admin.users.filters.rolePlaceholder')} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t('admin.users.filters.allRoles')}</SelectItem>
            <SelectItem value="super_admin">{t('roles.super_admin')}</SelectItem>
            <SelectItem value="admin">{t('roles.admin')}</SelectItem>
            <SelectItem value="supervisor">{t('roles.supervisor')}</SelectItem>
            <SelectItem value="agent">{t('roles.agent')}</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Table */}
      <Card variant="glass" className="overflow-hidden">
        <CardContent className="p-0">
          {isLoading ? (
            <PageSkeleton variant="table" rows={5} />
          ) : isError ? (
            <div className="p-6 text-text-secondary">{t('admin.users.errorLoading')}</div>
          ) : filtered.length === 0 ? (
            <div className="p-6 text-text-muted text-center">{t('admin.users.empty')}</div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('admin.users.columns.name')}</TableHead>
                  <TableHead>{t('admin.users.columns.email')}</TableHead>
                  <TableHead>{t('admin.users.columns.role')}</TableHead>
                  <TableHead>{t('admin.users.columns.tenant')}</TableHead>
                  <TableHead>{t('admin.users.columns.status')}</TableHead>
                  <TableHead>{t('admin.users.columns.lastLogin')}</TableHead>
                  <TableHead>{t('admin.users.columns.created')}</TableHead>
                  <TableHead className="text-right">{t('admin.users.columns.actions')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((user) => (
                  <TableRow
                    key={user.id}
                    className={cn(
                      mutatingRowIds.has(user.id) && 'opacity-60 pointer-events-none',
                    )}
                  >
                    <TableCell className="font-medium text-text-primary">
                      <span className="flex items-center gap-2">
                        {user.name}
                        {currentUser?.email === user.email && currentTenantId === user.tenantId && (
                          <Badge className="bg-primary-600/15 text-primary-400 border-primary-500/25 text-[10px] px-1.5 py-0">
                            {t('admin.users.youBadge')}
                          </Badge>
                        )}
                      </span>
                    </TableCell>
                    <TableCell className="text-text-secondary">{user.email}</TableCell>
                    <TableCell>
                      <Badge className={roleBadgeClass(user.role)}>{t(`roles.${user.role}`)}</Badge>
                    </TableCell>
                    <TableCell className="text-text-secondary">{user.tenantName}</TableCell>
                    <TableCell>
                      <Badge
                        className={
                          user.isActive
                            ? 'bg-status-online/10 text-status-online border-status-online/20'
                            : 'bg-surface-3 text-text-muted border-edge'
                        }
                      >
                        {user.isActive ? t('admin.users.status.active') : t('admin.users.status.inactive')}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-text-secondary">
                      {formatDate(user.lastLoginAt)}
                    </TableCell>
                    <TableCell className="text-text-secondary">
                      {formatDate(user.createdAt)}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-2">
                        {user.role === 'super_admin' ? (
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={isMutating}
                            onClick={() => setConfirmAction({ type: 'demote', user })}
                            className="text-status-busy border-status-busy/30 hover:bg-status-busy/10 gap-1.5"
                          >
                            <ShieldOff className="w-3 h-3" />
                            {t('admin.users.actions.demote')}
                          </Button>
                        ) : (
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={isMutating}
                            onClick={() => setConfirmAction({ type: 'promote', user })}
                            className="text-accent-400 border-accent-500/30 hover:bg-accent-500/10 gap-1.5"
                          >
                            <ShieldCheck className="w-3 h-3" />
                            {t('admin.users.actions.promote')}
                          </Button>
                        )}
                        {user.isActive ? (
                          !(currentUser?.email === user.email && currentTenantId === user.tenantId) && (
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={isMutating}
                              onClick={() => setConfirmAction({ type: 'deactivate', user })}
                              className="text-yellow-400 border-yellow-500/30 hover:bg-yellow-500/10 gap-1.5"
                            >
                              <UserX className="w-3 h-3" />
                              {t('admin.users.actions.deactivate')}
                            </Button>
                          )
                        ) : (
                          <>
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={isMutating}
                              onClick={() => setConfirmAction({ type: 'reactivate', user })}
                              className="text-status-online border-status-online/30 hover:bg-status-online/10 gap-1.5"
                            >
                              <UserCheck className="w-3 h-3" />
                              {t('admin.users.actions.reactivate')}
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={isMutating}
                              onClick={() => setConfirmAction({ type: 'delete', user })}
                              className="text-red-400 border-red-500/30 hover:bg-red-500/10 gap-1.5"
                            >
                              <Trash2 className="w-3 h-3" />
                              {t('admin.users.actions.delete')}
                            </Button>
                          </>
                        )}
                      </div>
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
          {t('admin.users.footerCount', {
            count: users.length,
            shown: filtered.length,
            total: users.length,
          })}
        </p>
      )}

      {/* Confirm Dialog */}
      <AlertDialog open={!!confirmAction} onOpenChange={(open) => !open && setConfirmAction(null)}>
        <AlertDialogContent>
          <div className="relative">
            <LoadingOverlay isLoading={isMutating} />
            <AlertDialogHeader>
              <AlertDialogTitle>
                {confirmAction && t(`admin.users.confirmDialog.${confirmAction.type}.title`)}
              </AlertDialogTitle>
            <AlertDialogDescription>
              {confirmAction && (
                <Trans
                  i18nKey={`admin.users.confirmDialog.${confirmAction.type}.description`}
                  values={{ name: confirmAction.user.name }}
                  components={{ strong: <span className="font-semibold text-text-primary" /> }}
                />
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isMutating}>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => { e.preventDefault(); handleConfirm(); }}
              disabled={isMutating}
              className={confirmAction ? confirmDialogClassMap[confirmAction.type] : ''}
            >
              {isMutating ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : confirmAction ? t(`admin.users.confirmDialog.${confirmAction.type}.button`) : ''}
            </AlertDialogAction>
          </AlertDialogFooter>
          </div>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
};

export default AdminUsers;
