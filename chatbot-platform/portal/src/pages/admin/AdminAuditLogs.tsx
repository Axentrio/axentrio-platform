/**
 * Admin Audit Logs Page
 * Super admin view: platform-wide audit log with filters, export, and pagination.
 */

import React, { useState } from 'react';
import { Download } from 'lucide-react';
import { PageSkeleton } from '@/components/ui/page-skeleton';
import { useAdminTenants, useAdminAuditLogs, downloadAuditLogsCsv } from '../../queries/useAdminQueries';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Pagination } from '@/components/ui/Pagination';
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
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

const ACTION_OPTIONS = [
  'user.deactivated',
  'user.reactivated',
  'user.role_changed',
  'user.deleted',
  'user.promoted',
  'user.demoted',
  'invite.sent',
  'invite.resent',
  'invite.cancelled',
  'tenant.created',
  'tenant.updated',
  'tenant.suspended',
  'tenant.activated',
  'apikey.rotated',
] as const;

const PAGE_SIZE = 25;

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface AuditLog {
  id: string;
  action: string;
  entityType: string;
  entityId: string;
  actorName: string;
  tenantName?: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

interface AdminTenant {
  id: string;
  name: string;
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
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
/*  Component                                                          */
/* ------------------------------------------------------------------ */

const AdminAuditLogs: React.FC = () => {
  const [tenantId, setTenantId] = useState<string>('all');
  const [action, setAction] = useState<string>('all');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [page, setPage] = useState(1);
  const [isExporting, setIsExporting] = useState(false);

  /* ---- Data ---- */
  const { data: tenantsData, isLoading: isLoadingTenants } = useAdminTenants();
  const tenants = (tenantsData as AdminTenant[] | undefined) ?? [];

  const params: Record<string, unknown> = { page, limit: PAGE_SIZE };
  if (tenantId !== 'all') params.tenantId = tenantId;
  if (action !== 'all') params.action = action;
  if (fromDate) params.from = fromDate;
  if (toDate) params.to = toDate;

  const { data: response, isLoading, isError } = useAdminAuditLogs(params);
  const logs = ((response as { data?: AuditLog[] })?.data ?? response ?? []) as AuditLog[];
  const meta = (response as { meta?: { totalPages: number; total: number } })?.meta;

  /* ---- Filter change resets page ---- */
  const handleFilterChange = <T,>(setter: React.Dispatch<React.SetStateAction<T>>) => (value: T) => {
    setter(value);
    setPage(1);
  };

  /* ---- Export ---- */
  const handleExport = async () => {
    setIsExporting(true);
    try {
      const exportParams: Record<string, string> = {};
      if (tenantId !== 'all') exportParams.tenantId = tenantId;
      if (action !== 'all') exportParams.action = action;
      if (fromDate) exportParams.from = fromDate;
      if (toDate) exportParams.to = toDate;
      await downloadAuditLogsCsv(exportParams);
    } finally {
      setIsExporting(false);
    }
  };

  /* ---- Render ---- */
  return (
    <div className="h-full overflow-y-auto p-6">
      {/* Header */}
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-text-primary">Audit Logs</h1>
          <p className="text-text-secondary mt-1">Platform-wide activity log across all tenants.</p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={handleExport}
          disabled={isExporting || isLoading}
        >
          <Download className="w-4 h-4 mr-2" />
          {isExporting ? 'Exporting...' : 'Download CSV'}
        </Button>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-3 mb-5">
        <Select
          value={tenantId}
          onValueChange={handleFilterChange(setTenantId)}
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

        <Select
          value={action}
          onValueChange={handleFilterChange(setAction)}
        >
          <SelectTrigger className="w-[200px]">
            <SelectValue placeholder="All Actions" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Actions</SelectItem>
            {ACTION_OPTIONS.map((a) => (
              <SelectItem key={a} value={a}>
                {formatAction(a)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Input
          type="date"
          value={fromDate}
          onChange={(e) => handleFilterChange(setFromDate)(e.target.value)}
          className="w-[160px]"
          placeholder="From"
        />
        <Input
          type="date"
          value={toDate}
          onChange={(e) => handleFilterChange(setToDate)(e.target.value)}
          className="w-[160px]"
          placeholder="To"
        />
      </div>

      {/* Table */}
      <Card variant="glass" className="overflow-hidden">
        <CardContent className="p-0">
          {isLoading ? (
            <PageSkeleton variant="table" rows={8} />
          ) : isError ? (
            <div className="p-6 text-text-secondary">Failed to load audit logs.</div>
          ) : logs.length === 0 ? (
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
                {logs.map((log) => (
                  <TableRow key={log.id}>
                    <TableCell className="text-text-secondary text-sm whitespace-nowrap">
                      {formatTime(log.createdAt)}
                    </TableCell>
                    <TableCell className="text-text-primary text-sm">{log.actorName}</TableCell>
                    <TableCell className="text-text-secondary text-sm">
                      {log.tenantName ?? '---'}
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
                      {log.metadata ? JSON.stringify(log.metadata) : '---'}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Pagination */}
      {meta && (
        <Pagination
          page={page}
          totalPages={meta.totalPages}
          onPageChange={setPage}
          isLoading={isLoading}
        />
      )}

      {/* Footer count */}
      {!isLoading && !isError && meta && (
        <p className="text-sm text-text-muted mt-1">
          {meta.total} total log{meta.total !== 1 ? 's' : ''}
        </p>
      )}
    </div>
  );
};

export default AdminAuditLogs;
