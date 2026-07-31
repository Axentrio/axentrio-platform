/**
 * Leads Page.
 *
 * The tenant's lead register, backed by `chatbot_leads`. Two column sets:
 *   - basic (every entitled tier): name, contact, request, source, status, captured
 *   - structured (`leadEnrichment`): + address, requested service, preferred date,
 *     booking status, list price
 *
 * The structured set is DERIVED server-side from the lead's booking, not copied and
 * not model-generated, so nothing here needs an "AI guessed this" affordance. The
 * server omits those keys entirely when unentitled, so the columns simply don't render.
 */

import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import {
  Mail,
  Phone,
  MessageSquare,
  Inbox,
  ChevronRight,
  Download,
  Loader2,
  Archive,
  RotateCcw,
  MapPin,
  Trash2,
} from 'lucide-react';
import { useHasFeature, useIsEntitled } from '../queries/useEntitlementsQueries';
import {
  useLeadsInfinite,
  useUpdateLeadStatus,
  useEraseLead,
  type Lead,
  type LeadFilters,
} from '../queries/useLeadsQueries';
import { LockedPreview } from '../components/billing/LockedPreview';
import { FeatureDisabledNotice } from '../components/billing/FeatureDisabledNotice';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
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
import { AddLeadControls } from '../components/leads/AddLeadControls';
import { LeadSyncRow } from '../components/leads/LeadSyncRow';
import { LeadRetentionCard } from '../components/leads/LeadRetentionCard';
import { api } from '../services/apiClient';

function formatRelative(iso: string): string {
  const date = new Date(iso);
  const diffMs = Date.now() - date.getTime();
  const diffMin = Math.floor(diffMs / 60_000);
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 30) return `${diffDay}d ago`;
  return date.toLocaleDateString();
}

/** Live bookings read as success; cancelled/failed must not. */
function bookingVariant(status: string): 'success' | 'warning' | 'secondary' {
  if (status === 'cancelled' || status === 'failed') return 'warning';
  if (status === 'confirmed') return 'success';
  return 'secondary';
}

/**
 * Price label. `priceBasis` exists precisely so a "from €80" service is never shown
 * as a flat €80 — presenting a floor as a quote would misrepresent the tenant's own
 * pricing to their operator.
 */
function priceLabel(lead: Lead): string {
  if (lead.servicePrice == null) return '—';
  const amount = new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency: 'EUR',
    maximumFractionDigits: 2,
  }).format(lead.servicePrice);
  if (lead.priceBasis === 'from') return `from ${amount}`;
  if (lead.priceBasis === 'range_mid') return `~${amount}`;
  return amount;
}

type StatusFilter = 'all' | 'new' | 'archived';

export default function Leads() {
  const { t } = useTranslation();
  const isEntitled = useIsEntitled('leadCapture');
  const hasLeadCapture = useHasFeature('leadCapture'); // effective (entitled ∧ tenant toggle)
  const hasEnrichment = useHasFeature('leadEnrichment');

  // Defaults to 'all'. A default of "hide handled" would make every existing
  // tenant's visible lead count drop on deploy, which reads as data loss.
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const filters: LeadFilters = useMemo(
    () => (statusFilter === 'all' ? {} : { status: statusFilter }),
    [statusFilter],
  );

  const { data, isLoading, hasNextPage, fetchNextPage, isFetchingNextPage } =
    useLeadsInfinite(filters);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [pendingErase, setPendingErase] = useState<Lead | null>(null);
  const updateStatus = useUpdateLeadStatus();
  const eraseLead = useEraseLead();
  const [exporting, setExporting] = useState(false);

  const exportCsv = async () => {
    setExporting(true);
    try {
      // Server names the file (it encodes the exported date range); the helper
      // honours Content-Disposition so a future .xlsx isn't mislabelled .csv.
      const { truncated, rowLimit } = await api.download('/leads/export', 'leads.csv');
      if (truncated) {
        // Never let a row-capped file pass as the full history.
        toast.warning(
          t('leads.export.truncated', {
            defaultValue:
              'Only the {{limit}} most recent leads were exported. Narrow the date range to export the rest.',
            limit: rowLimit ?? 10000,
          }),
        );
      }
    } catch (err) {
      // Bulk lead export is admin/supervisor-only — tell an agent seat that rather
      // than leaving them to retry a generic "Export failed".
      const status = (err as { response?: { status?: number } })?.response?.status;
      toast.error(
        status === 403
          ? t('leads.export.forbidden', {
              defaultValue: 'Only admins and supervisors can export leads.',
            })
          : t('leads.export.error', { defaultValue: 'Export failed' }),
      );
    } finally {
      setExporting(false);
    }
  };

  const confirmErase = async () => {
    if (!pendingErase) return;
    const lead = pendingErase;
    setPendingErase(null);
    try {
      const res = await eraseLead.mutateAsync(lead.id);
      toast.success(
        t('leads.erase.done', {
          defaultValue: 'Personal data erased. The chat transcript was kept.',
        }),
      );
      if (!res.transcriptRetained) return;
    } catch (err) {
      const status = (err as { response?: { status?: number } })?.response?.status;
      toast.error(
        status === 403
          ? t('leads.erase.forbidden', {
              defaultValue: 'Only admins and supervisors can erase a lead.',
            })
          : t('leads.erase.error', { defaultValue: 'Could not erase this lead' }),
      );
    }
  };

  // Not entitled → upsell. Entitled but toggled off → opt-out notice (never upsell).
  if (!isEntitled) {
    return (
      <LockedPreview
        feature="leadCapture"
        // Essential already includes leadCapture, so the upsell must not advertise
        // Pro as the requirement — that was pointing paying tenants at the wrong plan.
        requiredTier="essential"
        title={t('leads.locked.title')}
        oneLiner={t('leads.locked.oneLiner')}
        bullets={[
          t('leads.locked.bullets.1'),
          t('leads.locked.bullets.2'),
          t('leads.locked.bullets.3'),
        ]}
      />
    );
  }
  if (!hasLeadCapture) {
    return <FeatureDisabledNotice featureLabel={t('features.keys.leadCapture.label', { defaultValue: 'Leads' })} />;
  }

  const allLeads = data?.pages.flatMap((p) => p.leads) ?? [];
  const colCount = hasEnrichment ? 9 : 5;

  return (
    <div className={`h-full overflow-y-auto p-6 space-y-4 ${hasEnrichment ? '' : 'max-w-5xl mx-auto'}`}>
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-text-primary">{t('leads.title')}</h1>
          <p className="text-sm text-text-secondary mt-1">{t('leads.intro')}</p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
        <AddLeadControls />
        {allLeads.length > 0 && (
          <Button variant="outline" size="sm" onClick={exportCsv} disabled={exporting}>
            {exporting ? (
              <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
            ) : (
              <Download className="h-3.5 w-3.5 mr-1.5" />
            )}
            {/* "for Excel" is load-bearing, not marketing: the file carries a
                `sep=;` hint that Excel honours in every locale but that a strict
                CSV parser sees as a stray first row. */}
            {t('leads.export.label', { defaultValue: 'Export for Excel' })}
          </Button>
        )}
        </div>
      </div>

      {/* Server-side filter, so the result reflects the whole dataset rather than
          just the pages already fetched. */}
      <div
        className="flex items-center gap-1.5"
        role="group"
        aria-label={t('leads.filter.label', { defaultValue: 'Filter leads by status' })}
      >
        {(['all', 'new', 'archived'] as const).map((key) => (
          <Button
            key={key}
            variant={statusFilter === key ? 'default' : 'outline'}
            size="sm"
            aria-pressed={statusFilter === key}
            onClick={() => setStatusFilter(key)}
          >
            {t(`leads.filter.${key}`, {
              defaultValue: key === 'all' ? 'All' : key === 'new' ? 'Open' : 'Handled',
            })}
          </Button>
        ))}
      </div>

      {isLoading ? (
        <div className="rounded-xl border border-edge bg-surface-1 p-8 text-center">
          <p className="text-sm text-text-secondary">{t('common.loading')}</p>
        </div>
      ) : allLeads.length === 0 ? (
        <div className="rounded-xl border border-edge bg-surface-1 p-12 text-center">
          <div className="inline-flex h-12 w-12 items-center justify-center rounded-full bg-primary-600/10 mb-3">
            <Inbox className="h-6 w-6 text-primary-400" />
          </div>
          <h2 className="text-base font-semibold text-text-primary mb-1">
            {statusFilter === 'all'
              ? t('leads.empty.title')
              : t('leads.empty.filtered', { defaultValue: 'No leads match this filter' })}
          </h2>
          <p className="text-sm text-text-secondary max-w-md mx-auto">{t('leads.empty.body')}</p>
        </div>
      ) : (
        <>
          <div className="rounded-xl border border-edge bg-surface-1 overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('leads.table.name')}</TableHead>
                  <TableHead>{t('leads.table.contact')}</TableHead>
                  <TableHead>{t('leads.table.request', { defaultValue: 'Request' })}</TableHead>
                  {hasEnrichment && (
                    <>
                      <TableHead>{t('leads.table.service', { defaultValue: 'Service' })}</TableHead>
                      <TableHead>{t('leads.table.address', { defaultValue: 'Address' })}</TableHead>
                      <TableHead>{t('leads.table.preferredAt', { defaultValue: 'Preferred' })}</TableHead>
                      <TableHead>{t('leads.table.booking', { defaultValue: 'Booking' })}</TableHead>
                    </>
                  )}
                  <TableHead>{t('leads.table.status', { defaultValue: 'Status' })}</TableHead>
                  <TableHead className="w-24" aria-label="Actions" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {allLeads.map((lead) => {
                  const isOpen = expanded[lead.id];
                  return [
                    <TableRow
                      key={lead.id}
                      className={`cursor-pointer ${lead.status === 'archived' ? 'opacity-50' : ''}`}
                      onClick={() => setExpanded((s) => ({ ...s, [lead.id]: !s[lead.id] }))}
                    >
                      <TableCell className="font-medium text-text-primary">
                        <span className="flex items-center gap-2">
                          {lead.name || (
                            <span className="text-text-muted italic">
                              {t('leads.table.noName', { defaultValue: 'No name' })}
                            </span>
                          )}
                          {lead.channel && lead.channel !== 'widget' && (
                            <Badge variant="secondary" className="uppercase text-[10px]">
                              {lead.channel}
                            </Badge>
                          )}
                        </span>
                      </TableCell>
                      <TableCell className="text-text-secondary">
                        {lead.email && (
                          <div className="flex items-center gap-1.5">
                            <Mail className="h-3.5 w-3.5 text-text-muted" />
                            <span className="truncate">{lead.email}</span>
                          </div>
                        )}
                        {lead.phone && (
                          <div className="flex items-center gap-1.5 mt-0.5">
                            <Phone className="h-3.5 w-3.5 text-text-muted" />
                            <span>{lead.phone}</span>
                          </div>
                        )}
                        {!lead.email && !lead.phone && (
                          <span className="text-text-muted">
                            {t('leads.table.reachVia', {
                              defaultValue: 'Reply via {{channel}}',
                              channel: lead.channel ?? 'chat',
                            })}
                          </span>
                        )}
                      </TableCell>
                      {/* Model-authored free text: rendered as text only, never as markup. */}
                      <TableCell className="text-text-secondary">
                        <span className="block max-w-[18rem] truncate" title={lead.notes ?? undefined}>
                          {lead.notes || <span className="text-text-muted">—</span>}
                        </span>
                      </TableCell>
                      {hasEnrichment && (
                        <>
                          <TableCell className="text-text-secondary">
                            {lead.serviceRequested || <span className="text-text-muted">—</span>}
                            {lead.servicePrice != null && (
                              <span className="block text-xs text-text-muted">{priceLabel(lead)}</span>
                            )}
                          </TableCell>
                          <TableCell className="text-text-secondary">
                            {lead.address ? (
                              <span className="flex items-center gap-1.5">
                                <MapPin className="h-3.5 w-3.5 text-text-muted shrink-0" />
                                <span className="max-w-[14rem] truncate" title={lead.address}>
                                  {lead.address}
                                </span>
                              </span>
                            ) : (
                              <span className="text-text-muted">—</span>
                            )}
                          </TableCell>
                          <TableCell className="text-text-secondary whitespace-nowrap">
                            {lead.preferredAt ? (
                              new Date(lead.preferredAt).toLocaleString()
                            ) : (
                              <span className="text-text-muted">—</span>
                            )}
                          </TableCell>
                          <TableCell>
                            {lead.bookingStatus ? (
                              <span className="flex items-center gap-1.5">
                                <Badge variant={bookingVariant(lead.bookingStatus)}>
                                  {lead.bookingStatus}
                                </Badge>
                                {(lead.bookingCount ?? 0) > 1 && (
                                  <span className="text-xs text-text-muted">
                                    +{(lead.bookingCount ?? 1) - 1}
                                  </span>
                                )}
                              </span>
                            ) : (
                              <span className="text-text-muted">—</span>
                            )}
                          </TableCell>
                        </>
                      )}
                      <TableCell>
                        <Badge variant={lead.status === 'archived' ? 'secondary' : 'outline'}>
                          {lead.status === 'archived'
                            ? t('leads.status.archived', { defaultValue: 'Handled' })
                            : t('leads.status.new', { defaultValue: 'Open' })}
                        </Badge>
                        <span
                          className="block text-xs text-text-muted mt-0.5"
                          title={new Date(lead.createdAt).toLocaleString()}
                        >
                          {formatRelative(lead.createdAt)}
                        </span>
                      </TableCell>
                      <TableCell className="text-text-muted">
                        <div className="flex items-center justify-end gap-1">
                          <button
                            type="button"
                            title={
                              lead.status === 'archived'
                                ? t('leads.actions.reopen', { defaultValue: 'Reopen' })
                                : t('leads.actions.archive', { defaultValue: 'Mark handled' })
                            }
                            className="rounded p-1 hover:bg-surface-3 hover:text-text-secondary disabled:opacity-50"
                            disabled={updateStatus.isPending}
                            onClick={(e) => {
                              e.stopPropagation();
                              updateStatus.mutate({
                                id: lead.id,
                                status: lead.status === 'archived' ? 'new' : 'archived',
                              });
                            }}
                          >
                            {lead.status === 'archived' ? (
                              <RotateCcw className="h-3.5 w-3.5" />
                            ) : (
                              <Archive className="h-3.5 w-3.5" />
                            )}
                          </button>
                          <button
                            type="button"
                            title={t('leads.actions.erase', { defaultValue: 'Erase personal data' })}
                            className="rounded p-1 hover:bg-surface-3 hover:text-destructive disabled:opacity-50"
                            disabled={eraseLead.isPending}
                            onClick={(e) => {
                              e.stopPropagation();
                              setPendingErase(lead);
                            }}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                          <ChevronRight
                            className={`h-4 w-4 transition-transform ${isOpen ? 'rotate-90' : ''}`}
                          />
                        </div>
                      </TableCell>
                    </TableRow>,
                    isOpen ? (
                      <TableRow key={`${lead.id}-detail`} className="bg-surface-2/30 hover:bg-surface-2/30">
                        <TableCell colSpan={colCount} className="text-xs text-text-muted">
                          <div className="space-y-1">
                            {lead.sessionId && (
                              <div className="flex items-center gap-1.5">
                                <MessageSquare className="h-3.5 w-3.5" />
                                <span>{t('leads.detail.fromSession')}</span>
                                <code className="font-mono">{lead.sessionId.slice(0, 8)}…</code>
                                {(lead.conversationCount ?? 0) > 1 && (
                                  <span>
                                    {t('leads.detail.conversations', {
                                      defaultValue: '({{count}} conversations)',
                                      count: lead.conversationCount ?? 1,
                                    })}
                                  </span>
                                )}
                              </div>
                            )}
                            {lead.notes && (
                              <div>
                                <span className="font-medium">{t('leads.detail.notes')}:</span> {lead.notes}
                              </div>
                            )}
                            {/* Owner-authored intake answers — the customer's own words,
                                collected at booking time. */}
                            {lead.intakeAnswers &&
                              Object.entries(lead.intakeAnswers).map(([k, v]) => (
                                <div key={k}>
                                  <span className="font-medium">{k}:</span> {String(v)}
                                </div>
                              ))}
                            <div>
                              <span className="font-medium">{t('leads.detail.createdAt')}:</span>{' '}
                              {new Date(lead.createdAt).toLocaleString()}
                            </div>
                            {/* Fetched only now, on expand — see useLeadSyncStatus. */}
                            <LeadSyncRow leadId={lead.id} />
                          </div>
                        </TableCell>
                      </TableRow>
                    ) : null,
                  ];
                })}
              </TableBody>
            </Table>
          </div>

          {hasNextPage && (
            <div className="flex justify-center">
              <Button
                variant="outline"
                size="sm"
                onClick={() => fetchNextPage()}
                disabled={isFetchingNextPage}
              >
                {isFetchingNextPage ? t('common.loading') : t('leads.loadMore')}
              </Button>
            </div>
          )}
        </>
      )}

      {/* Retention: the expiry policy for everything above it. Placed here rather than
          in Settings so it sits next to the data it governs. */}
      <LeadRetentionCard />

      {/* Erasure is irreversible and spans several stores, so it gets an explicit
          confirmation that says what will and will NOT be removed. */}
      <AlertDialog open={pendingErase !== null} onOpenChange={(open) => !open && setPendingErase(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t('leads.erase.title', { defaultValue: 'Erase this lead’s personal data?' })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t('leads.erase.body', {
                defaultValue:
                  'This permanently removes the name, contact details and request from this lead, from any alerts about it, and from anything already sent to a connected system. It cannot be undone. The chat transcript itself is kept.',
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel', { defaultValue: 'Cancel' })}</AlertDialogCancel>
            <AlertDialogAction onClick={confirmErase}>
              {t('leads.erase.confirm', { defaultValue: 'Erase' })}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
