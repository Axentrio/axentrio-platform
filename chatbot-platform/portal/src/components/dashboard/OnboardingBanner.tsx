import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { CheckCircle, Circle, X } from 'lucide-react';
import { useAppAuth } from '../../auth/useAppAuth';
import { useOnboardingStatus } from '@/queries/useOnboardingQueries';

const DISMISSED_KEY = 'onboarding_banner_dismissed';

interface ChecklistItem {
  key: string;
  labelKey: string;
  link: string;
}

const CHECKLIST_ITEMS: ChecklistItem[] = [
  { key: 'aiEnabled', labelKey: 'analytics.onboardingBanner.steps.aiEnabled.label', link: '/ai?tab=settings' },
  { key: 'brandVoiceConfigured', labelKey: 'analytics.onboardingBanner.steps.brandVoiceConfigured.label', link: '/ai?tab=settings' },
  { key: 'knowledgeBaseHasDocs', labelKey: 'analytics.onboardingBanner.steps.knowledgeBaseHasDocs.label', link: '/ai?tab=knowledge' },
  { key: 'calcomConnected', labelKey: 'analytics.onboardingBanner.steps.calcomConnected.label', link: '/settings/integrations' },
  { key: 'automationsConfigured', labelKey: 'analytics.onboardingBanner.steps.automationsConfigured.label', link: '/settings/automations' },
];

export const OnboardingBanner: React.FC = () => {
  const { t } = useTranslation();
  const { user } = useAppAuth();
  const { data: status, isLoading } = useOnboardingStatus();
  const [dismissed, setDismissed] = useState(
    () => localStorage.getItem(DISMISSED_KEY) === 'true'
  );

  // Only show to admins
  if (user?.role !== 'admin' && user?.role !== 'super_admin') return null;
  if (isLoading || !status) return null;
  if (dismissed) return null;
  if (status.completedCount >= status.totalCount) return null;

  // Map completed step keys from the API response (steps is an object: { aiEnabled: true, ... })
  const steps = status.steps;
  const completedKeys = new Set(
    Object.entries(steps).filter(([, v]) => v).map(([k]) => k)
  );

  const handleDismiss = () => {
    localStorage.setItem(DISMISSED_KEY, 'true');
    setDismissed(true);
  };

  return (
    <div className="rounded-xl border border-edge bg-surface-0 p-5 space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-text-primary">
            {t('analytics.onboardingBanner.title')}
          </h3>
          <p className="text-xs text-text-muted mt-0.5">{t('analytics.onboardingBanner.subtitle')}</p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span className="text-xs font-medium text-text-secondary bg-surface-3 px-2 py-0.5 rounded-full">
            {t('analytics.onboardingBanner.progress', { completed: status.completedCount, total: status.totalCount })}
          </span>
          <button
            onClick={handleDismiss}
            className="text-text-muted hover:text-text-secondary transition-colors"
            aria-label={t('analytics.onboardingBanner.dismiss')}
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>

      <div className="space-y-2">
        {CHECKLIST_ITEMS.map((item) => {
          const complete = completedKeys.has(item.key);
          return (
            <div key={item.key} className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2.5">
                {complete ? (
                  <CheckCircle className="h-4 w-4 text-green-500 shrink-0" />
                ) : (
                  <Circle className="h-4 w-4 text-text-muted shrink-0" />
                )}
                <span
                  className={
                    complete
                      ? 'text-sm text-text-muted line-through'
                      : 'text-sm text-text-primary'
                  }
                >
                  {t(item.labelKey)}
                </span>
              </div>
              {!complete && (
                <Link
                  to={item.link}
                  className="text-xs font-medium text-primary-400 hover:text-primary-300 shrink-0"
                >
                  {t('analytics.onboardingBanner.setUp')}
                </Link>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};
