/**
 * OnboardingChecklist
 * Shown at the top of the AI & Content "AI Bot" tab until the tenant has done
 * its first-day steps. Hides itself entirely once they're all complete so the
 * page stops nagging returning users.
 *
 * Completion is sourced from the canonical onboarding-status API (the same data
 * the dashboard OnboardingBanner uses) so the two surfaces can't diverge — this
 * is a focused subset of those steps (enable → knowledge → first answer).
 */

import React from 'react';
import { useTranslation } from 'react-i18next';
import { Check, Circle, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';

export interface OnboardingChecklistProps {
  aiEnabled: boolean;
  hasIndexedDocs: boolean;
  hadFirstConversation: boolean;
  onGoToKnowledge: () => void;
  onTryBot: () => void;
  onConfigureBot?: () => void;
}

interface Step {
  key: string;
  label: string;
  description: string;
  done: boolean;
  actionLabel: string;
  onAction?: () => void;
}

export const OnboardingChecklist: React.FC<OnboardingChecklistProps> = ({
  aiEnabled,
  hasIndexedDocs,
  hadFirstConversation,
  onGoToKnowledge,
  onTryBot,
  onConfigureBot,
}) => {
  const { t } = useTranslation();
  const steps: Step[] = [
    {
      key: 'bot',
      label: t('ai.onboarding.steps.enableBot.title'),
      description: t('ai.onboarding.steps.enableBot.description'),
      done: aiEnabled,
      actionLabel: t('ai.onboarding.steps.enableBot.action'),
      onAction: onConfigureBot,
    },
    {
      key: 'knowledge',
      label: t('ai.onboarding.steps.addKnowledge.title'),
      description: t('ai.onboarding.steps.addKnowledge.description'),
      done: hasIndexedDocs,
      actionLabel: t('ai.onboarding.steps.addKnowledge.action'),
      onAction: onGoToKnowledge,
    },
    {
      key: 'firstConversation',
      label: t('ai.onboarding.steps.firstConversation.title'),
      description: t('ai.onboarding.steps.firstConversation.description'),
      done: hadFirstConversation,
      actionLabel: t('ai.onboarding.steps.firstConversation.action'),
      onAction: onTryBot,
    },
  ];

  if (steps.every((s) => s.done)) {
    return null;
  }

  return (
    <div className="mb-6 rounded-2xl border border-edge bg-surface-1/60 p-5">
      <div className="mb-3">
        <h2 className="text-sm font-semibold text-text-primary">{t('ai.onboarding.title')}</h2>
        <p className="text-xs text-text-muted">
          {t('ai.onboarding.subtitle')}
        </p>
      </div>
      <ul className="space-y-2">
        {steps.map((step) => (
          <li
            key={step.key}
            className="flex items-center justify-between gap-3 rounded-lg bg-surface-2/40 px-3 py-2"
          >
            <div className="flex min-w-0 items-center gap-3">
              {step.done ? (
                <Check className="h-4 w-4 shrink-0 text-emerald-400" aria-label={t('ai.onboarding.stepDone')} />
              ) : (
                <Circle className="h-4 w-4 shrink-0 text-text-muted" aria-label={t('ai.onboarding.stepNotDone')} />
              )}
              <div className="min-w-0">
                <p
                  className={`truncate text-sm ${
                    step.done ? 'text-text-muted line-through' : 'text-text-primary'
                  }`}
                >
                  {step.label}
                </p>
                <p className="truncate text-xs text-text-muted">{step.description}</p>
              </div>
            </div>
            {!step.done && step.onAction && (
              <Button
                size="sm"
                variant="ghost"
                onClick={step.onAction}
                className="shrink-0 gap-1"
              >
                {step.actionLabel}
                <ChevronRight className="h-3.5 w-3.5" />
              </Button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
};

