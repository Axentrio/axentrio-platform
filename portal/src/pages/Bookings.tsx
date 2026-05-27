/**
 * Bookings Page
 * Pro+ feature. Pro tenants land here to configure or check their Cal.com
 * connection. Non-Pro tenants see the locked-preview hero.
 *
 * Cal.com itself is the source of truth for the booking calendar and the
 * appointment list; this page just surfaces connection status and deep-links
 * into the actual config under Settings → Integrations.
 */

import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Calendar, CheckCircle, ExternalLink } from 'lucide-react';
import { useHasFeature } from '../queries/useEntitlementsQueries';
import { useIntegrations } from '../queries/useIntegrationQueries';
import { LockedPreview } from '../components/billing/LockedPreview';

export default function Bookings() {
  const { t } = useTranslation();
  const hasBookings = useHasFeature('bookings');
  const { data: integrations } = useIntegrations();

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

  const calcomConnected = Boolean(
    integrations?.calcom?.hasApiKey && integrations?.calcom?.eventTypeId,
  );

  return (
    <div className="p-6 max-w-3xl mx-auto space-y-4">
      <div>
        <h1 className="text-2xl font-semibold text-text-primary">
          {t('bookings.title')}
        </h1>
        <p className="text-sm text-text-secondary mt-1">{t('bookings.intro')}</p>
      </div>

      <div className="rounded-xl border border-edge bg-surface-1 p-6">
        <div className="flex items-start gap-4">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary-600/10">
            <Calendar className="h-5 w-5 text-primary-400" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <h2 className="text-base font-semibold text-text-primary">
                {t('bookings.calcom.title')}
              </h2>
              {calcomConnected && (
                <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-500/10 px-2.5 py-1 text-xs font-medium text-emerald-400">
                  <CheckCircle className="h-3 w-3" />
                  {t('bookings.calcom.statusConnected')}
                </span>
              )}
            </div>
            <p className="text-sm text-text-secondary mt-1">
              {calcomConnected
                ? t('bookings.calcom.bodyConnected')
                : t('bookings.calcom.bodyDisconnected')}
            </p>
            <div className="mt-4 flex items-center gap-3 flex-wrap">
              <Link
                to="/settings?tab=integrations"
                className="inline-flex items-center gap-1.5 rounded-lg bg-primary-500 px-3 py-1.5 text-xs font-medium text-white hover:bg-primary-600"
              >
                {calcomConnected
                  ? t('bookings.calcom.manage')
                  : t('bookings.calcom.connect')}
              </Link>
              <a
                href="https://app.cal.com/bookings"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-xs font-medium text-text-secondary hover:text-text-primary"
              >
                {t('bookings.calcom.viewInCalcom')}
                <ExternalLink className="h-3 w-3" />
              </a>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
