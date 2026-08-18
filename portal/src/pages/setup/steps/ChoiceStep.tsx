/**
 * Lead capture.
 *
 * The answer is not cosmetic. Skipping switches the feature off, so the customer walks
 * into a workspace showing the things they said yes to and nothing they didn't.
 */
import { useTranslation } from 'react-i18next';
import { Loader2, UserPlus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { StepProps } from './types';

export function ChoiceStep({ step, submit }: StepProps & { step: 'leads' }) {
  const { t } = useTranslation();

  return (
    <div className="space-y-6">
      <div className="flex items-start gap-4">
        <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-surface-2">
          <UserPlus className="h-5 w-5 text-primary-400" />
        </div>
        <div className="space-y-1.5">
          <h2 className="text-xl font-semibold text-text-primary">
            {t('setup.steps.leads.title')}
          </h2>
          <p className="text-sm text-text-secondary">{t('setup.steps.leads.body')}</p>
        </div>
      </div>

      <ul className="space-y-2 rounded-xl border border-edge bg-surface-2 p-4">
        {(t('setup.steps.leads.points', { returnObjects: true }) as string[]).map((point) => (
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
          {t('setup.steps.leads.yes')}
        </Button>
        {/* Where the configuring actually happens, said before they get there. */}
        <p className="text-center text-xs text-text-muted">
          {t('setup.steps.leads.afterwards')}
        </p>
      </div>
    </div>
  );
}
