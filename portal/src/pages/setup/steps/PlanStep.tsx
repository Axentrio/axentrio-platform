/**
 * Plan — before bookings, because appointments need Pro.
 *
 * Essential is the chatbot-only path. Pro (14-day trial) is the path that can take
 * a Booking. Free is not offered: it is the cancellation sink and cannot run an Agent.
 *
 * The step is recorded as answered at the moment of choice, INCLUDING before a redirect
 * to Stripe, so abandoning checkout cannot trap them on an unanswered required step.
 *
 * Prices and copy come from the same translation keys as Settings → Billing.
 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import { Check, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import {
  useBillingState,
  useStartCheckout,
  type CheckoutablePlan,
} from '@/queries/useBillingQueries';
import type { StepProps } from './types';

/** Mirrors SELF_SERVE_PLANS in Settings → Billing, in upgrade-rank order. */
const PLANS: CheckoutablePlan[] = ['essential', 'pro', 'enterprise'];

/** Pro is recommended; it is the one called out. Choosing it starts Checkout (14-day trial). */
const RECOMMENDED: CheckoutablePlan = 'pro';

/**
 * The bullet keys each plan actually has under settings.billing.plans.*.features.
 * Naming one that does not exist would render a blank bullet, so the list is the real
 * key set rather than a hopeful superset.
 */
const FEATURE_KEYS: Record<CheckoutablePlan, string[]> = {
  essential: ['agents', 'sessions', 'llmCalls', 'channels', 'insights'],
  pro: ['agents', 'sessions', 'llmCalls', 'channels', 'branding'],
  enterprise: ['unlimited', 'integrations', 'sla'],
};

export function PlanStep({ submit }: StepProps) {
  const { t } = useTranslation();
  const { data: billing, isLoading: billingLoading } = useBillingState();
  const checkout = useStartCheckout();
  const [selected, setSelected] = React.useState<CheckoutablePlan | null>(null);
  const alreadyCovered =
    billing?.status === 'trialing' ||
    billing?.status === 'active' ||
    billing?.status === 'past_due';

  const buy = (planId: CheckoutablePlan) => {
    setSelected(planId);
    // Record the answer first: the redirect below leaves the app, and coming back to
    // an unanswered final step would trap the customer in setup.
    submit.mutate(
      { step: 'plan' },
      {
        onSuccess: () =>
          checkout.mutate({
            planId,
            successUrl: `${window.location.origin}/settings/billing?checkout=success`,
            cancelUrl: `${window.location.origin}/settings/billing?checkout=cancelled`,
          }),
      },
    );
  };

  const busy = billingLoading || submit.isPending || checkout.isPending;

  if (alreadyCovered) {
    const onTrial = billing?.status === 'trialing';
    return (
      <div className="space-y-6">
        <div className="space-y-1.5">
          <h2 className="text-xl font-semibold text-text-primary">{t('setup.steps.plan.title')}</h2>
          <p className="text-sm text-text-secondary">
            {onTrial
              ? 'You’re on a 14-day Pro trial. Bookings and the assistant are on. Add a card later in Billing.'
              : 'Your current plan is already active. You can change it later in Billing.'}
          </p>
        </div>
        <div className="flex justify-end">
          <Button
            size="lg"
            disabled={submit.isPending}
            onClick={() => submit.mutate({ step: 'plan' })}
          >
            {submit.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {t('setup.continue')}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="space-y-1.5">
        <h2 className="text-xl font-semibold text-text-primary">{t('setup.steps.plan.title')}</h2>
        <p className="text-sm text-text-secondary">{t('setup.steps.plan.body')}</p>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        {PLANS.map((planId) => (
          <div
            key={planId}
            className={cn(
              'relative flex flex-col gap-3 rounded-xl border bg-surface-2 p-4',
              planId === RECOMMENDED ? 'border-primary-500' : 'border-edge',
            )}
          >
            {planId === RECOMMENDED && (
              <span className="absolute -top-2.5 left-4 rounded-full bg-primary-500 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-white">
                {t('setup.steps.plan.recommended')}
              </span>
            )}
            <div>
              <p className="font-semibold text-text-primary">
                {t(`settings.billing.plans.${planId}.name`)}
              </p>
              <p className="text-lg font-semibold text-text-primary">
                {t(`settings.billing.plans.${planId}.price`)}
              </p>
              <p className="text-xs text-text-muted">
                {t(`settings.billing.plans.${planId}.priceNote`)}
              </p>
            </div>
            <ul className="flex-1 space-y-1.5">
              {FEATURE_KEYS[planId].map((key) => (
                <li key={key} className="flex gap-1.5 text-xs text-text-secondary">
                  <Check className="mt-0.5 h-3 w-3 shrink-0 text-primary-400" />
                  {t(`settings.billing.plans.${planId}.features.${key}`, { defaultValue: '' })}
                </li>
              ))}
            </ul>
            {planId === RECOMMENDED && (
              <p className="text-xs font-medium text-primary-400">
                {t('setup.steps.plan.trialLength')}
              </p>
            )}
            <Button
              variant={planId === RECOMMENDED ? 'default' : 'outline'}
              disabled={busy}
              onClick={() => buy(planId)}
            >
              {busy && selected === planId && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {t('setup.steps.plan.choose')}
            </Button>
          </div>
        ))}
      </div>

    </div>
  );
}
