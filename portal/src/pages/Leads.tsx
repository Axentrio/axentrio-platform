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
import { Trans, useTranslation } from 'react-i18next';
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
  Repeat,
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
import { LeadFollowUp, LeadNextStep } from '../components/leads/LeadFollowUp';
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

/**
 * Whole days since anyone last had contact. Reads `lastActivityAt`, which the server
 * derives once (person_last_seen_at ?? updated_at) and also feeds to the follow-up
 * rule — so this column and the recommendation's own "no contact for N days" reason
 * are the same number rather than two client-side guesses that drift.
 */
function daysWaiting(lead: Lead): number | null {
  const since = lead.lastActivityAt ?? lead.createdAt;
  if (!since) return null;
  const ms = Date.now() - new Date(since).getTime();
  return ms < 0 ? 0 : Math.floor(ms / 86_400_000);
}

/**
 * Severity as FORM, not only as a number: a 3px stripe so the rows that need
 * something doing are found before a single word is read. Ordered by what costs the
 * tenant most — an unconfirmed slot outranks a long silence, which outranks a job
 * already in the diary.
 */
const OVERDUE_DAYS = 30;

function severityClass(lead: Lead, days: number | null): string {
  if (lead.status === 'archived') return '';
  if (lead.followUp?.priority === 'now') return 'shadow-[inset_3px_0_0] shadow-destructive';
  if (days != null && days >= OVERDUE_DAYS) return 'shadow-[inset_3px_0_0] shadow-status-away';
  if (lead.followUp === null || lead.bookingStatus === 'confirmed') {
    return 'shadow-[inset_3px_0_0] shadow-status-online';
  }
  return '';
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
  // Holds the format in flight rather than a boolean, so only the button the user
  // pressed spins — two controls sharing one flag would look like both are working.
  const [exporting, setExporting] = useState<'csv' | 'xlsx' | null>(null);

  const exportLeads = async (format: 'csv' | 'xlsx') => {
    setExporting(format);
    try {
      // Server names the file (it encodes the exported date range AND the extension);
      // the helper honours Content-Disposition so the .xlsx isn't mislabelled .csv.
      const { truncated, rowLimit } = await api.download(
        `/leads/export?format=${format}`,
        `leads.${format}`,
      );
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
      setExporting(null);
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

  // Counted over the LOADED rows, and labelled as such next to the number. The list
  // endpoint returns a cursor and no totals, so anything presented as a whole-dataset
  // figure here would be a guess dressed as a fact.
  const attention = useMemo(() => {
    let overdue = 0;
    let unconfirmed = 0;
    for (const lead of allLeads) {
      if (lead.status === 'archived') continue;
      const days = daysWaiting(lead);
      if (days != null && days >= OVERDUE_DAYS) overdue += 1;
      if (lead.followUp?.action === 'confirm_request') unconfirmed += 1;
    }
    return { overdue, unconfirmed };
  }, [allLeads]);
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
          // Grouped and labelled: on their own, "Excel (.xlsx)" and "CSV" name a file
          // type but never say what the button does.
          <div
            className="flex items-center gap-1.5"
            role="group"
            aria-label={t('leads.export.label', { defaultValue: 'Export leads' })}
          >
            {/* Named by extension rather than intent because that is the only choice
                the user has to make, and both labels are now literally true: .xlsx is a
                real spreadsheet for Excel, and CSV is RFC 4180 for a CRM importer. That
                second claim is only safe because the server stopped emitting the
                Excel-flavoured `sep=;` variant under the CSV name — see the `?format=`
                block in leads.routes.ts. */}
            {(['xlsx', 'csv'] as const).map((format) => (
              <Button
                key={format}
                variant="outline"
                size="sm"
                onClick={() => exportLeads(format)}
                disabled={exporting !== null}
              >
                {exporting === format ? (
                  <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                ) : (
                  <Download className="h-3.5 w-3.5 mr-1.5" />
                )}
                {t(`leads.export.formats.${format}`, {
                  defaultValue: format === 'xlsx' ? 'Excel (.xlsx)' : 'CSV',
                })}
              </Button>
            ))}
          </div>
        )}
        </div>
      </div>

      {/* Orientation before detail: the page used to open with eighteen equal-looking
          rows and leave the operator to work out where to start. Counts are computed
          from the rows actually LOADED and say so — the list endpoint returns no totals,
          and a number that silently meant "of the first page" would be worse than none. */}
      {attention.overdue + attention.unconfirmed > 0 && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border border-edge bg-surface-2 px-4 py-3">
          <p className="text-sm text-text-secondary">
            {attention.overdue > 0 && (
              <Trans
                i18nKey="leads.attention.overdue"
                values={{ count: attention.overdue, days: OVERDUE_DAYS }}
                defaults="<b>{{count}}</b> have heard nothing for over {{days}} days."
                components={{ b: <span className="font-semibold text-text-primary" /> }}
              />
            )}{' '}
            {attention.unconfirmed > 0 && (
              <Trans
                i18nKey="leads.attention.unconfirmed"
                values={{ count: attention.unconfirmed }}
                defaults="<b>{{count}}</b> asked for a time you haven't confirmed."
                components={{ b: <span className="font-semibold text-text-primary" /> }}
              />
            )}
          </p>
          <span className="text-xs text-text-muted">
            {t('leads.attention.scope', {
              defaultValue: 'From the {{loaded}} leads loaded so far',
              loaded: allLeads.length,
            })}
          </span>
        </div>
      )}

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
                  {/* Person merges the old Name + Contact columns: an operator reads
                      "who is this and how do I reach them" as one thought, and splitting
                      it cost a column that was mostly repeating the same person. Service,
                      address, preferred time and price moved into the expanded row — they
                      were empty on most rows and pushed the actionable columns off-screen. */}
                  <TableHead>{t('leads.table.person', { defaultValue: 'Person' })}</TableHead>
                  <TableHead>{t('leads.table.request', { defaultValue: 'What they need' })}</TableHead>
                  <TableHead>{t('leads.table.waiting', { defaultValue: 'Waiting' })}</TableHead>
                  {hasEnrichment && (
                    <>
                      <TableHead>{t('leads.table.nextStep', { defaultValue: 'Next step' })}</TableHead>
                      <TableHead>{t('leads.table.booking', { defaultValue: 'Booking' })}</TableHead>
                    </>
                  )}
                  <TableHead>{t('leads.table.status', { defaultValue: 'Status' })}</TableHead>
                  <TableHead className="w-32" aria-label="Actions" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {allLeads.map((lead) => {
                  const isOpen = expanded[lead.id];
                  const days = daysWaiting(lead);
                  const stripe = severityClass(lead, days);
                  return [
                    <TableRow
                      key={lead.id}
                      className={`cursor-pointer ${stripe} ${lead.status === 'archived' ? 'opacity-50' : ''}`}
                      onClick={() => setExpanded((s) => ({ ...s, [lead.id]: !s[lead.id] }))}
                    >
                      <TableCell>
                        <div className="flex flex-col gap-0.5">
                          <span className="font-medium text-text-primary">
                            {lead.name || (
                              <span className="text-text-muted italic">
                                {t('leads.table.noName', { defaultValue: 'No name' })}
                              </span>
                            )}
                          </span>
                          <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-text-secondary">
                            {lead.channel && (
                              <span className="capitalize">{lead.channel}</span>
                            )}
                            {(lead.email || lead.phone) && <span className="text-text-muted">·</span>}
                            {lead.phone && <span>{lead.phone}</span>}
                            {!lead.phone && lead.email && <span className="truncate">{lead.email}</span>}
                            {!lead.email && !lead.phone && (
                              <span className="text-text-muted">
                                {t('leads.table.reachVia', {
                                  defaultValue: 'Reply via {{channel}}',
                                  channel: lead.channel ?? 'chat',
                                })}
                              </span>
                            )}
                            {lead.isRepeatCustomer && (
                              <Badge variant="outline" className="text-[10px] font-normal">
                                {t('leads.table.returning', { defaultValue: 'Been here before' })}
                              </Badge>
                            )}
                          </span>
                        </div>
                      </TableCell>
                      {/* Model-authored free text: rendered as text only, never as markup. */}
                      <TableCell className="text-text-secondary">
                        <span className="block max-w-[18rem] truncate" title={lead.notes ?? undefined}>
                          {lead.notes || <span className="text-text-muted">—</span>}
                        </span>
                      </TableCell>
                      {/* Days, not a timestamp: the question is "how long have they been
                          waiting", and a date makes the reader do that subtraction. */}
                      <TableCell className="whitespace-nowrap tabular-nums">
                        {days == null ? (
                          <span className="text-text-muted">—</span>
                        ) : (
                          <>
                            <span
                              className={`text-[15px] font-semibold ${
                                lead.followUp?.priority === 'now'
                                  ? 'text-destructive'
                                  : days >= OVERDUE_DAYS
                                    ? 'text-status-away'
                                    : 'text-text-primary'
                              }`}
                            >
                              {days}
                            </span>
                            <span className="block text-[11px] text-text-muted">
                              {t('leads.table.days', { defaultValue: 'days', count: days })}
                            </span>
                          </>
                        )}
                      </TableCell>
                      {hasEnrichment && (
                        <>
                          {/* The recommendation, on the row. It was the most actionable
                              thing on the page and it was hidden behind an expand. */}
                          <TableCell className="text-sm">
                            <LeadNextStep followUp={lead.followUp} />
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
                          {/* The point of the page is to get in touch, so getting in
                              touch is a control rather than a phone number the operator
                              has to select and copy. Absent for a channel-only lead,
                              where there is no address to open. */}
                          {(lead.phone || lead.email) && (
                            <a
                              href={lead.phone ? `tel:${lead.phone}` : `mailto:${lead.email}`}
                              onClick={(e) => e.stopPropagation()}
                              title={
                                lead.phone
                                  ? t('leads.actions.call', { defaultValue: 'Call {{who}}', who: lead.phone })
                                  : t('leads.actions.email', { defaultValue: 'Email {{who}}', who: lead.email })
                              }
                              className="rounded p-1 hover:bg-surface-3 hover:text-primary-400 focus-visible:text-primary-400"
                            >
                              {lead.phone ? (
                                <Phone className="h-3.5 w-3.5" />
                              ) : (
                                <Mail className="h-3.5 w-3.5" />
                              )}
                            </a>
                          )}
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
                            {/* First in the drawer: it is the one thing here that says
                                what to DO. Absent unless the tenant is entitled and the
                                facts support a suggestion — see LeadFollowUp. */}
                            <LeadFollowUp followUp={lead.followUp} />
                            {/* Moved off the row: service, address, preferred time and
                                price were blank on most leads and pushed the columns an
                                operator acts on off the right-hand edge. Here they have
                                room, and an empty one reads as "not given" rather than
                                as a column of dashes. */}
                            {hasEnrichment && (
                              <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-2 lg:grid-cols-4">
                                {[
                                  {
                                    k: 'service',
                                    label: t('leads.table.service', { defaultValue: 'Requested service' }),
                                    value: lead.serviceRequested,
                                    extra: lead.servicePrice != null ? priceLabel(lead) : null,
                                  },
                                  {
                                    k: 'address',
                                    label: t('leads.table.address', { defaultValue: 'Address' }),
                                    value: lead.address,
                                    icon: MapPin,
                                  },
                                  {
                                    k: 'preferredAt',
                                    label: t('leads.table.preferredAt', { defaultValue: 'Preferred time' }),
                                    value: lead.preferredAt
                                      ? new Date(lead.preferredAt).toLocaleString()
                                      : null,
                                  },
                                  {
                                    k: 'firstSeen',
                                    label: t('leads.detail.firstSeen', { defaultValue: 'First seen' }),
                                    value: new Date(lead.createdAt).toLocaleDateString(),
                                  },
                                ].map((f) => (
                                  <div key={f.k} className="min-w-0">
                                    <dt className="text-[11px] font-semibold uppercase tracking-wide text-text-muted">
                                      {f.label}
                                    </dt>
                                    <dd className="mt-0.5 flex items-center gap-1.5 text-text-primary">
                                      {f.icon && f.value && (
                                        <f.icon className="h-3.5 w-3.5 shrink-0 text-text-muted" />
                                      )}
                                      <span className="truncate" title={f.value ?? undefined}>
                                        {f.value || (
                                          <span className="text-text-muted">
                                            {t('leads.detail.notGiven', { defaultValue: 'Not given' })}
                                          </span>
                                        )}
                                      </span>
                                      {f.extra && (
                                        <span className="shrink-0 text-text-secondary">· {f.extra}</span>
                                      )}
                                    </dd>
                                  </div>
                                ))}
                              </dl>
                            )}
                            {/* Repeat detection groups a person across their lead ROWS,
                                so this is the only place the two-records-one-human case
                                is visible; `conversationCount` below counts THIS record
                                and structurally cannot see it. */}
                            {lead.isRepeatCustomer && (
                              <div className="flex items-center gap-1.5 text-text-secondary">
                                <Repeat className="h-3.5 w-3.5" />
                                <span>
                                  {t('leads.detail.returning', {
                                    defaultValue: 'Returning customer',
                                  })}
                                </span>
                                {lead.personFirstSeenAt && (
                                  <span className="text-text-muted">
                                    {t('leads.detail.returningSince', {
                                      defaultValue: '· first seen {{date}}',
                                      date: new Date(lead.personFirstSeenAt).toLocaleDateString(),
                                    })}
                                  </span>
                                )}
                              </div>
                            )}
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
