import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Loader2, Receipt } from 'lucide-react';
import { PageSkeleton } from '@/components/ui/page-skeleton';
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
import { LegalInvoiceStatusPills } from '@/components/admin/LegalInvoiceStatusPills';
import {
  useAdminLegalInvoices,
  useRetryLegalInvoice,
  useRetryWaitingLegalInvoices,
  type AdminLegalInvoice,
} from '../../queries/useAdminQueries';

function formatMoney(cents: number, currency: string): string {
  return `${(cents / 100).toFixed(2)} ${currency}`;
}

function formatWhen(iso: string): string {
  return new Date(iso).toLocaleString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export default function AdminLegalInvoices() {
  const { t } = useTranslation();
  const [searchParams] = useSearchParams();
  const focusId = searchParams.get('invoice');
  const { data, isLoading, isError } = useAdminLegalInvoices();
  const retryWaiting = useRetryWaitingLegalInvoices();
  const [onlyAttention, setOnlyAttention] = useState(true);
  const invoices = data?.invoices ?? [];
  const visible = useMemo(() => {
    const base = onlyAttention ? invoices.filter((row) => row.retryable) : invoices;
    if (!focusId) return base;
    if (base.some((row) => row.id === focusId)) return base;
    const focused = invoices.find((row) => row.id === focusId);
    return focused ? [focused, ...base] : base;
  }, [invoices, onlyAttention, focusId]);

  useEffect(() => {
    if (!focusId) return;
    document.getElementById(`legal-invoice-${focusId}`)?.scrollIntoView({ block: 'center' });
  }, [focusId, visible.length]);

  if (isLoading) return <PageSkeleton variant="list" rows={6} />;

  if (isError) {
    return (
      <div className="p-6">
        <p className="text-text-secondary">{t('admin.legalInvoices.errors.loadFailed')}</p>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto p-6 space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <Receipt className="w-5 h-5 text-primary-400" />
            <h1 className="text-2xl font-bold text-text-primary">{t('admin.legalInvoices.title')}</h1>
          </div>
          <p className="text-sm text-text-muted mt-1">{t('admin.legalInvoices.subtitle')}</p>
        </div>
        <Button
          onClick={() => retryWaiting.mutate()}
          disabled={retryWaiting.isPending || (data?.attentionCount ?? 0) === 0}
        >
          {retryWaiting.isPending ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            t('admin.legalInvoices.retryWaiting')
          )}
        </Button>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <Card variant="glass" className="p-5">
          <p className="text-2xl font-bold font-mono text-text-primary">{data?.attentionCount ?? 0}</p>
          <p className="text-xs text-text-muted">{t('admin.legalInvoices.stats.attention')}</p>
        </Card>
        <Card variant="glass" className="p-5">
          <p className="text-2xl font-bold font-mono text-text-primary">{data?.total ?? 0}</p>
          <p className="text-xs text-text-muted">{t('admin.legalInvoices.stats.total')}</p>
        </Card>
      </div>

      <div className="flex gap-2">
        <Button size="sm" variant={onlyAttention ? 'default' : 'outline'} onClick={() => setOnlyAttention(true)}>
          {t('admin.legalInvoices.filters.attention')}
        </Button>
        <Button size="sm" variant={!onlyAttention ? 'default' : 'outline'} onClick={() => setOnlyAttention(false)}>
          {t('admin.legalInvoices.filters.all')}
        </Button>
      </div>

      <Card variant="glass" className="overflow-hidden">
        {visible.length === 0 ? (
          <div className="px-6 py-10 text-center text-sm text-text-muted">
            {t('admin.legalInvoices.empty')}
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('admin.legalInvoices.columns.tenant')}</TableHead>
                <TableHead>{t('admin.legalInvoices.columns.number')}</TableHead>
                <TableHead>{t('admin.legalInvoices.columns.amount')}</TableHead>
                <TableHead>{t('admin.legalInvoices.columns.status')}</TableHead>
                <TableHead>{t('admin.legalInvoices.columns.error')}</TableHead>
                <TableHead>{t('admin.legalInvoices.columns.when')}</TableHead>
                <TableHead className="text-right">{t('admin.legalInvoices.columns.actions')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visible.map((row) => (
                <InvoiceRow key={row.id} row={row} focused={row.id === focusId} />
              ))}
            </TableBody>
          </Table>
        )}
      </Card>
    </div>
  );
}

function InvoiceRow({ row, focused }: { row: AdminLegalInvoice; focused: boolean }) {
  const { t } = useTranslation();
  const retry = useRetryLegalInvoice(row.tenantId);
  return (
    <TableRow
      id={`legal-invoice-${row.id}`}
      data-focused={focused || undefined}
      className={focused ? 'bg-primary-500/10 ring-1 ring-inset ring-primary-400/40' : undefined}
    >
      <TableCell>
        <Link to={`/admin/tenants/${row.tenantId}`} className="text-primary-400 hover:underline">
          {row.tenantName ?? row.tenantId}
        </Link>
        <p className="text-[11px] text-text-muted font-mono">{row.documentKind}</p>
      </TableCell>
      <TableCell className="font-mono text-xs">
        {row.billitInvoiceNumber ?? '—'}
        <p className="text-[11px] text-text-muted">{row.stripeInvoiceId ?? row.stripeRefundId ?? ''}</p>
      </TableCell>
      <TableCell className="font-mono text-xs">{formatMoney(row.amountInclCents, row.currency)}</TableCell>
      <TableCell>
        <LegalInvoiceStatusPills
          paymentStatus={row.paymentStatus}
          invoiceStatus={row.invoiceStatus}
          peppolStatus={row.peppolStatus}
        />
      </TableCell>
      <TableCell className="max-w-[220px]">
        {row.lastError ? (
          <Badge className="bg-status-busy/10 text-status-busy border-status-busy/20 whitespace-normal text-left">
            {row.lastError}
          </Badge>
        ) : (
          <span className="text-text-muted">—</span>
        )}
      </TableCell>
      <TableCell className="text-xs text-text-secondary whitespace-nowrap">{formatWhen(row.createdAt)}</TableCell>
      <TableCell className="text-right">
        {row.retryable ? (
          <Button size="sm" variant="outline" disabled={retry.isPending} onClick={() => retry.mutate(row.id)}>
            {retry.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : t('admin.legalInvoices.retry')}
          </Button>
        ) : null}
      </TableCell>
    </TableRow>
  );
}
