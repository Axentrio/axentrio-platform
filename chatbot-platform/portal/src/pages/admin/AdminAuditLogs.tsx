/**
 * Admin Audit Logs Page
 * Super admin view: platform-wide audit log with optional tenant filter.
 */

import React, { useState } from 'react';
import { Search } from 'lucide-react';
import { PageSkeleton } from '@/components/ui/page-skeleton';
import { useAdminTenants, useAdminAuditLogs } from '../../queries/useAdminQueries';
import { Card, CardContent } from '@/components/ui/card';
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

/* ------------------------------------------------------------------ */
/*  Types                                                               */
/* ------------------------------------------------------------------ */

interface AuditLog {
  id: string;
  action: string;
  entityType: string;
  entityId: string;
  actorName: string;
  tenantName?: string;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

interface AdminTenant {
  id: string;
  name: string;
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                             */
/* ------------------------------------------------------------------ */

function formatTime(iso: string): string {
  return new Date(iso).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatAction(action: string): string {
  return action.replace(/\./g, ' ').replace(/_/g, ' ');
}

/* ------------------------------------------------------------------ */
/*  Component                                                           */
/* ------------------------------------------------------------------ */

const AdminAuditLogs: React.FC = () => {
  const [search, setSearch] = useState('');
  const [tenantId, setTenantId] = useState<string>('all');

  /* ---- Data ---- */
  const { data: tenantsData, isLoading: isLoadingTenants } = useAdminTenants();
  const tenants = (tenantsData as AdminTenant[] | undefined) ?? [];

  const params: Record<string, unknown> = {};
  if (tenantId !== 'all') params.tenantId = tenantId;

  const { data: logsData, isLoading: isLoadingLogs, isError } = useAdminAuditLogs(params);
  const allLogs = (logsData as AuditLog[] | undefined) ?? [];

  /* ---- Derived list ---- */
  const filtered = allLogs.filter((log) => {
    if (search.trim() === '') return true;
    const q = search.toLowerCase();
    return (
      log.actorName?.toLowerCase().includes(q) ||
      log.action?.toLowerCase().includes(q) ||
      log.entityType?.toLowerCase().includes(q) ||
      log.tenantName?.toLowerCase().includes(q)
    );
  });

  const isLoading = isLoadingLogs;

  /* ---- Render ---- */
  return (
    <div className="h-full overflow-y-auto p-6">
      {/* Header */}
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-text-primary">Audit Logs</h1>
        <p className="text-text-secondary mt-1">Platform-wide activity log across all tenants.</p>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-3 mb-5">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-text-muted" />
          <Input
            placeholder="Search by actor, action, or entity..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
          />
        </div>

        <Select
          value={tenantId}
          onValueChange={(v) => setTenantId(v)}
          disabled={isLoadingTenants}
        >
          <SelectTrigger className="w-[200px]">
            <SelectValue placeholder="All Tenants" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Tenants</SelectItem>
            {tenants.map((t) => (
              <SelectItem key={t.id} value={t.id}>
                {t.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Table */}
      <Card variant="glass" className="overflow-hidden">
        <CardContent className="p-0">
          {isLoading ? (
            <PageSkeleton variant="table" rows={8} />
          ) : isError ? (
            <div className="p-6 text-text-secondary">Failed to load audit logs.</div>
          ) : filtered.length === 0 ? (
            <div className="p-6 text-text-muted text-center">No audit logs found.</div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Time</TableHead>
                  <TableHead>Actor</TableHead>
                  <TableHead>Tenant</TableHead>
                  <TableHead>Action</TableHead>
                  <TableHead>Entity</TableHead>
                  <TableHead>Details</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((log) => (
                  <TableRow key={log.id}>
                    <TableCell className="text-text-secondary text-sm whitespace-nowrap">
                      {formatTime(log.createdAt)}
                    </TableCell>
                    <TableCell className="text-text-primary text-sm">{log.actorName}</TableCell>
                    <TableCell className="text-text-secondary text-sm">
                      {log.tenantName ?? '—'}
                    </TableCell>
                    <TableCell>
                      <Badge className="bg-surface-3 text-text-secondary border-edge capitalize">
                        {formatAction(log.action)}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-text-secondary text-sm">
                      <span className="capitalize">{log.entityType}</span>
                    </TableCell>
                    <TableCell className="text-text-muted text-xs font-mono max-w-[200px] truncate">
                      {log.metadata ? JSON.stringify(log.metadata) : '—'}
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
          Showing {filtered.length} of {allLogs.length} log{allLogs.length !== 1 ? 's' : ''}
        </p>
      )}
    </div>
  );
};

export default AdminAuditLogs;
