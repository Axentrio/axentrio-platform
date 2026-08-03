/**
 * Steps 6–8 — social channels, bookings, leads.
 *
 * Three screens with the same shape: do you want this capability, yes or not now.
 *
 * They deliberately do NOT configure anything. The wizard is a gate — every other route
 * bounces back here until it is finished — so a "Connect WhatsApp" link would either
 * bounce the customer straight back or need a hole cut in the gate. Both are worse than
 * asking the question here and connecting afterwards, which is what the product's own
 * setup prompts already guide people through.
 *
 * The answer is not cosmetic. "Not now" switches the feature off, so the customer walks
 * into a workspace showing the things they said yes to and nothing they didn't.
 */
import { useTranslation } from 'react-i18next';
import { CalendarCheck, Loader2, Share2, UserPlus, type LucideIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { SetupStep } from '@/queries/useOnboardingQueries';
import type { StepProps } from './types';

export const CHOICE_STEPS = ['social', 'bookings', 'leads'] as const;
export type ChoiceStepKey = (typeof CHOICE_STEPS)[number];

const ICONS: Record<ChoiceStepKey, LucideIcon> = {
  social: Share2,
  bookings: CalendarCheck,
  leads: UserPlus,
};

export function ChoiceStep({ step, submit }: StepProps & { step: SetupStep }) {
  const { t } = useTranslation();
  const key = step as ChoiceStepKey;
  const Icon = ICONS[key];

  return (
    <div className="space-y-6">
      <div className="flex items-start gap-4">
        <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-surface-2">
          <Icon className="h-5 w-5 text-primary-400" />
        </div>
        <div className="space-y-1.5">
          <h2 className="text-xl font-semibold text-text-primary">
            {t(`setup.steps.${key}.title`)}
          </h2>
          <p className="text-sm text-text-secondary">{t(`setup.steps.${key}.body`)}</p>
        </div>
      </div>

      <ul className="space-y-2 rounded-xl border border-edge bg-surface-2 p-4">
        {(t(`setup.steps.${key}.points`, { returnObjects: true }) as string[]).map((point) => (
          <li key={point} className="flex gap-2 text-sm text-text-secondary">
            <span className="text-primary-400">•</span>
            {point}
          </li>
        ))}
      </ul>

      <div className="space-y-2">
        <Button
          size="lg"
          className="w-full"
          disabled={submit.isPending}
          onClick={() => submit.mutate({ step })}
        >
          {submit.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          {t(`setup.steps.${key}.yes`)}
        </Button>
        {/* Where the configuring actually happens, said before they get there. */}
        <p className="text-center text-xs text-text-muted">
          {t(`setup.steps.${key}.afterwards`)}
        </p>
      </div>
    </div>
  );
}
