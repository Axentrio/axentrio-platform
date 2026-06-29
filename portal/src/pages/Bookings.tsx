/**
 * Bookings Page
 * Pro+ feature. Non-Pro tenants see the locked-preview hero.
 *
 * This page IS the appointment dashboard — upcoming/past bookings with inline
 * cancel + reschedule, backed by the in-house scheduler. (Cal.com is shelved.)
 */

import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Calendar,
  Video,
  Loader2,
  CalendarClock,
  XCircle,
  CheckCircle2,
  Paperclip,
} from 'lucide-react';
import { api, extractApiErrorMessage } from '../services/apiClient';
import { toast } from 'sonner';
import { useHasFeature, useIsEntitled } from '../queries/useEntitlementsQueries';
import { LockedPreview } from '../components/billing/LockedPreview';
import { FeatureDisabledNotice } from '../components/billing/FeatureDisabledNotice';
import {
  useSchedulerConfig,
  useAdminBookings,
  useCancelBooking,
  useRescheduleBooking,
  useAcceptRequest,
  useDeclineRequest,
  useBookingAvailability,
  useServices,
  type AdminBooking,
  type BookingScope,
} from '../queries/useSchedulerQueries';
import { SchedulerSettings } from '../components/settings/SchedulerSettings';
import { CAPABILITY_READINESS_ENABLED } from '../config/featureFlags';
import { useBotReadiness } from '../queries/useReadinessQueries';
import { BookingReadinessCard } from '../components/bookings/BookingReadinessCard';
import { BookingSetupBanner } from '../components/bookings/BookingSetupBanner';
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

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function fmt(iso: string, tz: string, opts: Intl.DateTimeFormatOptions): string {
  const key = `${tz}|${JSON.stringify(opts)}`;
  let formatter = fmtCache.get(key);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-GB', { timeZone: tz, ...opts });
    fmtCache.set(key, formatter);
  }
  return formatter.format(new Date(iso));
}

const dayLabel = (iso: string, tz: string) =>
  fmt(iso, tz, { weekday: 'long', day: 'numeric', month: 'long' });
const timeLabel = (iso: string, tz: string) =>
  fmt(iso, tz, { hour: 'numeric', minute: '2-digit', hour12: true });

/** P5e — fetch a fresh signed URL for an attached file and open it (404 if removed). */
async function downloadFile(fileSessionId: string): Promise<void> {
  try {
    const { downloadUrl } = await api.get<{ downloadUrl: string }>(`/files/${fileSessionId}/download`);
    window.open(downloadUrl, '_blank', 'noopener');
  } catch (err) {
    toast.error(extractApiErrorMessage(err) ?? 'File is no longer available');
  }
}

// ---------------------------------------------------------------------------

export default function Bookings() {
  const { t } = useTranslation();
  const isEntitled = useIsEntitled('bookings');
  const hasBookings = useHasFeature('bookings'); // effective (entitled ∧ tenant toggle)
  const { data: config } = useSchedulerConfig(hasBookings);
  const { data: servicesData, isLoading: servicesLoading } = useServices(hasBookings);

  // Not entitled → upsell. Entitled but toggled off → opt-out notice (never upsell).
  if (!isEntitled) {
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
  if (!hasBookings) {
    return <FeatureDisabledNotice featureLabel={t('features.keys.bookings.label', { defaultValue: 'Bookings' })} />;
  }

  // First-run owners (no services configured yet) land on Setup so they're guided
  // to connect a calendar + add services; configured owners land on Appointments.
  // Returning from a calendar OAuth callback (?google=/?outlook=) also opens Setup
  // so the just-connected calendar + its toast are visible (SchedulerSettings, which
  // shows the toast + strips the param, lives in that tab). Gate the Tabs render on
  // the services query so the uncontrolled defaultValue is computed from real data.
  const hasServices = (servicesData?.services?.length ?? 0) > 0;
  const returnedFromCalendarOAuth = /[?&](google|outlook)=/.test(window.location.search);
  const defaultTab = returnedFromCalendarOAuth || !hasServices ? 'setup' : 'appointments';

  return (
    <div className="h-full overflow-y-auto">
      <div className="p-6 max-w-3xl mx-auto space-y-4">
      <div>
        <h1 className="text-2xl font-semibold text-text-primary">{t('bookings.title')}</h1>
        <p className="text-sm text-text-secondary mt-1">{t('bookings.intro')}</p>
      </div>
      {servicesLoading ? (
        <div className="flex justify-center py-12">
          <Loader2 className="w-6 h-6 animate-spin text-text-secondary" />
        </div>
      ) : (
        <Tabs defaultValue={defaultTab} className="space-y-4">
          <TabsList>
            <TabsTrigger value="appointments">Appointments</TabsTrigger>
            <TabsTrigger value="setup">Setup</TabsTrigger>
          </TabsList>
          <TabsContent value="appointments">
            <InternalBookingsDashboard timezone={config?.availability?.timezone ?? DEFAULT_TZ} />
          </TabsContent>
          <TabsContent value="setup">
            <BookingReadinessSection enabled={hasBookings} />
            <SchedulerSettings />
          </TabsContent>
        </Tabs>
      )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

/**
 * Capability-readiness (change 7), booking slice — mounted on the Setup tab.
 *
 * ANCHOR-scoped (P1): we call the readiness endpoint with NO `botId`, so it
 * resolves the tenant's anchor bot and returns its booking capability. The CTA
 * routes are anchor deep-links, so this only ever reflects the anchor — never a
 * non-anchor bot. Behind the CAPABILITY_READINESS_ENABLED flag (ON in dev).
 */
function BookingReadinessSection({ enabled }: { enabled: boolean }) {
  const active = CAPABILITY_READINESS_ENABLED && enabled;
  const { data } = useBotReadiness(undefined, { enabled: active });

  if (!active || !data) return null;

  const booking = data.capabilities.find((c) => c.capability === 'booking');

  return (
    <>
      <BookingSetupBanner botId={data.botId} booking={booking} />
      <BookingReadinessCard booking={booking} />
    </>
  );
}

// ---------------------------------------------------------------------------

function InternalBookingsDashboard({ timezone }: { timezone: string }) {
  const [scope, setScope] = useState<BookingScope>('upcoming');
  const { data, isLoading } = useAdminBookings(scope);
  const [cancelTarget, setCancelTarget] = useState<AdminBooking | null>(null);
  const [rescheduleTarget, setRescheduleTarget] = useState<AdminBooking | null>(null);
  const [declineTarget, setDeclineTarget] = useState<AdminBooking | null>(null);

  const cancel = useCancelBooking();
  const accept = useAcceptRequest();
  const decline = useDeclineRequest();
  const bookings = data?.bookings ?? [];

  return (
    <div className="rounded-xl border border-edge bg-surface-1">
      <Tabs value={scope} onValueChange={(v) => setScope(v as BookingScope)}>
        <div className="border-b border-edge px-4 pt-4">
          <TabsList>
            <TabsTrigger value="upcoming">Upcoming</TabsTrigger>
            <TabsTrigger value="past">Past</TabsTrigger>
            <TabsTrigger value="requests">Requests</TabsTrigger>
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
              {scope === 'requests' ? 'No appointment requests yet.' : `No ${scope} appointments.`}
            </div>
          ) : (
            <ul className="divide-y divide-edge">
              {bookings.map((b) => (
                <BookingRow
                  key={b.id}
                  booking={b}
                  timezone={timezone}
                  canManage={scope === 'upcoming'}
                  isRequest={scope === 'requests'}
                  acting={accept.isPending || decline.isPending}
                  onCancel={() => setCancelTarget(b)}
                  onReschedule={() => setRescheduleTarget(b)}
                  onAccept={() => accept.mutate(b.id)}
                  onDecline={() => setDeclineTarget(b)}
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

      {/* Decline request confirmation */}
      <AlertDialog open={!!declineTarget} onOpenChange={(o) => !o && setDeclineTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Decline this request?</AlertDialogTitle>
            <AlertDialogDescription>
              {declineTarget && (
                <>
                  {declineTarget.attendeeName || declineTarget.attendeeEmail} —{' '}
                  {dayLabel(declineTarget.startTime, timezone)} at {timeLabel(declineTarget.startTime, timezone)}.
                  This closes the request. No appointment is created and the customer is not emailed.
                </>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction
              className="bg-red-600 hover:bg-red-700"
              onClick={() => {
                if (declineTarget) decline.mutate({ id: declineTarget.id });
                setDeclineTarget(null);
              }}
            >
              Decline request
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
    case 'request_created':
      return { label: 'Request', cls: 'bg-indigo-500/10 text-indigo-400' };
    default:
      return { label: status, cls: 'bg-surface-2 text-text-secondary' };
  }
}

function BookingRow({
  booking,
  timezone,
  canManage,
  isRequest,
  acting,
  onCancel,
  onReschedule,
  onAccept,
  onDecline,
}: {
  booking: AdminBooking;
  timezone: string;
  canManage: boolean;
  isRequest: boolean;
  acting: boolean;
  onCancel: () => void;
  onReschedule: () => void;
  onAccept: () => void;
  onDecline: () => void;
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
          {booking.serviceName ? ` · ${booking.serviceName}` : ''}
        </div>
        {(booking.customerPhone || booking.customerAddress) && (
          <div className="mt-1 text-sm text-text-secondary">
            {[booking.customerPhone, booking.customerAddress].filter(Boolean).join(' · ')}
          </div>
        )}
        {booking.notes && (
          <div className="mt-1 text-sm text-text-secondary whitespace-pre-wrap">{booking.notes}</div>
        )}
        {booking.intakeAnswers && booking.intakeAnswers.length > 0 && (
          <dl className="mt-1.5 space-y-0.5">
            {booking.intakeAnswers.map((qa) => (
              <div key={qa.label} className="text-sm">
                <dt className="inline text-text-muted">{qa.label}: </dt>
                <dd className="inline text-text-secondary whitespace-pre-wrap">{qa.answer}</dd>
              </div>
            ))}
          </dl>
        )}
        {booking.uploadedFiles && booking.uploadedFiles.length > 0 && (
          <div className="mt-1.5 flex flex-wrap gap-2">
            {booking.uploadedFiles.map((f) => (
              <button
                key={f.fileSessionId}
                type="button"
                onClick={() => downloadFile(f.fileSessionId)}
                className="inline-flex items-center gap-1 rounded-md border border-edge bg-surface-2 px-2 py-0.5 text-xs text-text-secondary hover:border-primary-500 hover:text-text-primary"
              >
                <Paperclip className="h-3 w-3" /> {f.fileName}
              </button>
            ))}
          </div>
        )}
        {booking.meetingUrl && /^https?:\/\//i.test(booking.meetingUrl) && (
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
      {isRequest && (
        <div className="flex shrink-0 items-center gap-2">
          <Button size="sm" disabled={acting} onClick={onAccept}>
            <CheckCircle2 className="mr-1 h-3.5 w-3.5" />
            Accept
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={acting}
            className="text-red-400 hover:text-red-300"
            onClick={onDecline}
          >
            <XCircle className="mr-1 h-3.5 w-3.5" />
            Decline
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
    booking?.serviceId,
    booking?.durationMin,
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
                        type="button"
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
