/**
 * LockedPreview
 * Preview-page hero rendered at a module route when the calling tenant lacks
 * the entitlement (or when the feature is "coming soon" at every tier).
 *
 * Layout per Deviation 11 / plan PR13(b):
 *   [Lock icon] {title}                  [PlanBadge requiredTier]
 *   {oneLiner}
 *   [screenshot or placeholder]
 *   • bullet 1
 *   • bullet 2
 *   • bullet 3
 *   ┌── Tier strip ─────────────────────┐
 *   │ Your plan: {currentTier displayName} │
 *   │ Required: {requiredTier displayName} │
 *   │ Trial: 14 days (if Pro)              │
 *   │ After trial: €99.99/mo (if Pro)      │
 *   │ Cancel anytime before billing        │
 *   └──────────────────────────────────────┘
 *   [Primary CTA: <UpgradeCTA> or <NotifyMeButton> if comingSoon]
 *   [Secondary: "Compare plans" → /settings/billing]
 *
 * For `comingSoon`: drop the tier strip, swap CTA to <NotifyMeButton>, and
 * the badge renders the "Coming soon" label.
 */

import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Lock } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { PlanBadge } from './PlanBadge';
import { UpgradeCTA } from './UpgradeCTA';
import { NotifyMeButton } from './NotifyMeButton';
import { useEntitlements } from '../../queries/useEntitlementsQueries';
import type {
  PlanFeatures,
  InternalPlanId,
  PlanDefinition,
} from '../../queries/useEntitlementsQueries';

export type RequiredTier = Extract<InternalPlanId, 'essential' | 'pro' | 'enterprise'>;

export interface LockedPreviewProps {
  feature: keyof PlanFeatures | string;
  /**
   * Tier to advertise on the upsell. When omitted, derived from the live
   * plan catalog (cheapest plan whose `features[feature]` is on). Prefer
   * omitting it — a hard-coded tier silently advertises the wrong plan if
   * the feature ever moves tiers in the catalog (ADR-0013 Principle 4).
   */
  requiredTier?: RequiredTier;
  title: string;
  oneLiner: string;
  bullets: string[];
  screenshotSrc?: string;
  comingSoon?: boolean;
}

function findPlan(
  plans: PlanDefinition[] | undefined,
  id: InternalPlanId,
): PlanDefinition | undefined {
  return plans?.find((p) => p.id === id);
}

/** Cheapest (lowest-rank) plan that includes the feature, per the live catalog. */
function cheapestPlanWithFeature(
  plans: PlanDefinition[] | undefined,
  feature: string,
): PlanDefinition | undefined {
  return plans
    ?.filter((p) => p.id !== 'free' && (p.features as unknown as Record<string, boolean>)[feature])
    .sort((a, b) => a.rank - b.rank)[0];
}

export function LockedPreview({
  feature,
  requiredTier,
  title,
  oneLiner,
  bullets,
  screenshotSrc,
  comingSoon = false,
}: LockedPreviewProps) {
  const { t } = useTranslation();
  const { data } = useEntitlements();
  const currentTierId = data?.current.planId;
  const currentPlan = findPlan(data?.plans, currentTierId ?? 'essential');
  const requiredPlan = requiredTier
    ? findPlan(data?.plans, requiredTier)
    : cheapestPlanWithFeature(data?.plans, String(feature));
  const requiredTierId = (requiredPlan?.id ?? requiredTier ?? 'pro') as RequiredTier;

  return (
    <div className="p-6 max-w-3xl mx-auto">
      <Card className="p-8 space-y-6">
        {/* Header: lock icon + title + badge */}
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-10 h-10 rounded-xl bg-surface-3 flex items-center justify-center flex-shrink-0">
              <Lock className="w-5 h-5 text-text-secondary" aria-hidden="true" />
            </div>
            <h1 className="text-2xl font-semibold text-text-primary truncate">
              {title}
            </h1>
          </div>
          <PlanBadge
            tier={comingSoon ? 'comingSoon' : requiredTierId}
            size="md"
          />
        </div>

        {/* One-liner */}
        <p className="text-base text-text-secondary">{oneLiner}</p>

        {/* Screenshot or placeholder */}
        <div className="rounded-xl overflow-hidden border border-edge bg-surface-1">
          {screenshotSrc ? (
            <img
              src={screenshotSrc}
              alt=""
              className="w-full h-auto block"
              aria-hidden="true"
            />
          ) : (
            <div
              className="aspect-[16/9] w-full bg-gradient-to-br from-surface-2 to-surface-3 flex items-center justify-center"
              aria-hidden="true"
            >
              <Lock className="w-12 h-12 text-text-muted opacity-30" />
            </div>
          )}
        </div>

        {/* Bullets */}
        <ul className="space-y-2">
          {bullets.map((bullet) => (
            <li
              key={bullet}
              className="flex items-start gap-2 text-sm text-text-secondary"
            >
              <span
                className="mt-1.5 w-1.5 h-1.5 rounded-full bg-primary-500 flex-shrink-0"
                aria-hidden="true"
              />
              <span>{bullet}</span>
            </li>
          ))}
        </ul>

        {/* Tier strip — only when NOT coming soon */}
        {!comingSoon && (
          <div className="rounded-xl border border-edge bg-surface-1 p-4 space-y-1.5 text-sm">
            <div className="flex items-center justify-between">
              <span className="text-text-muted">
                {t('lockedPreview.tierStrip.yourPlan')}
              </span>
              <span className="font-medium text-text-primary">
                {currentPlan?.displayName ?? '—'}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-text-muted">
                {t('lockedPreview.tierStrip.required')}
              </span>
              <span className="font-medium text-text-primary">
                {requiredPlan?.displayName ?? requiredTierId}
              </span>
            </div>
            {requiredTierId === 'pro' && (
              <>
                <div className="flex items-center justify-between">
                  <span className="text-text-muted">
                    {t('lockedPreview.tierStrip.trial')}
                  </span>
                  <span className="font-medium text-text-primary">
                    {t('lockedPreview.tierStrip.trialValue')}
                  </span>
                </div>
                {requiredPlan?.priceEurMonthly != null && (
                  <div className="flex items-center justify-between">
                    <span className="text-text-muted">
                      {t('lockedPreview.tierStrip.afterTrial')}
                    </span>
                    <span className="font-medium text-text-primary">
                      €{requiredPlan.priceEurMonthly.toFixed(2)}/mo
                    </span>
                  </div>
                )}
                <div className="text-xs text-text-muted pt-1">
                  {t('lockedPreview.tierStrip.cancelAnytime')}
                </div>
              </>
            )}
          </div>
        )}

        {/* CTAs */}
        <div className="flex flex-wrap items-center gap-3 pt-2">
          {comingSoon ? (
            <NotifyMeButton feature={String(feature)} />
          ) : (
            <UpgradeCTA tier={requiredTierId} />
          )}
          <Button asChild variant="ghost" className={cn('text-text-secondary')}>
            <Link to="/settings/billing">{t('lockedPreview.comparePlans')}</Link>
          </Button>
        </div>
      </Card>
    </div>
  );
}

