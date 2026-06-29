/**
 * BookingReadinessCard
 * Capability-readiness MVP (change 7), booking slice. Renders the booking
 * capability's readiness — its ordered `missingSteps` (path to live, each with
 * its CTA deep-link) and non-blocking `attention` rows (e.g. "connect a calendar
 * to auto-confirm") — on the Bookings Setup tab.
 *
 * Modeled on OnboardingChecklist (Check/Circle icons, per-step action). Returns
 * null when booking is `live` with no attention (nothing left to nudge).
 *
 * ANCHOR-scoped (P1): the backend CTA routes are anchor deep-links, so the
 * parent only mounts this for the anchor bot.
 */

import React from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { Check, Circle, AlertTriangle, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { ReadinessResult, ReadinessCta } from '@/queries/useReadinessQueries';

export interface BookingReadinessCardProps {
  /** The booking capability result from GET /bots/readiness (undefined ⇒ booking doesn't apply ⇒ render nothing). */
  booking: ReadinessResult | undefined;
}

/**
 * The backend emits logical deep-links like `/bookings/setup`. Only `/bookings`
 * is a real route (the Setup tab lives inside it), so collapse the setup path to
 * `/bookings`. Any other route passes through unchanged.
 */
function resolveCtaRoute(route: string): string {
  return route === '/bookings/setup' ? '/bookings' : route;
}

const CtaLink: React.FC<{ cta: ReadinessCta }> = ({ cta }) => (
  <Button asChild size="sm" variant="ghost" className="shrink-0 gap-1">
    <Link to={resolveCtaRoute(cta.route)}>
      {cta.label}
      <ChevronRight className="h-3.5 w-3.5" />
    </Link>
  </Button>
);

export const BookingReadinessCard: React.FC<BookingReadinessCardProps> = ({ booking }) => {
  const { t } = useTranslation();

  // Booking doesn't apply (entitlement/feature off) → absent, no card.
  if (!booking) return null;

  const isLive = booking.state === 'live';
  const attention = booking.attention ?? [];

  // Live with nothing left to nudge → hide entirely (the page stops nagging).
  if (isLive && attention.length === 0) return null;

  return (
    <div className="mb-6 rounded-2xl border border-edge bg-surface-1/60 p-5">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-text-primary">
            {t('bookings.readiness.title')}
          </h2>
          <p className="text-xs text-text-muted">
            {isLive ? t('bookings.readiness.subtitleLive') : t('bookings.readiness.subtitleNotReady')}
          </p>
        </div>
        <span
          className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${
            isLive ? 'bg-emerald-500/10 text-emerald-400' : 'bg-amber-500/10 text-amber-400'
          }`}
        >
          {isLive ? t('bookings.readiness.state.live') : t('bookings.readiness.state.notReady')}
        </span>
      </div>

      <ul className="space-y-2">
        {/* Ordered path to live — each is an outstanding step (Circle). */}
        {booking.missingSteps.map((step) => (
          <li
            key={step.id}
            className="flex items-center justify-between gap-3 rounded-lg bg-surface-2/40 px-3 py-2"
          >
            <div className="flex min-w-0 items-center gap-3">
              <Circle
                className="h-4 w-4 shrink-0 text-text-muted"
                aria-label={t('bookings.readiness.stepNotDone')}
              />
              <p className="truncate text-sm text-text-primary">{step.label}</p>
            </div>
            {step.cta && <CtaLink cta={step.cta} />}
          </li>
        ))}

        {/* Non-blocking attention — booking already works, this unlocks MORE. */}
        {attention.map((item) => (
          <li
            key={item.code}
            className="flex items-center justify-between gap-3 rounded-lg bg-surface-2/40 px-3 py-2"
          >
            <div className="flex min-w-0 items-center gap-3">
              {isLive ? (
                <AlertTriangle className="h-4 w-4 shrink-0 text-amber-400" aria-hidden="true" />
              ) : (
                <Circle
                  className="h-4 w-4 shrink-0 text-text-muted"
                  aria-label={t('bookings.readiness.stepNotDone')}
                />
              )}
              <p className="truncate text-sm text-text-secondary">{item.label}</p>
            </div>
            {item.cta && <CtaLink cta={item.cta} />}
          </li>
        ))}

        {/* Live with no missing steps but standing attention — confirm the live state. */}
        {isLive && booking.missingSteps.length === 0 && (
          <li className="flex items-center gap-3 rounded-lg bg-surface-2/40 px-3 py-2">
            <Check
              className="h-4 w-4 shrink-0 text-emerald-400"
              aria-label={t('bookings.readiness.stepDone')}
            />
            <p className="truncate text-sm text-text-muted line-through">
              {t('bookings.readiness.liveStep')}
            </p>
          </li>
        )}
      </ul>
    </div>
  );
};
