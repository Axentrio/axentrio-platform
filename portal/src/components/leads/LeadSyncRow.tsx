/**
 * "Did this lead reach my CRM?" — shown inside an expanded lead row.
 *
 * Reads delivery history rather than a stored sync column, so it cannot go stale, and
 * fetches only when the row is opened, so tenants with no webhooks never pay for it.
 *
 * The copy separates two states an empty history could mean. "You have no endpoint set
 * up" is not a problem; "you have one and this never went" is. Collapsing them into
 * "not sent" would send operators chasing a failure that doesn't exist.
 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import { CheckCircle2, AlertTriangle, Clock, Minus } from 'lucide-react';
import { useLeadSyncStatus } from '@/queries/useLeadsQueries';

export const LeadSyncRow: React.FC<{ leadId: string }> = ({ leadId }) => {
  const { t } = useTranslation();
  const { data, isLoading } = useLeadSyncStatus(leadId);

  if (isLoading || !data) return null;

  // A tenant who never wanted CRM delivery should not see a row about it at all.
  if (!data.configured) return null;

  const failed = data.status === 'failed' || data.status === 'dropped';
  const sent = data.status === 'success';
  const Icon = sent ? CheckCircle2 : failed ? AlertTriangle : data.status === 'retrying' ? Clock : Minus;
  const tone = sent ? 'text-status-online' : failed ? 'text-destructive' : 'text-text-muted';

  const label = sent
    ? t('leads.sync.sent', {
        defaultValue: 'Sent to your CRM {{when}}',
        when: data.lastAttemptAt ? new Date(data.lastAttemptAt).toLocaleString() : '',
      })
    : failed
      ? t('leads.sync.failed', {
          defaultValue: 'Could not be sent to your CRM — last try {{when}}',
          when: data.lastAttemptAt ? new Date(data.lastAttemptAt).toLocaleString() : '',
        })
      : data.status === 'never_sent'
        ? t('leads.sync.neverSent', { defaultValue: 'Not sent to your CRM yet' })
        : t('leads.sync.retrying', { defaultValue: 'Still trying to send to your CRM' });

  return (
    <div className="flex items-start gap-1.5">
      <Icon className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${tone}`} />
      <div>
        <span className={tone}>{label}</span>
        {failed && data.attempts[0]?.error && (
          // The endpoint's own error, verbatim — it is what makes the failure fixable.
          <span className="ml-1 text-text-muted">({data.attempts[0].error})</span>
        )}
        {data.attempts[0]?.host && (
          <span className="ml-1 text-text-muted">· {data.attempts[0].host}</span>
        )}
      </div>
    </div>
  );
};
