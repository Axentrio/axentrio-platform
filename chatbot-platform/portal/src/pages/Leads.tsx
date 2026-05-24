/**
 * Leads Page
 * Lead Capture surface — available to all paid tiers. The real M6 surface
 * lands later; this stub renders a placeholder for tenants with the feature
 * and a defensive LockedPreview for any tenant that lacks it (e.g. the
 * `free` cancellation sink).
 */

import { useTranslation } from 'react-i18next';
import { useHasFeature } from '../queries/useEntitlementsQueries';
import { LockedPreview } from '../components/billing/LockedPreview';

export default function Leads() {
  const { t } = useTranslation();
  const hasLeadCapture = useHasFeature('leadCapture');

  if (!hasLeadCapture) {
    return (
      <LockedPreview
        feature="leadCapture"
        requiredTier="pro"
        title={t('leads.locked.title')}
        oneLiner={t('leads.locked.oneLiner')}
        bullets={[
          t('leads.locked.bullets.1'),
          t('leads.locked.bullets.2'),
          t('leads.locked.bullets.3'),
        ]}
      />
    );
  }

  return (
    <div className="p-6 max-w-3xl mx-auto">
      <div className="rounded-xl border border-edge bg-surface-1 p-8 text-center">
        <h1 className="text-2xl font-semibold text-text-primary mb-2">
          {t('leads.placeholder.title')}
        </h1>
        <p className="text-sm text-text-secondary">
          {t('leads.placeholder.subtitle')}
        </p>
      </div>
    </div>
  );
}
