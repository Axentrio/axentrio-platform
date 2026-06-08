/**
 * PlanBadge
 * Compact pill that labels a plan tier (Essential / Pro / Enterprise) or a
 * "Coming soon" marker. Per Deviation 13: sentence-case (not all-caps) and
 * fully localized via i18n.
 */

import * as React from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';

export type PlanBadgeTier = 'essential' | 'pro' | 'enterprise' | 'comingSoon';
export type PlanBadgeSize = 'sm' | 'md';

export interface PlanBadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  tier: PlanBadgeTier;
  size?: PlanBadgeSize;
}

const TIER_CLASSES: Record<PlanBadgeTier, string> = {
  // Neutral surface — Essential is the lowest paid tier, kept understated.
  essential: 'bg-surface-3 text-text-secondary border border-edge',
  // Primary brand color — Pro is the main marketed tier.
  pro: 'bg-primary text-primary-foreground border border-transparent',
  // Violet/purple — distinguishes the sales-led Enterprise tier.
  enterprise: 'bg-violet-600 text-white border border-transparent',
  // Soft neutral, italicised inside the label is unnecessary; muted tone is enough.
  comingSoon: 'bg-surface-2 text-text-secondary border border-edge',
};

const SIZE_CLASSES: Record<PlanBadgeSize, string> = {
  sm: 'text-[11px] leading-none px-2 py-0.5',
  md: 'text-xs leading-none px-2.5 py-1',
};

export function PlanBadge({ tier, size = 'sm', className, ...rest }: PlanBadgeProps) {
  const { t } = useTranslation();
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full font-medium tracking-normal',
        TIER_CLASSES[tier],
        SIZE_CLASSES[size],
        className,
      )}
      {...rest}
    >
      {t(`badges.${tier}`)}
    </span>
  );
}

