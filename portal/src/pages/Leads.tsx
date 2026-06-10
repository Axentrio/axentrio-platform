/**
 * Leads Page — M6.
 *
 * First-class lead inbox backed by `chatbot_leads`. Shows every lead
 * captured by the agent across all sessions. Non-paid tiers see the
 * LockedPreview hero (defensive — Free is the cancellation sink and
 * shouldn't see this page in normal flow).
 */

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Mail, Phone, MessageSquare, Inbox, ChevronRight } from 'lucide-react';
import { useHasFeature } from '../queries/useEntitlementsQueries';
import { useLeadsInfinite } from '../queries/useLeadsQueries';
import { LockedPreview } from '../components/billing/LockedPreview';
import { Button } from '@/components/ui/button';

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

export default function Leads() {
  const { t } = useTranslation();
  const hasLeadCapture = useHasFeature('leadCapture');
  const {
    data,
    isLoading,
    hasNextPage,
    fetchNextPage,
    isFetchingNextPage,
  } = useLeadsInfinite();
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  if (!hasLeadCapture) {
    return (
      <LockedPreview
        feature="leadCapture"
        requiredTier="pro"
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

  const allLeads = data?.pages.flatMap((p) => p.leads) ?? [];

  return (
    <div className="h-full overflow-y-auto p-6 max-w-5xl mx-auto space-y-4">
      <div>
        <h1 className="text-2xl font-semibold text-text-primary">
          {t('leads.title')}
        </h1>
        <p className="text-sm text-text-secondary mt-1">
          {t('leads.intro')}
        </p>
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
            {t('leads.empty.title')}
          </h2>
          <p className="text-sm text-text-secondary max-w-md mx-auto">
            {t('leads.empty.body')}
          </p>
        </div>
      ) : (
        <>
          <div className="rounded-xl border border-edge bg-surface-1 overflow-hidden">
            <table className="w-full">
              <thead className="bg-surface-2">
                <tr className="text-xs uppercase tracking-wide text-text-muted">
                  <th className="text-left px-4 py-2.5 font-medium">{t('leads.table.name')}</th>
                  <th className="text-left px-4 py-2.5 font-medium">{t('leads.table.contact')}</th>
                  <th className="text-left px-4 py-2.5 font-medium">{t('leads.table.source')}</th>
                  <th className="text-left px-4 py-2.5 font-medium">{t('leads.table.capturedAt')}</th>
                  <th className="w-8" aria-label="Expand"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-edge">
                {allLeads.map((lead) => {
                  const isOpen = expanded[lead.id];
                  return (
                    <>
                      <tr
                        key={lead.id}
                        className="hover:bg-surface-2/50 cursor-pointer"
                        onClick={() => setExpanded((s) => ({ ...s, [lead.id]: !s[lead.id] }))}
                      >
                        <td className="px-4 py-3 text-sm text-text-primary font-medium">
                          <span className="flex items-center gap-2">
                            {lead.name || <span className="text-text-muted italic">{t('leads.table.noName', { defaultValue: 'No name' })}</span>}
                            {lead.channel && lead.channel !== 'widget' && (
                              <span className="inline-flex items-center rounded bg-surface-3 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-text-muted">
                                {lead.channel}
                              </span>
                            )}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-sm text-text-secondary">
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
                              {t('leads.table.reachVia', { defaultValue: 'Reply via {{channel}}', channel: lead.channel ?? 'chat' })}
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-3 text-sm text-text-secondary">
                          <span className="inline-flex items-center rounded-full bg-surface-3 px-2 py-0.5 text-xs font-medium">
                            {lead.source}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-sm text-text-secondary">
                          <span title={new Date(lead.createdAt).toLocaleString()}>
                            {formatRelative(lead.createdAt)}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-text-muted">
                          <ChevronRight
                            className={`h-4 w-4 transition-transform ${isOpen ? 'rotate-90' : ''}`}
                          />
                        </td>
                      </tr>
                      {isOpen && (
                        <tr key={`${lead.id}-detail`} className="bg-surface-2/30">
                          <td colSpan={5} className="px-4 py-3 text-xs text-text-muted">
                            <div className="space-y-1">
                              {lead.sessionId && (
                                <div className="flex items-center gap-1.5">
                                  <MessageSquare className="h-3.5 w-3.5" />
                                  <span>{t('leads.detail.fromSession')}</span>
                                  <code className="font-mono">{lead.sessionId.slice(0, 8)}…</code>
                                </div>
                              )}
                              {lead.notes && (
                                <div>
                                  <span className="font-medium">{t('leads.detail.notes')}:</span>{' '}
                                  {lead.notes}
                                </div>
                              )}
                              <div>
                                <span className="font-medium">{t('leads.detail.createdAt')}:</span>{' '}
                                {new Date(lead.createdAt).toLocaleString()}
                              </div>
                            </div>
                          </td>
                        </tr>
                      )}
                    </>
                  );
                })}
              </tbody>
            </table>
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
    </div>
  );
}
