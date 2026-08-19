/**
 * Success Meter Page — the user-facing surface (CONTEXT.md sidebar-label
 * carve-out), per ADR-0013 D7: one surface, two tabs — Outcomes (the
 * analytics dashboard) and AI Insights (the Gaps surface per ADR-0007).
 * The whole surface is gated by `gapInsights`; Outcomes remain a separate
 * analytics capability, but this route is hidden when Success Meter is off.
 */
import { useTranslation } from 'react-i18next';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import Analytics from './Analytics';
import { InsightsContent } from '@/components/insights/InsightsContent';
import { ExportMenu } from '@/components/insights/ExportMenu';
import { AnalysisTrigger } from '@/components/insights/AnalysisTrigger';
import { LockedPreview } from '@/components/billing/LockedPreview';
import { FeatureDisabledNotice } from '@/components/billing/FeatureDisabledNotice';
import { useHasFeature, useIsEntitled } from '@/queries/useEntitlementsQueries';

export default function SuccessMeter() {
  const { t } = useTranslation();
  const isEntitledInsights = useIsEntitled('gapInsights');
  const hasInsights = useHasFeature('gapInsights'); // effective (entitled ∧ tenant toggle)

  if (!isEntitledInsights) {
    return (
      <LockedPreview
        feature="gapInsights"
        title={t('insights.locked.title', { defaultValue: 'AI Insights' })}
        oneLiner={t('insights.locked.oneLiner', {
          defaultValue: 'See what customers ask that your assistant can’t answer yet.',
        })}
        bullets={[
          t('insights.locked.bullet1', {
            defaultValue: 'Topics customers keep asking about, ranked by how many asked',
          }),
          t('insights.locked.bullet2', {
            defaultValue: 'Fix a gap by adding the answer to your knowledge base — wins are confirmed automatically',
          }),
          t('insights.locked.bullet3', {
            defaultValue: 'Press Analyse now to update from your real conversations',
          }),
        ]}
      />
    );
  }
  if (!hasInsights) {
    return (
      <FeatureDisabledNotice
        featureLabel={t('features.keys.gapInsights.label', { defaultValue: 'Success Meter' })}
      />
    );
  }

  return (
    <div className="h-full overflow-y-auto">
      <Tabs defaultValue="outcomes" className="h-full">
        <div className="px-6 pt-4 flex items-center justify-between gap-3">
          <TabsList>
            <TabsTrigger value="outcomes">
              {t('insights.surface.outcomesTab', { defaultValue: 'Outcomes' })}
            </TabsTrigger>
            <TabsTrigger value="insights">
              {t('insights.surface.insightsTab', { defaultValue: 'AI Insights' })}
            </TabsTrigger>
          </TabsList>
          <div className="flex flex-wrap items-center gap-3">
            {/* On-demand analysis for Essential/Pro; a one-line statement for
                Enterprise, whose analysis is continuous. Renders nothing without
                insights at all. */}
            <AnalysisTrigger />
            {/* Enterprise CSV export (P3 D7) — renders nothing for other tiers. */}
            <ExportMenu />
          </div>
        </div>

        <TabsContent value="outcomes">
          <Analytics />
        </TabsContent>

        <TabsContent value="insights" className="p-6">
          <InsightsContent />
        </TabsContent>
      </Tabs>
    </div>
  );
}
