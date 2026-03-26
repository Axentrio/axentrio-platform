/**
 * Admin Users Page
 * Super admin view: list all users across tenants, promote/demote super admin.
 */

import React, { useState } from 'react';
import { Loader2, Search, ShieldCheck, ShieldOff } from 'lucide-react';
import { cn } from '@/lib/utils';
import { PageSkeleton } from '@/components/ui/page-skeleton';
import { LoadingOverlay } from '@/components/ui/loading-overlay';
import {
  useAdminUsers,
  useOptimisticPromoteUser,
  useOptimisticDemoteUser,
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

type ConfirmAction = { type: 'promote' | 'demote'; user: AdminUser } | null;

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

function roleLabel(role: UserRole): string {
  return role === 'super_admin' ? 'Super Admin' : role.charAt(0).toUpperCase() + role.slice(1);
}

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

/* ------------------------------------------------------------------ */
/*  Component                                                           */
/* ------------------------------------------------------------------ */

const AdminUsers: React.FC = () => {
  const [search, setSearch] = useState('');
  const [roleFilter, setRoleFilter] = useState<UserRole | 'all'>('all');
  const [confirmAction, setConfirmAction] = useState<ConfirmAction>(null);
  const [mutatingRowIds, setMutatingRowIds] = useState<Set<string>>(new Set());

  /* ---- Data ---- */
  const { data, isLoading, isError } = useAdminUsers();

  /* ---- Mutations ---- */
  const promoteMutation = useOptimisticPromoteUser();
  const demoteMutation = useOptimisticDemoteUser();

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
    const mutation = confirmAction.type === 'promote' ? promoteMutation : demoteMutation;
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

  const isMutating = promoteMutation.isPending || demoteMutation.isPending;

  /* ---- Render ---- */
  return (
    <div className="h-full overflow-y-auto p-6">
      {/* Header */}
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-text-primary">Users</h1>
        <p className="text-text-secondary mt-1">Manage all users across every tenant.</p>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-3 mb-5">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-text-muted" />
          <Input
            placeholder="Search by name, email, or tenant..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
          />
        </div>

        <Select value={roleFilter} onValueChange={(v) => setRoleFilter(v as UserRole | 'all')}>
          <SelectTrigger className="w-[160px]">
            <SelectValue placeholder="Role" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Roles</SelectItem>
            <SelectItem value="super_admin">Super Admin</SelectItem>
            <SelectItem value="admin">Admin</SelectItem>
            <SelectItem value="supervisor">Supervisor</SelectItem>
            <SelectItem value="agent">Agent</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Table */}
      <Card variant="glass" className="overflow-hidden">
        <CardContent className="p-0">
          {isLoading ? (
            <PageSkeleton variant="table" rows={5} />
          ) : isError ? (
            <div className="p-6 text-text-secondary">Failed to load users.</div>
          ) : filtered.length === 0 ? (
            <div className="p-6 text-text-muted text-center">No users found.</div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Email</TableHead>
                  <TableHead>Role</TableHead>
                  <TableHead>Tenant</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Last Login</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
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
                    <TableCell className="font-medium text-text-primary">{user.name}</TableCell>
                    <TableCell className="text-text-secondary">{user.email}</TableCell>
                    <TableCell>
                      <Badge className={roleBadgeClass(user.role)}>{roleLabel(user.role)}</Badge>
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
                        {user.isActive ? 'Active' : 'Inactive'}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-text-secondary">
                      {formatDate(user.lastLoginAt)}
                    </TableCell>
                    <TableCell className="text-text-secondary">
                      {formatDate(user.createdAt)}
                    </TableCell>
                    <TableCell className="text-right">
                      {user.role === 'super_admin' ? (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={isMutating}
                          onClick={() => setConfirmAction({ type: 'demote', user })}
                          className="text-status-busy border-status-busy/30 hover:bg-status-busy/10 gap-1.5"
                        >
                          <ShieldOff className="w-3 h-3" />
                          Demote
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
                          Promote
                        </Button>
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
          Showing {filtered.length} of {users.length} user{users.length !== 1 ? 's' : ''}
        </p>
      )}

      {/* Confirm Dialog */}
      <AlertDialog open={!!confirmAction} onOpenChange={(open) => !open && setConfirmAction(null)}>
        <AlertDialogContent>
          <div className="relative">
            <LoadingOverlay isLoading={isMutating} />
            <AlertDialogHeader>
              <AlertDialogTitle>
                {confirmAction?.type === 'promote' ? 'Promote to Super Admin' : 'Demote from Super Admin'}
              </AlertDialogTitle>
            <AlertDialogDescription>
              {confirmAction?.type === 'promote' ? (
                <>
                  Are you sure you want to promote{' '}
                  <span className="font-semibold text-text-primary">{confirmAction.user.name}</span>{' '}
                  to Super Admin? They will gain full platform access.
                </>
              ) : (
                <>
                  Are you sure you want to demote{' '}
                  <span className="font-semibold text-text-primary">
                    {confirmAction?.user.name}
                  </span>{' '}
                  from Super Admin? They will lose platform-wide privileges.
                </>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isMutating}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => { e.preventDefault(); handleConfirm(); }}
              disabled={isMutating}
              className={
                confirmAction?.type === 'promote'
                  ? 'bg-accent-500 hover:bg-accent-600'
                  : 'bg-status-busy hover:bg-status-busy/90'
              }
            >
              {isMutating ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : confirmAction?.type === 'promote' ? 'Promote' : 'Demote'}
            </AlertDialogAction>
          </AlertDialogFooter>
          </div>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
};

export default AdminUsers;
