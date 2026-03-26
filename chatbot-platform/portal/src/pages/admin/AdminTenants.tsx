/**
 * Admin Tenants Page
 * Super admin view: list all tenants with suspend/activate actions.
 */

import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Loader2, Search, Plus } from 'lucide-react';
import { api } from '@services/apiClient';
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

interface TenantsApiResponse {
  success: boolean;
  data: AdminTenant[];
  meta: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
    hasMore: boolean;
  };
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
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [tierFilter, setTierFilter] = useState<TenantTier | 'all'>('all');
  const [statusFilter, setStatusFilter] = useState<TenantStatus | 'all'>('all');
  const [showCreate, setShowCreate] = useState(false);
  const [newTenant, setNewTenant] = useState({ name: '', tier: 'free' as TenantTier, adminEmail: '' });

  /* ---- Data ---- */
  const { data, isLoading, isError } = useQuery<TenantsApiResponse>({
    queryKey: ['admin', 'tenants'],
    queryFn: () => api.get('/admin/tenants'),
  });

  /* ---- Mutations ---- */
  const suspendMutation = useMutation({
    mutationFn: (id: string) => api.post(`/admin/tenants/${id}/suspend`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'tenants'] });
      queryClient.invalidateQueries({ queryKey: ['admin-tenants-switcher'] });
      toast.success('Tenant suspended.');
    },
    onError: () => toast.error('Failed to suspend tenant.'),
  });

  const activateMutation = useMutation({
    mutationFn: (id: string) => api.post(`/admin/tenants/${id}/activate`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'tenants'] });
      queryClient.invalidateQueries({ queryKey: ['admin-tenants-switcher'] });
      toast.success('Tenant activated.');
    },
    onError: () => toast.error('Failed to activate tenant.'),
  });

  const createMutation = useMutation({
    mutationFn: (payload: { name: string; tier: string; adminEmail?: string }) =>
      api.post('/admin/tenants', payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'tenants'] });
      queryClient.invalidateQueries({ queryKey: ['admin-tenants-switcher'] });
      toast.success('Tenant created.');
      setShowCreate(false);
      setNewTenant({ name: '', tier: 'free', adminEmail: '' });
    },
    onError: () => toast.error('Failed to create tenant.'),
  });

  /* ---- Derived list ---- */
  const tenants = data?.data ?? [];
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

  /* ---- Render ---- */
  return (
    <div className="h-full overflow-y-auto p-6">
      {/* Header */}
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-text-primary">Tenants</h1>
          <p className="text-text-secondary mt-1">Manage all tenants across the platform.</p>
        </div>
        <Button onClick={() => setShowCreate(true)} className="gap-1.5">
          <Plus className="w-4 h-4" />
          Create Tenant
        </Button>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-3 mb-5">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-text-muted" />
          <Input
            placeholder="Search by name or slug..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
          />
        </div>

        <Select value={tierFilter} onValueChange={(v) => setTierFilter(v as TenantTier | 'all')}>
          <SelectTrigger className="w-[140px]">
            <SelectValue placeholder="Tier" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Tiers</SelectItem>
            <SelectItem value="free">Free</SelectItem>
            <SelectItem value="pro">Pro</SelectItem>
            <SelectItem value="enterprise">Enterprise</SelectItem>
          </SelectContent>
        </Select>

        <Select
          value={statusFilter}
          onValueChange={(v) => setStatusFilter(v as TenantStatus | 'all')}
        >
          <SelectTrigger className="w-[150px]">
            <SelectValue placeholder="Status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Statuses</SelectItem>
            <SelectItem value="active">Active</SelectItem>
            <SelectItem value="suspended">Suspended</SelectItem>
            <SelectItem value="cancelled">Cancelled</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Table */}
      <Card variant="glass" className="overflow-hidden">
        <CardContent className="p-0">
          {isLoading ? (
            <div className="flex items-center justify-center h-48">
              <Loader2 className="w-6 h-6 animate-spin text-text-muted" />
              <span className="ml-2 text-text-secondary">Loading tenants...</span>
            </div>
          ) : isError ? (
            <div className="p-6 text-text-secondary">Failed to load tenants.</div>
          ) : filtered.length === 0 ? (
            <div className="p-6 text-text-muted text-center">No tenants found.</div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Slug</TableHead>
                  <TableHead>Tier</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((tenant) => (
                  <TableRow key={tenant.id}>
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
                        {tenant.tier.charAt(0).toUpperCase() + tenant.tier.slice(1)}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <Badge className={statusBadgeClass(tenant.status)}>
                        {tenant.status.charAt(0).toUpperCase() + tenant.status.slice(1)}
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
                          onClick={() => suspendMutation.mutate(tenant.id)}
                          className="text-status-busy border-status-busy/30 hover:bg-status-busy/10"
                        >
                          {suspendMutation.isPending ? (
                            <Loader2 className="w-3 h-3 animate-spin" />
                          ) : (
                            'Suspend'
                          )}
                        </Button>
                      ) : tenant.status === 'suspended' ? (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={isMutating}
                          onClick={() => activateMutation.mutate(tenant.id)}
                          className="text-status-online border-status-online/30 hover:bg-status-online/10"
                        >
                          {activateMutation.isPending ? (
                            <Loader2 className="w-3 h-3 animate-spin" />
                          ) : (
                            'Activate'
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
          Showing {filtered.length} of {tenants.length} tenant{tenants.length !== 1 ? 's' : ''}
        </p>
      )}

      {/* Create Tenant Dialog */}
      <AlertDialog open={showCreate} onOpenChange={(open) => !open && setShowCreate(false)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Create New Tenant</AlertDialogTitle>
            <AlertDialogDescription>
              Create a new tenant organization. A Clerk organization will be created automatically.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-4 py-2">
            <div>
              <label className="text-sm font-medium text-text-secondary mb-1 block">
                Tenant Name *
              </label>
              <Input
                placeholder="e.g. Acme Corp"
                value={newTenant.name}
                onChange={(e) => setNewTenant((s) => ({ ...s, name: e.target.value }))}
              />
            </div>
            <div>
              <label className="text-sm font-medium text-text-secondary mb-1 block">Tier</label>
              <Select
                value={newTenant.tier}
                onValueChange={(v) => setNewTenant((s) => ({ ...s, tier: v as TenantTier }))}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="free">Free</SelectItem>
                  <SelectItem value="pro">Pro</SelectItem>
                  <SelectItem value="enterprise">Enterprise</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="text-sm font-medium text-text-secondary mb-1 block">
                Admin Email (optional)
              </label>
              <Input
                type="email"
                placeholder="admin@example.com"
                value={newTenant.adminEmail}
                onChange={(e) => setNewTenant((s) => ({ ...s, adminEmail: e.target.value }))}
              />
              <p className="text-xs text-text-muted mt-1">
                If provided, this user will be invited as the tenant admin.
              </p>
            </div>
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={!newTenant.name.trim() || createMutation.isPending}
              onClick={() =>
                createMutation.mutate({
                  name: newTenant.name.trim(),
                  tier: newTenant.tier,
                  ...(newTenant.adminEmail.trim() && { adminEmail: newTenant.adminEmail.trim() }),
                })
              }
            >
              {createMutation.isPending ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                'Create'
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
};

export default AdminTenants;
