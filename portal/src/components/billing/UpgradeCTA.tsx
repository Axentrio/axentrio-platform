/**
 * UpgradeCTA
 * Primary CTA that starts the upgrade flow for the given plan.
 *
 * - Self-serve tiers (Essential, Pro): POST /billing/checkout-session and
 *   hard-redirect the browser to the returned Stripe URL.
 * - Enterprise: open a sales mailto: instead of Stripe.
 * - Free (or any non-self-serve, non-enterprise tier): renders nothing —
 *   defensive so callers can pass any tier without guarding upstream.
 */

import { useMutation } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useTranslation } from 'react-i18next';
import { api, extractApiErrorMessage } from '../../services/apiClient';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { InternalPlanId } from '../../queries/useEntitlementsQueries';

const SALES_EMAIL = 'sales@axentrio.be';

export type UpgradeCtaVariant = 'primary' | 'secondary';

export interface UpgradeCTAProps {
  tier: InternalPlanId;
  variant?: UpgradeCtaVariant;
  /** Override the post-checkout redirect. Defaults to the current page. */
  successUrl?: string;
  /** Override the cancel redirect. Defaults to the current page. */
  cancelUrl?: string;
  className?: string;
}

function defaultUrl(fallback: string) {
  if (typeof window === 'undefined') return fallback;
  return window.location.href;
}

export function UpgradeCTA({
  tier,
  variant = 'primary',
  successUrl,
  cancelUrl,
  className,
}: UpgradeCTAProps) {
  const { t } = useTranslation();

  const checkout = useMutation({
    mutationFn: (planId: InternalPlanId) =>
      api.post<{ url: string }>('/billing/checkout-session', {
        planId,
        successUrl: successUrl ?? defaultUrl('/'),
        cancelUrl: cancelUrl ?? defaultUrl('/'),
      }),
    onSuccess: (result) => {
      // Hard navigation: leaves the SPA, returns via successUrl on completion.
      window.location.assign(result.url);
    },
    onError: (err: unknown) => {
      const message = extractApiErrorMessage(err) ?? t('upgrade.error');
      toast.error(message);
    },
  });

  const buttonVariant = variant === 'primary' ? 'default' : 'secondary';

  if (tier === 'enterprise') {
    return (
      <Button asChild variant={buttonVariant} className={cn(className)}>
        <a href={`mailto:${SALES_EMAIL}`}>{t('upgrade.contactSales')}</a>
      </Button>
    );
  }

  if (tier !== 'essential' && tier !== 'pro') {
    // Free or any non-self-serve tier — render nothing.
    return null;
  }

  const label =
    tier === 'pro' ? t('upgrade.startTrial') : t('upgrade.subscribeNow');

  return (
    <Button
      type="button"
      variant={buttonVariant}
      className={cn(className)}
      disabled={checkout.isPending}
      onClick={() => checkout.mutate(tier)}
    >
      {label}
    </Button>
  );
}

