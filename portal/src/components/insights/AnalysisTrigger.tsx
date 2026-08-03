/**
 * "Analyse now" — the manual trigger for tiers whose analysis is on demand.
 *
 * Essential and Pro do not analyse on a schedule; they analyse when the operator asks,
 * behind a minimum-conversations bar and a cooldown (api/src/insights/analysis-policy.ts).
 * Enterprise analyses continuously and therefore has no button at all — for them this
 * renders a one-line statement of that fact rather than a control that would duplicate
 * work already underway.
 *
 * WHY THE REASON IS ALWAYS SHOWN. A disabled button with no explanation is the worst of
 * both worlds: the operator can see the feature exists and cannot find out what to do
 * about it. Both limits come back from the server on every check, so the copy can say
 * "12 of 15 conversations" and "you can run again in 4 hours" together, rather than
 * revealing one obstacle and then the next.
 *
 * The server re-checks eligibility on the POST. This component is a convenience, never
 * the gate — a stale view must not be able to spend a tenant's cooldown.
 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { useAnalysisStatus, useRunAnalysis, type AnalysisStatus } from '@/queries/useInsightsQueries';
import { extractApiErrorMessage } from '@/services/apiClient';

/** Whole hours until `iso`, floored at 1 so it never reads "in 0 hours". */
function hoursUntil(iso: string | null): number | null {
  if (!iso) return null;
  const ms = new Date(iso).getTime() - Date.now();
  return ms <= 0 ? null : Math.max(1, Math.ceil(ms / 3_600_000));
}

function useReasonText(status: AnalysisStatus | undefined): string | null {
  const { t } = useTranslation();
  if (!status || status.eligible) return null;

  switch (status.reason) {
    case 'automatic':
      return t('insights.analysis.automatic', {
        defaultValue: 'Your plan analyses conversations continuously — nothing to run by hand.',
      });
    case 'not_enough_chats':
      return t('insights.analysis.notEnoughChats', {
        defaultValue:
          '{{count}} of {{min}} new conversations. Analysis needs enough of them to find a pattern rather than a coincidence.',
        count: status.newChats,
        min: status.minNewChats,
      });
    case 'cooling_down': {
      const hours = hoursUntil(status.nextAllowedAt);
      return hours
        ? t('insights.analysis.coolingDown', {
            defaultValue: 'Already analysed recently. You can run it again in {{hours}} hours.',
            hours,
          })
        : null;
    }
    default:
      return null;
  }
}

export const AnalysisTrigger: React.FC = () => {
  const { t } = useTranslation();
  const { data: status, isLoading } = useAnalysisStatus();
  const run = useRunAnalysis();
  const reason = useReasonText(status);

  // Absent, not disabled, for a tenant without insights: there is nothing here they
  // could unlock by waiting, so a greyed control would only be noise.
  if (isLoading || !status || status.policy.tier === 'none') return null;

  const onRun = async () => {
    try {
      await run.mutateAsync();
      toast.success(
        t('insights.analysis.done', { defaultValue: 'Analysis finished. Insights updated.' }),
      );
    } catch (err) {
      toast.error(
        extractApiErrorMessage(err) ??
          t('insights.analysis.failed', { defaultValue: 'Analysis could not be completed' }),
      );
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      {!status.policy.automatic && (
        <Button size="sm" variant="outline" onClick={onRun} disabled={!status.eligible || run.isPending}>
          {run.isPending ? (
            <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
          ) : (
            <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
          )}
          {run.isPending
            ? t('insights.analysis.running', { defaultValue: 'Analysing…' })
            : t('insights.analysis.run', { defaultValue: 'Analyse now' })}
        </Button>
      )}
      {reason && <p className="text-xs text-text-muted">{reason}</p>}
    </div>
  );
};

export default AnalysisTrigger;
