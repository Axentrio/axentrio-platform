/**
 * Bookings Page
 * Pro+ feature. When the tenant has `bookings` entitlement, renders a
 * placeholder until the real module lands in M5. Otherwise renders the
 * locked-preview hero.
 */

import { useTranslation } from 'react-i18next';
import { useHasFeature } from '../queries/useEntitlementsQueries';
import { LockedPreview } from '../components/billing/LockedPreview';

export default function Bookings() {
  const { t } = useTranslation();
  const hasBookings = useHasFeature('bookings');

  if (!hasBookings) {
    return (
      <LockedPreview
        feature="bookings"
        requiredTier="pro"
        title={t('bookings.locked.title')}
        oneLiner={t('bookings.locked.oneLiner')}
        bullets={[
          t('bookings.locked.bullets.1'),
          t('bookings.locked.bullets.2'),
          t('bookings.locked.bullets.3'),
        ]}
      />
    );
  }

  return (
    <div className="p-6 max-w-3xl mx-auto">
      <div className="rounded-xl border border-edge bg-surface-1 p-8 text-center">
        <h1 className="text-2xl font-semibold text-text-primary mb-2">
          {t('bookings.placeholder.title')}
        </h1>
        <p className="text-sm text-text-secondary">
          {t('bookings.placeholder.subtitle')}
        </p>
      </div>
    </div>
  );
}
