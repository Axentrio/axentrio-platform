/**
 * Success Meter Page — the user-facing surface (CONTEXT.md sidebar-label
 * carve-out), per ADR-0013 D7: one surface, two tabs — Outcomes (the
 * analytics dashboard) and AI Insights (the Gaps surface per ADR-0007).
 * The Insights tab is gated by `gapInsights`; unentitled tenants see the
 * Deviation-11 locked preview.
 */
import { useTranslation } from 'react-i18next';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import Analytics from './Analytics';
import { InsightsContent } from '@/components/insights/InsightsContent';
import { ExportMenu } from '@/components/insights/ExportMenu';
import { LockedPreview } from '@/components/billing/LockedPreview';
import { FeatureDisabledNotice } from '@/components/billing/FeatureDisabledNotice';
import { useHasFeature, useIsEntitled } from '@/queries/useEntitlementsQueries';

export default function SuccessMeter() {
  const { t } = useTranslation();
  const isEntitledInsights = useIsEntitled('gapInsights');
  const hasInsights = useHasFeature('gapInsights'); // effective (entitled ∧ tenant toggle)

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
          {/* Enterprise CSV export (P3 D7) — renders nothing for other tiers. */}
          <ExportMenu />
        </div>

        <TabsContent value="outcomes">
          <Analytics />
        </TabsContent>

        <TabsContent value="insights" className="p-6">
          {hasInsights ? (
            <InsightsContent />
          ) : isEntitledInsights ? (
            // Entitled but toggled off — opt-out notice, never an upsell.
            <FeatureDisabledNotice
              featureLabel={t('features.keys.gapInsights.label', { defaultValue: 'Success Meter' })}
            />
          ) : (
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
                  defaultValue: 'Refreshed nightly from your real conversations',
                }),
              ]}
            />
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
