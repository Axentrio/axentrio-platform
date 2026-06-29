/**
 * BookingSetupBanner
 * Capability-readiness MVP (change 7), booking slice. A dismissible "booking
 * isn't live yet" banner shown ON the Bookings Setup tab when the booking
 * capability applies but is NOT live.
 *
 * Modeled on the dashboard OnboardingBanner — localStorage dismissal, here keyed
 * PER-BOT (`booking_setup_dismissed:<botId>`) so dismissing it for one bot does
 * not silence it for another. ANCHOR-scoped in P1 (parent passes the anchor's
 * botId + result).
 */

import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, X } from 'lucide-react';
import type { ReadinessResult } from '@/queries/useReadinessQueries';

const dismissedKey = (botId: string) => `booking_setup_dismissed:${botId}`;

export interface BookingSetupBannerProps {
  /** The resolved (anchor) bot id — namespaces the per-bot dismissal. */
  botId: string;
  /** The booking capability result (undefined ⇒ booking doesn't apply ⇒ no banner). */
  booking: ReadinessResult | undefined;
}

export const BookingSetupBanner: React.FC<BookingSetupBannerProps> = ({ botId, booking }) => {
  const { t } = useTranslation();
  const [dismissed, setDismissed] = useState(
    () => localStorage.getItem(dismissedKey(botId)) === 'true',
  );

  // Show ONLY when booking applies (present) AND it is not live yet.
  if (!booking || booking.state === 'live') return null;
  if (dismissed) return null;

  const handleDismiss = () => {
    localStorage.setItem(dismissedKey(botId), 'true');
    setDismissed(true);
  };

  return (
    <div className="mb-4 flex items-start justify-between gap-3 rounded-xl border border-amber-500/30 bg-amber-500/5 p-4">
      <div className="flex min-w-0 items-start gap-3">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" aria-hidden="true" />
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-text-primary">
            {t('bookings.readiness.banner.title')}
          </h3>
          <p className="mt-0.5 text-xs text-text-muted">
            {t('bookings.readiness.banner.subtitle')}
          </p>
        </div>
      </div>
      <button
        type="button"
        onClick={handleDismiss}
        className="shrink-0 text-text-muted transition-colors hover:text-text-secondary"
        aria-label={t('bookings.readiness.banner.dismiss')}
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
};
