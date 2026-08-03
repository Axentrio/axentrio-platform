/**
 * Step 1 — language.
 *
 * First because everything after it is easier to read in the customer's own language,
 * so the choice is applied to the interface immediately rather than on the next reload.
 * It also persists to the user's profile: picking a language during setup should stick,
 * not have to be picked again in Settings.
 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2 } from 'lucide-react';
import i18n from '@/i18n';
import { api } from '@/services/apiClient';
import { cn } from '@/lib/utils';
import type { SetupLanguage, SetupStatus } from '@/queries/useOnboardingQueries';
import type { StepProps } from './types';

const LANGUAGES: Array<{ code: SetupLanguage; label: string }> = [
  { code: 'nl', label: 'Nederlands' },
  { code: 'fr', label: 'Français' },
  { code: 'en', label: 'English' },
];

export function LanguageStep({ status, submit }: StepProps & { status: SetupStatus }) {
  const { t } = useTranslation();
  const [pending, setPending] = React.useState<SetupLanguage | null>(null);
  const current = status.state.language;

  const choose = async (code: SetupLanguage) => {
    setPending(code);
    i18n.changeLanguage(code);
    // Best-effort: a failure to store the profile preference must not block setup —
    // the choice is already recorded on the onboarding state below.
    void api.patch('/users/profile', { locale: code }).catch(() => {});
    submit.mutate(
      { step: 'language', language: code },
      { onSettled: () => setPending(null) },
    );
  };

  return (
    <div className="space-y-6">
      <div className="space-y-1.5">
        <h2 className="text-xl font-semibold text-text-primary">{t('setup.steps.language.title')}</h2>
        <p className="text-sm text-text-secondary">{t('setup.steps.language.body')}</p>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        {LANGUAGES.map(({ code, label }) => (
          <button
            key={code}
            type="button"
            disabled={submit.isPending}
            onClick={() => choose(code)}
            className={cn(
              'flex items-center justify-center gap-2 rounded-xl border px-4 py-5 text-base font-medium transition-colors',
              current === code
                ? 'border-primary-500 bg-primary-500/10 text-text-primary'
                : 'border-edge bg-surface-2 text-text-primary hover:border-primary-500/50',
            )}
          >
            {pending === code && <Loader2 className="h-4 w-4 animate-spin" />}
            {label}
          </button>
        ))}
      </div>
    </div>
  );
}
