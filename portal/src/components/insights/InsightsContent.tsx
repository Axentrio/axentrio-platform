/**
 * InsightsContent — the Gaps surface (ADR-0007): Open/Wins tabs, severity,
 * evidence drill-down (Pro+ via `gapEvidence`, locked affordance otherwise),
 * freshness + completeness banners (ADR-0006), and the two tenant lifecycle
 * actions ("I fixed this" → resolved_manual, "Not relevant" → archived).
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Lightbulb, Lock, ChevronDown, ChevronUp, CheckCircle2, Archive, Clock, AlertTriangle,
  FlaskConical, X, TrendingUp, MessageCircleHeart,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  useInsights,
  useGapEvidence,
  useResolveGap,
  useArchiveGap,
  useExperiments,
  useDismissExperiment,
  GapRow,
  ExperimentDto,
} from '../../queries/useInsightsQueries';
import { useHasFeature } from '../../queries/useEntitlementsQueries';
import { timeAgo } from '@/utils/timeAgo';

const SEVERITY_DOT: Record<string, string> = {
  red: 'bg-red-400',
  orange: 'bg-amber-400',
  green: 'bg-emerald-400',
};

function GapCard({ gap, evidenceEnabled }: { gap: GapRow; evidenceEnabled: boolean }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const { data: evidenceRes, isLoading: loadingEvidence } = useGapEvidence(
    gap.id,
    expanded && evidenceEnabled,
  );
  const resolveGap = useResolveGap(t('insights.actions.resolvedToast', { defaultValue: 'Marked as fixed' }));
  const archiveGap = useArchiveGap(t('insights.actions.archivedToast', { defaultValue: 'Archived' }));

  const actionable = gap.status === 'open' || gap.status === 'dormant';

  return (
    <Card variant="glass">
      <CardContent className="p-4 space-y-3">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2 min-w-0">
            <span className={cn('h-2.5 w-2.5 rounded-full shrink-0', SEVERITY_DOT[gap.severity])} />
            <p className="text-sm font-medium text-text-primary truncate capitalize">{gap.topic}</p>
            {gap.status === 'dormant' && (
              <Badge variant="outline" className="text-xs text-zinc-400">
                {t('insights.status.dormant', { defaultValue: 'Dormant' })}
              </Badge>
            )}
            {(gap.status === 'resolved_data' || gap.status === 'resolved_manual') && (
              <Badge variant="outline" className="text-xs text-emerald-400 border-emerald-400/40">
                {gap.status === 'resolved_data'
                  ? t('insights.status.resolvedData', { defaultValue: 'Resolved — confirmed by chats' })
                  : t('insights.status.resolvedManual', { defaultValue: 'Resolved — marked fixed' })}
              </Badge>
            )}
          </div>
          {actionable && (
            <div className="flex gap-2 shrink-0">
              <Button
                size="sm"
                variant="outline"
                disabled={resolveGap.isPending}
                onClick={() => resolveGap.mutate(gap.id)}
              >
                <CheckCircle2 className="h-3.5 w-3.5 mr-1" />
                {t('insights.actions.resolve', { defaultValue: 'I fixed this' })}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={archiveGap.isPending}
                onClick={() => archiveGap.mutate(gap.id)}
                title={t('insights.actions.archiveHint', { defaultValue: 'Not relevant to my business' })}
              >
                <Archive className="h-3.5 w-3.5" />
              </Button>
            </div>
          )}
        </div>

        <p className="text-xs text-zinc-400">
          {t('insights.card.stats', {
            defaultValue: '{{visitors}} customers asked without getting an answer ({{count}} conversations) · last {{ago}}',
            visitors: gap.distinctVisitors,
            count: gap.occurrences,
            ago: timeAgo(gap.lastSeenAt),
          })}
        </p>

        {gap.recommendation && (
          <p className="text-sm text-zinc-300 bg-white/5 rounded-lg px-3 py-2">
            <Lightbulb className="inline h-3.5 w-3.5 mr-1.5 text-amber-300" />
            {gap.recommendation}
          </p>
        )}

        {/* Evidence drill-down — Pro+; locked affordance sells the upgrade (Deviation 11/14). */}
        {evidenceEnabled ? (
          <button
            className="flex items-center gap-1 text-xs text-primary-400 hover:text-primary-300"
            onClick={() => setExpanded((v) => !v)}
          >
            {expanded ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
            {t('insights.evidence.toggle', { defaultValue: 'View the conversations' })}
          </button>
        ) : (
          <p className="flex items-center gap-1.5 text-xs text-zinc-500">
            <Lock className="h-3 w-3" />
            {t('insights.evidence.locked', {
              defaultValue: 'Upgrade to see the conversations behind this finding',
            })}
          </p>
        )}

        {expanded && evidenceEnabled && (
          <div className="space-y-3 border-t border-white/10 pt-3">
            {loadingEvidence ? (
              <Skeleton className="h-16 w-full rounded-lg" />
            ) : (
              (evidenceRes?.evidence ?? []).map((e) => (
                <div key={e.sessionId} className="text-xs space-y-1.5">
                  <p className="text-zinc-500">
                    {new Date(e.sessionStartedAt).toLocaleString()}
                    {e.reasoning && <span className="ml-2 text-zinc-400 italic">{e.reasoning}</span>}
                  </p>
                  {e.messages.map((m) => (
                    <p key={m.id} className="text-zinc-300">
                      <span className={cn('font-medium mr-1.5', m.sender === 'user' ? 'text-sky-400' : 'text-zinc-500')}>
                        {m.sender === 'user'
                          ? t('insights.evidence.customer', { defaultValue: 'Customer' })
                          : t('insights.evidence.assistant', { defaultValue: 'Assistant' })}:
                      </span>
                      {m.content}
                    </p>
                  ))}
                </div>
              ))
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

const EXPERIMENT_DOT: Record<string, string> = {
  red: 'bg-red-400',
  orange: 'bg-amber-400',
  green: 'bg-emerald-400',
};

/** A correlation or sentiment experiment — an OBSERVATION, not resolvable (ADR-0001). */
function ExperimentCard({ exp }: { exp: ExperimentDto }) {
  const { t } = useTranslation();
  const dismiss = useDismissExperiment(t('insights.experiments.dismissedToast', { defaultValue: 'Dismissed' }));
  const Icon = exp.kind === 'correlation' ? TrendingUp : MessageCircleHeart;
  return (
    <Card variant="glass">
      <CardContent className="p-4 space-y-2">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2 min-w-0">
            <span className={cn('h-2.5 w-2.5 rounded-full shrink-0', EXPERIMENT_DOT[exp.severity])} />
            <Icon className="h-4 w-4 text-zinc-400 shrink-0" />
            <p className="text-sm font-medium text-text-primary">{exp.title}</p>
          </div>
          <Button
            size="sm"
            variant="ghost"
            disabled={dismiss.isPending}
            onClick={() => dismiss.mutate(exp.id)}
            title={t('insights.experiments.dismiss', { defaultValue: 'Dismiss' })}
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>
        {exp.detail && <p className="text-sm text-zinc-300">{exp.detail}</p>}
      </CardContent>
    </Card>
  );
}

/** Enterprise-only (aiBusinessInsights). Correlation + sentiment experiments. */
function ExperimentsSection() {
  const { t } = useTranslation();
  const enabled = useHasFeature('aiBusinessInsights');
  const { data, isLoading } = useExperiments(enabled);
  if (!enabled) return null;

  const experiments = data?.experiments ?? [];
  return (
    <div className="space-y-3 pt-2">
      <div className="flex items-center gap-2">
        <FlaskConical className="h-4 w-4 text-primary-400" />
        <h3 className="text-sm font-semibold text-text-primary">
          {t('insights.experiments.title', { defaultValue: 'Experiments' })}
        </h3>
      </div>
      {isLoading ? (
        <Skeleton className="h-20 w-full rounded-xl" />
      ) : experiments.length === 0 ? (
        <p className="text-xs text-zinc-500">
          {t('insights.experiments.empty', {
            defaultValue: 'Patterns we spot in your conversations — correlations and sentiment themes — appear here as they emerge.',
          })}
        </p>
      ) : (
        experiments.map((e) => <ExperimentCard key={e.id} exp={e} />)
      )}
    </div>
  );
}

export function InsightsContent() {
  const { t } = useTranslation();
  const { data, isLoading } = useInsights();
  const evidenceEnabled = useHasFeature('gapEvidence') && (data?.meta.evidenceEnabled ?? false);

  if (isLoading) {
    return (
      <div className="space-y-3">
        {[...Array(3)].map((_, i) => <Skeleton key={i} className="h-24 w-full rounded-xl" />)}
      </div>
    );
  }

  const gaps = data?.gaps ?? [];
  const meta = data?.meta;
  const open = gaps.filter((g) => g.status === 'open' || g.status === 'dormant');
  const wins = gaps.filter((g) => g.status === 'resolved_data' || g.status === 'resolved_manual');

  return (
    <div className="space-y-4">
      {/* Freshness + completeness banners (ADR-0006/0007) */}
      <div className="flex flex-wrap items-center gap-3 text-xs text-zinc-400">
        <span className="flex items-center gap-1.5">
          <Clock className="h-3.5 w-3.5" />
          {meta?.lastRefreshedAt
            ? t('insights.meta.refreshed', {
                defaultValue: 'Last analysed {{ago}}',
                ago: timeAgo(meta.lastRefreshedAt),
              })
            : t('insights.meta.pending', {
                defaultValue: 'First analysis runs tonight — insights appear after your chats are reviewed',
              })}
        </span>
        {meta?.completeness != null && meta.completeness < 0.9 && (
          <span className="flex items-center gap-1.5 text-amber-400">
            <AlertTriangle className="h-3.5 w-3.5" />
            {t('insights.meta.incomplete', {
              defaultValue: 'Insights incomplete — still analysing recent chats',
            })}
          </span>
        )}
      </div>

      <Tabs defaultValue="open">
        <TabsList>
          <TabsTrigger value="open">
            {t('insights.tabs.open', { defaultValue: 'Open' })} {open.length > 0 && `(${open.length})`}
          </TabsTrigger>
          <TabsTrigger value="wins">
            {t('insights.tabs.wins', { defaultValue: 'Wins' })} {wins.length > 0 && `(${wins.length})`}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="open" className="space-y-3">
          {open.length === 0 ? (
            <div className="text-center py-10 text-zinc-500">
              <CheckCircle2 className="h-8 w-8 mx-auto mb-2 opacity-50" />
              <p className="text-sm">{t('insights.empty.open.title', { defaultValue: 'No open gaps' })}</p>
              <p className="text-xs mt-1">
                {t('insights.empty.open.description', {
                  defaultValue: 'When several customers ask something your assistant can’t answer, it shows up here.',
                })}
              </p>
            </div>
          ) : (
            open.map((g) => <GapCard key={g.id} gap={g} evidenceEnabled={evidenceEnabled} />)
          )}
        </TabsContent>

        <TabsContent value="wins" className="space-y-3">
          {wins.length === 0 ? (
            <div className="text-center py-10 text-zinc-500">
              <p className="text-sm">{t('insights.empty.wins.title', { defaultValue: 'No wins yet' })}</p>
              <p className="text-xs mt-1">
                {t('insights.empty.wins.description', {
                  defaultValue: 'Resolved gaps land here — fix a gap by adding the answer to your knowledge base.',
                })}
              </p>
            </div>
          ) : (
            wins.map((g) => <GapCard key={g.id} gap={g} evidenceEnabled={evidenceEnabled} />)
          )}
        </TabsContent>
      </Tabs>

      <ExperimentsSection />
    </div>
  );
}
