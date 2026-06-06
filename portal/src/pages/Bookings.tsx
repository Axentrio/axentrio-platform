/**
 * Bookings Page
 * Pro+ feature. Non-Pro tenants see the locked-preview hero.
 *
 * - Cal.com provider: this page surfaces connection status and deep-links into
 *   Settings → Integrations; Cal.com itself owns the appointment list.
 * - Internal provider: this page IS the appointment dashboard — upcoming/past
 *   bookings with inline cancel + reschedule, backed by the in-house scheduler.
 */

import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  Calendar,
  CheckCircle,
  ExternalLink,
  Video,
  Loader2,
  CalendarClock,
  XCircle,
} from 'lucide-react';
import { useHasFeature } from '../queries/useEntitlementsQueries';
import { useIntegrations } from '../queries/useIntegrationQueries';
import { LockedPreview } from '../components/billing/LockedPreview';
import {
  useSchedulerConfig,
  useAdminBookings,
  useCancelBooking,
  useRescheduleBooking,
  useBookingAvailability,
  type AdminBooking,
  type BookingScope,
} from '../queries/useSchedulerQueries';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '../components/ui/tabs';
import { Button } from '../components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '../components/ui/dialog';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogFooter,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogAction,
  AlertDialogCancel,
} from '../components/ui/alert-dialog';

const DEFAULT_TZ =
  typeof Intl !== 'undefined' ? Intl.DateTimeFormat().resolvedOptions().timeZone : 'UTC';

function fmt(iso: string, tz: string, opts: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone: tz, ...opts }).format(new Date(iso));
}

const dayLabel = (iso: string, tz: string) =>
  fmt(iso, tz, { weekday: 'long', day: 'numeric', month: 'long' });
const timeLabel = (iso: string, tz: string) =>
  fmt(iso, tz, { hour: 'numeric', minute: '2-digit', hour12: true });

// ---------------------------------------------------------------------------

export default function Bookings() {
  const { t } = useTranslation();
  const hasBookings = useHasFeature('bookings');
  const { data: config } = useSchedulerConfig();

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
    <div className="p-6 max-w-3xl mx-auto space-y-4">
      <div>
        <h1 className="text-2xl font-semibold text-text-primary">{t('bookings.title')}</h1>
        <p className="text-sm text-text-secondary mt-1">{t('bookings.intro')}</p>
      </div>
      {config?.provider === 'internal' ? (
        <InternalBookingsDashboard timezone={config.availability?.timezone ?? DEFAULT_TZ} />
      ) : (
        <CalcomCard />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

function CalcomCard() {
  const { t } = useTranslation();
  const { data: integrations } = useIntegrations();
  const calcomConnected = Boolean(
    integrations?.calcom?.hasApiKey && integrations?.calcom?.eventTypeId,
  );

  return (
    <div className="rounded-xl border border-edge bg-surface-1 p-6">
      <div className="flex items-start gap-4">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary-600/10">
          <Calendar className="h-5 w-5 text-primary-400" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <h2 className="text-base font-semibold text-text-primary">{t('bookings.calcom.title')}</h2>
            {calcomConnected && (
              <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-500/10 px-2.5 py-1 text-xs font-medium text-emerald-400">
                <CheckCircle className="h-3 w-3" />
                {t('bookings.calcom.statusConnected')}
              </span>
            )}
          </div>
          <p className="text-sm text-text-secondary mt-1">
            {calcomConnected ? t('bookings.calcom.bodyConnected') : t('bookings.calcom.bodyDisconnected')}
          </p>
          <div className="mt-4 flex items-center gap-3 flex-wrap">
            <Link
              to="/settings?tab=integrations"
              className="inline-flex items-center gap-1.5 rounded-lg bg-primary-500 px-3 py-1.5 text-xs font-medium text-white hover:bg-primary-600"
            >
              {calcomConnected ? t('bookings.calcom.manage') : t('bookings.calcom.connect')}
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
  );
}

// ---------------------------------------------------------------------------

function InternalBookingsDashboard({ timezone }: { timezone: string }) {
  const [scope, setScope] = useState<BookingScope>('upcoming');
  const { data, isLoading } = useAdminBookings(scope);
  const [cancelTarget, setCancelTarget] = useState<AdminBooking | null>(null);
  const [rescheduleTarget, setRescheduleTarget] = useState<AdminBooking | null>(null);

  const cancel = useCancelBooking();
  const bookings = data?.bookings ?? [];

  return (
    <div className="rounded-xl border border-edge bg-surface-1">
      <Tabs value={scope} onValueChange={(v) => setScope(v as BookingScope)}>
        <div className="border-b border-edge px-4 pt-4">
          <TabsList>
            <TabsTrigger value="upcoming">Upcoming</TabsTrigger>
            <TabsTrigger value="past">Past</TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value={scope} className="mt-0">
          {isLoading ? (
            <div className="flex items-center justify-center p-10 text-text-secondary">
              <Loader2 className="h-5 w-5 animate-spin" />
            </div>
          ) : bookings.length === 0 ? (
            <div className="p-10 text-center text-sm text-text-secondary">
              <Calendar className="mx-auto mb-2 h-6 w-6 opacity-40" />
              No {scope} appointments.
            </div>
          ) : (
            <ul className="divide-y divide-edge">
              {bookings.map((b) => (
                <BookingRow
                  key={b.id}
                  booking={b}
                  timezone={timezone}
                  canManage={scope === 'upcoming'}
                  onCancel={() => setCancelTarget(b)}
                  onReschedule={() => setRescheduleTarget(b)}
                />
              ))}
            </ul>
          )}
          <p className="px-4 py-3 text-xs text-text-secondary">Times shown in {timezone}.</p>
        </TabsContent>
      </Tabs>

      {/* Cancel confirmation */}
      <AlertDialog open={!!cancelTarget} onOpenChange={(o) => !o && setCancelTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Cancel this appointment?</AlertDialogTitle>
            <AlertDialogDescription>
              {cancelTarget && (
                <>
                  {cancelTarget.attendeeName || cancelTarget.attendeeEmail} —{' '}
                  {dayLabel(cancelTarget.startTime, timezone)} at {timeLabel(cancelTarget.startTime, timezone)}.
                  The attendee will get a cancellation email and the calendar event will be removed.
                </>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction
              className="bg-red-600 hover:bg-red-700"
              onClick={() => {
                if (cancelTarget) cancel.mutate({ id: cancelTarget.id });
                setCancelTarget(null);
              }}
            >
              Cancel appointment
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Reschedule picker */}
      <RescheduleDialog
        booking={rescheduleTarget}
        timezone={timezone}
        onClose={() => setRescheduleTarget(null)}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------

function statusPill(status: string): { label: string; cls: string } {
  switch (status) {
    case 'confirmed':
      return { label: 'Confirmed', cls: 'bg-emerald-500/10 text-emerald-400' };
    case 'cancelled':
      return { label: 'Cancelled', cls: 'bg-red-500/10 text-red-400' };
    case 'pending':
      return { label: 'Pending', cls: 'bg-amber-500/10 text-amber-400' };
    default:
      return { label: status, cls: 'bg-surface-2 text-text-secondary' };
  }
}

function BookingRow({
  booking,
  timezone,
  canManage,
  onCancel,
  onReschedule,
}: {
  booking: AdminBooking;
  timezone: string;
  canManage: boolean;
  onCancel: () => void;
  onReschedule: () => void;
}) {
  const pill = statusPill(booking.status);
  return (
    <li className="flex items-start gap-4 px-4 py-4">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm font-medium text-text-primary">
            {dayLabel(booking.startTime, timezone)}
          </span>
          <span className="text-sm text-text-secondary">
            {timeLabel(booking.startTime, timezone)} – {timeLabel(booking.endTime, timezone)}
          </span>
          <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${pill.cls}`}>
            {pill.label}
          </span>
        </div>
        <div className="mt-1 text-sm text-text-secondary">
          {booking.attendeeName || 'Guest'}
          {booking.attendeeEmail ? ` · ${booking.attendeeEmail}` : ''}
        </div>
        {booking.meetingUrl && (
          <a
            href={booking.meetingUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-1 inline-flex items-center gap-1 text-xs font-medium text-primary-400 hover:text-primary-300"
          >
            <Video className="h-3 w-3" />
            Join Meet
          </a>
        )}
      </div>
      {canManage && (
        <div className="flex shrink-0 items-center gap-2">
          <Button variant="outline" size="sm" onClick={onReschedule}>
            <CalendarClock className="mr-1 h-3.5 w-3.5" />
            Reschedule
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="text-red-400 hover:text-red-300"
            onClick={onCancel}
          >
            <XCircle className="mr-1 h-3.5 w-3.5" />
            Cancel
          </Button>
        </div>
      )}
    </li>
  );
}

// ---------------------------------------------------------------------------

function RescheduleDialog({
  booking,
  timezone,
  onClose,
}: {
  booking: AdminBooking | null;
  timezone: string;
  onClose: () => void;
}) {
  const reschedule = useRescheduleBooking();

  // 30-day window from now; computed once per open to keep the query key stable.
  const window = useMemo(() => {
    if (!booking) return null;
    const start = new Date();
    const end = new Date(start.getTime() + 30 * 24 * 3600_000);
    return { start: start.toISOString(), end: end.toISOString() };
  }, [booking]);

  const { data, isLoading } = useBookingAvailability(
    window?.start ?? '',
    window?.end ?? '',
    !!booking,
  );

  // Group slots by day (in the owner's timezone).
  const grouped = useMemo(() => {
    const out = new Map<string, { start: string }[]>();
    for (const s of data?.slots ?? []) {
      const key = dayLabel(s.start, timezone);
      if (!out.has(key)) out.set(key, []);
      out.get(key)!.push(s);
    }
    return Array.from(out.entries());
  }, [data, timezone]);

  return (
    <Dialog open={!!booking} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Reschedule appointment</DialogTitle>
          <DialogDescription>
            {booking && (
              <>
                Currently {dayLabel(booking.startTime, timezone)} at{' '}
                {timeLabel(booking.startTime, timezone)}. Pick a new time — the attendee gets an updated
                invite.
              </>
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[50vh] overflow-y-auto pr-1">
          {isLoading ? (
            <div className="flex items-center justify-center p-8 text-text-secondary">
              <Loader2 className="h-5 w-5 animate-spin" />
            </div>
          ) : grouped.length === 0 ? (
            <p className="p-6 text-center text-sm text-text-secondary">
              No available slots in the next 30 days.
            </p>
          ) : (
            <div className="space-y-4">
              {grouped.map(([day, slots]) => (
                <div key={day}>
                  <div className="mb-2 text-xs font-medium uppercase tracking-wide text-text-secondary">
                    {day}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {slots.map((s) => (
                      <button
                        key={s.start}
                        disabled={reschedule.isPending}
                        onClick={() => {
                          if (!booking) return;
                          reschedule.mutate(
                            { id: booking.id, newStartTime: s.start },
                            { onSuccess: onClose },
                          );
                        }}
                        className="rounded-lg border border-edge bg-surface-2 px-3 py-1.5 text-sm text-text-primary hover:border-primary-500 hover:bg-primary-500/10 disabled:opacity-50"
                      >
                        {timeLabel(s.start, timezone)}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
        <p className="text-xs text-text-secondary">Times shown in {timezone}.</p>
      </DialogContent>
    </Dialog>
  );
}
