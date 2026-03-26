/**
 * Admin Tenant Detail Page
 * Super admin view: tenant overview, members, invites, audit log.
 */

import React, { useState } from 'react';
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
} from 'lucide-react';
import { api } from '@services/apiClient';
import { PageSkeleton } from '@/components/ui/page-skeleton';
import { LoadingOverlay } from '@/components/ui/loading-overlay';
import {
  useAdminTenantDetail,
  useAdminTenantAudit,
  useOptimisticSuspendTenant,
  useOptimisticActivateTenant,
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
  const { id } = useParams<{ id: string }>();
  const queryClient = useQueryClient();
  const [showApiKey, setShowApiKey] = useState(false);
  const [showRotateDialog, setShowRotateDialog] = useState(false);
  const [revealedApiKey, setRevealedApiKey] = useState<string | null>(null);

  const { data, isLoading, isError } = useAdminTenantDetail(id ?? '');
  const { data: auditData } = useAdminTenantAudit(id ?? '');

  const suspendMutation = useOptimisticSuspendTenant();
  const activateMutation = useOptimisticActivateTenant();

  const rotateMutation = useMutation({
    mutationFn: () => api.post<{ apiKey: string }>(`/admin/tenants/${id}/api-key/rotate`),
    onSuccess: (result) => {
      setRevealedApiKey(result.apiKey);
      setShowApiKey(true);
      queryClient.invalidateQueries({ queryKey: queryKeys.admin.tenantDetail(id ?? '') });
      toast.success('API key rotated');
      setShowRotateDialog(false);
    },
    onError: () => toast.error('Failed to rotate API key'),
  });

  const tenant = data as TenantDetailData | undefined;
  const auditLogs = (auditData as TenantDetailData['recentAuditLogs'] | undefined) ?? tenant?.recentAuditLogs ?? [];

  if (isLoading) {
    return <PageSkeleton variant="list" rows={4} />;
  }

  if (isError || !tenant) {
    return (
      <div className="p-6">
        <p className="text-text-secondary">Failed to load tenant.</p>
        <Link to="/admin/tenants" className="text-primary-400 hover:underline mt-2 inline-block">
          Back to tenants
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
          All Tenants
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
            {tenant.status === 'active' ? (
              <Button
                size="sm"
                variant="outline"
                onClick={() => suspendMutation.mutate(id ?? '')}
                disabled={suspendMutation.isPending}
                className="text-status-busy border-status-busy/30 hover:bg-status-busy/10"
              >
                Suspend
              </Button>
            ) : tenant.status === 'suspended' ? (
              <Button
                size="sm"
                variant="outline"
                onClick={() => activateMutation.mutate(id ?? '')}
                disabled={activateMutation.isPending}
                className="text-status-online border-status-online/30 hover:bg-status-online/10"
              >
                Activate
              </Button>
            ) : null}
          </div>
        </div>
        <p className="text-text-muted text-sm mt-1">
          <span className="font-mono">{tenant.slug}</span> &middot; Created {formatDate(tenant.createdAt)}
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
              <p className="text-xs text-text-muted">Users</p>
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
              <p className="text-xs text-text-muted">Sessions</p>
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
              <p className="text-xs text-text-muted">Messages</p>
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
                <button
                  onClick={() => { setShowApiKey(!showApiKey); if (!revealedApiKey) setShowApiKey(false); }}
                  className="text-xs text-text-muted hover:text-text-secondary"
                >
                  {showApiKey ? <EyeOff className="w-3 h-3" /> : <Eye className="w-3 h-3" />}
                </button>
                <button
                  onClick={() => setShowRotateDialog(true)}
                  className="text-xs text-text-muted hover:text-text-secondary"
                >
                  <RotateCw className="w-3 h-3" />
                </button>
              </div>
            </div>
          </div>
        </Card>
      </div>

      {/* Members */}
      <Card variant="glass" className="overflow-hidden">
        <div className="flex items-center justify-between px-6 py-4 border-b border-edge">
          <h3 className="font-semibold text-text-primary">
            Members <span className="text-text-muted font-normal">({tenant.userCount})</span>
          </h3>
          {tenant.userCount > 10 && (
            <Link
              to={`/admin/users?tenantId=${tenant.id}`}
              className="text-sm text-primary-400 hover:underline"
            >
              View all
            </Link>
          )}
        </div>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Email</TableHead>
              <TableHead>Role</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Last Login</TableHead>
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
                    {user.isActive ? 'Active' : 'Inactive'}
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
              Pending Invites <span className="text-text-muted font-normal">({tenant.pendingInvites.length})</span>
            </h3>
          </div>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Email</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>Sent</TableHead>
                <TableHead>Status</TableHead>
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
                      <Badge className="bg-status-busy/10 text-status-busy border-status-busy/20">Expired</Badge>
                    ) : (
                      <Badge className="bg-status-online/10 text-status-online border-status-online/20">Pending</Badge>
                    )}
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
          <h3 className="font-semibold text-text-primary">Recent Activity</h3>
        </div>
        {auditLogs.length === 0 ? (
          <div className="px-6 py-8 text-text-muted text-center text-sm">No activity recorded yet.</div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Time</TableHead>
                <TableHead>Actor</TableHead>
                <TableHead>Action</TableHead>
                <TableHead>Details</TableHead>
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

      {/* Rotate API Key Dialog */}
      <AlertDialog open={showRotateDialog} onOpenChange={(open) => !open && setShowRotateDialog(false)}>
        <AlertDialogContent>
          <div className="relative">
            <LoadingOverlay isLoading={rotateMutation.isPending} message="Rotating API key..." />
            <AlertDialogHeader>
              <AlertDialogTitle>Rotate API Key</AlertDialogTitle>
              <AlertDialogDescription>
                This will invalidate the current API key immediately. Any integrations using it will break until updated with the new key.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={rotateMutation.isPending}>Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={(e) => { e.preventDefault(); rotateMutation.mutate(); }}
                disabled={rotateMutation.isPending}
                className="bg-status-busy hover:bg-status-busy/90"
              >
                {rotateMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Rotate Key'}
              </AlertDialogAction>
            </AlertDialogFooter>
          </div>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
};

export default AdminTenantDetail;
