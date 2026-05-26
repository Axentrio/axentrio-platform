/**
 * In-drawer locked state shown to tenants without the
 * `platformAssistant` entitlement (Essential / free).
 *
 * Compact variant of the full-page LockedPreview — fits inside the
 * drawer surface (~400px wide), keeps the CTA prominent, notes that
 * existing chat history is restored on re-upgrade (round 5 #7).
 */
import { Lock, Sparkles } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { UpgradeCTA } from '@components/billing/UpgradeCTA';

export function CopilotLockedPreview() {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-5 p-6 h-full overflow-y-auto">
      <div className="flex items-start gap-3">
        <div className="rounded-lg bg-primary-100 p-2 text-primary-700">
          <Lock className="h-5 w-5" />
        </div>
        <div className="flex-1">
          <h2 className="text-lg font-semibold text-text-primary">
            {t('copilot.locked.title')}
          </h2>
          <p className="mt-1 text-sm text-text-secondary">
            {t('copilot.locked.oneLiner')}
          </p>
        </div>
      </div>

      <ul className="flex flex-col gap-3 text-sm text-text-secondary">
        {(t('copilot.locked.bullets', { returnObjects: true }) as string[]).map((b) => (
          <li key={b} className="flex items-start gap-2">
            <Sparkles className="mt-0.5 h-4 w-4 flex-shrink-0 text-primary-600" />
            <span>{b}</span>
          </li>
        ))}
      </ul>

      <div className="rounded-lg border border-edge bg-surface-1 p-3 text-xs text-text-tertiary">
        {t('copilot.locked.historyNote')}
      </div>

      <UpgradeCTA tier="pro" className="w-full" />
    </div>
  );
}

export default CopilotLockedPreview;
