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
  AlertTriangle,
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
import { GoogleAttribution } from '../components/bookings/GoogleAttribution';
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
  // Comes down WITH the list, not fetched per row. It has to be on the row — accepting is an
  // owner override and the button is right here — but a fetch inside this component turned
  // thirty requests into thirty calls to learn thirty times that travel is off.
  const travel = booking.travelEstimate;
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
          {/* A confirmed booking whose calendar mirror failed used to look identical to a
              healthy one: green pill, nothing on the calendar, and for a channel booking no
              email either — so the owner only found out by noticing the absence. */}
          {booking.calendarSync === 'failed' && (
            <span className="inline-flex items-center gap-1 rounded-full bg-red-500/10 px-2 py-0.5 text-xs font-medium text-red-400">
              <AlertTriangle className="h-3 w-3" /> Not on your calendar
            </span>
          )}
          {booking.calendarSync === 'pending' && (
            <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/10 px-2 py-0.5 text-xs font-medium text-amber-400">
              Syncing…
            </span>
          )}
        </div>
        <div className="mt-1 text-sm text-text-secondary">
          {booking.attendeeName || 'Guest'}
          {booking.attendeeEmail ? ` · ${booking.attendeeEmail}` : ''}
          {booking.serviceName ? ` · ${booking.serviceName}` : ''}
          {booking.sourceChannel ? ` · via ${booking.sourceChannel}` : ''}
        </div>
        {booking.calendarSync === 'failed' && (
          <div className="mt-1 text-xs text-red-400">
            This appointment was confirmed to the customer but could not be written to your connected calendar.
            Reconnect the calendar in Setup, then add it manually if it is soon.
          </div>
        )}
        {booking.aiSummary && (
          <div className="mt-1 text-sm text-text-secondary whitespace-pre-wrap">{booking.aiSummary}</div>
        )}
        {(booking.customerPhone || booking.customerAddress) && (
          <div className="mt-1 text-sm text-text-secondary">
            {[booking.customerPhone, booking.customerAddress].filter(Boolean).join(' · ')}
          </div>
        )}
        {/*
          The service-area verdict. Only ever shown when it is NOT 'inside' — an in-area job
          is the unremarkable case and labelling it would bury the two that matter. Until now
          this existed only as a server log line, so an owner could hold back work for months
          and never learn the area they drew was costing them.
        */}
        {/*
          Both sentences are advice about a decision the owner has not taken yet, but the
          column survives Accept untouched — so a CONFIRMED booking, with a calendar invite
          and a confirmation email already sent, sat under a green pill being told it was not
          committed to. The flag stays either way; only the wording turns on whether the
          decision is still open.
        */}
        {booking.serviceAreaMatch === 'outside' && (
          <div className="mt-1 text-xs text-amber-400">
            {isRequest
              ? 'Outside your service area — you have not committed to this one.'
              : 'Outside your service area — accepted anyway.'}
          </div>
        )}
        {booking.serviceAreaMatch === 'unknown' && (
          <div className="mt-1 text-xs text-amber-400">
            {isRequest
              ? 'Address could not be matched to your service area — worth checking before you confirm.'
              : 'Address could not be matched to your service area.'}
          </div>
        )}
        {/*
          WHY this Request is sitting here, which until now lived only in a server log.

          A Request the travel gate captured looked identical to one captured for any other
          reason, and the case that needs the warning arrives with no other signal: when Google
          answers `ROUTE_NOT_FOUND` the gate degrades to a Request rather than refusing, because
          that answer means "no route for these coordinates with today's data" — a geocode in a
          canal or a road closed this week produces it as readily as an island does. Turning a
          paying customer away on a third party's data quality was the wrong call, but the
          Request it becomes is only useful if the owner can see what it is. ADR-0015 names the
          failure exactly: an owner drowning in Requests rubber-stamps them, which buys back the
          wrongness the strictness was meant to buy off.

          The wording turns on the decision, not on the status, which is the lesson the
          service-area note above had to learn the hard way: a sentence phrased as advice about
          a choice still open reads as nonsense once the choice is made. `overridden` is the
          same fact after Accept, and it stays on screen — a confirmed booking whose journey was
          never verified is precisely the one worth remembering on the morning of the job.

          `ok` and `degraded` are not rendered. Both are successful checks, and `degraded` is
          provenance rather than a fault — the ordinary state of a business whose jobs sit close
          together, where the flat gap settled the drive for free. Flagging it would put a
          warning on most of a good day and teach the owner to ignore all of them.
        */}
        {booking.travelCheck === 'captured' && (
          <div className="mt-1 text-xs text-amber-400" data-testid="travel-captured">
            {isRequest
              ? 'Travel could not clear this time. Check the journey before accepting.'
              : 'Travel could not clear this time — the journey was never verified.'}
          </div>
        )}
        {booking.travelCheck === 'overridden' && (
          <div className="mt-1 text-xs text-amber-400" data-testid="travel-captured">
            Travel could not clear this time — accepted anyway.
          </div>
        )}
        {/*
          What the owner is about to override. A RANGE, and wide on purpose: nothing has routed
          anything, so this is a straight line at the two speed bounds the gate reasons with. A
          single figure would be a guess wearing the clothes of a measurement, handed to the one
          person who must not be given one.
        */}
        {isRequest && travel && (
          <div className="mt-1 text-xs text-text-secondary" data-testid="travel-estimate">
            {[
              travel.before && `${travel.before.km} km from the job before (${travel.before.fastestMin}-${travel.before.slowestMin} min)`,
              travel.after && `${travel.after.km} km to the job after (${travel.after.fastestMin}-${travel.after.slowestMin} min)`,
            ]
              .filter(Boolean)
              .join(' · ')}
            <span className="text-text-secondary/70"> · straight-line distance, not a measured drive</span>
            {/*
              INSIDE the same container as the number it attributes, which is what the Maps
              terms require — an attribution in a page footer does not cover content rendered
              in a row. These kilometres are computed from coordinates Google placed, so they
              carry the obligation even though nothing here came back from a routing call.
            */}
            <span className="ml-2"><GoogleAttribution /></span>
          </div>
        )}
        {booking.notes && (
          <div className="mt-1 text-sm text-text-secondary whitespace-pre-wrap">{booking.notes}</div>
        )}
        {booking.intakeAnswers && booking.intakeAnswers.length > 0 && (
          <dl className="mt-1.5 space-y-0.5">
            {booking.intakeAnswers.map((qa, i) => (
              // Index, not label: duplicate labels are explicitly permitted (two questions
              // may legitimately read "Notes"), so keying on the label collides and React
              // drops one of the rows.
              // eslint-disable-next-line react/no-array-index-key -- labels are not unique
              <div key={`${qa.label}-${i}`} className="text-sm">
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

/** What travel time thought of one slot the owner is being shown, or null for a clean one. */
export type SlotTravelVerdict = 'unreachable' | 'requestable' | null;

/**
 * Which of the slots on screen carry a drive nobody could vouch for.
 *
 * THE OWNER IS WARNED, NEVER BLOCKED. Feasibility is a hard constraint against the bot and never
 * against the person who owns the diary, so the API hands this screen the WHOLE day and says
 * separately which entries in it are which. Annotating without warning would be strictly worse
 * than filtering — the impossible times would quietly return, looking exactly like the safe ones.
 *
 * Matching is on the slot's `start` string because both lists come from the same response, so
 * they are the same instants in the same format. Pure and exported so that stays pinned by a
 * test rather than by a component nobody renders in one.
 */
export function travelVerdictLookup(travel?: {
  requestableSlots?: Array<{ start: string }>;
  unreachableSlots?: Array<{ start: string }>;
}): (start: string) => SlotTravelVerdict {
  const unreachable = new Set((travel?.unreachableSlots ?? []).map((s) => s.start));
  const requestable = new Set((travel?.requestableSlots ?? []).map((s) => s.start));
  return (start) =>
    unreachable.has(start) ? 'unreachable' : requestable.has(start) ? 'requestable' : null;
}

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
    // Without this the booking being moved counts against its own day cap and its buffers
    // hide the slots either side, so a legitimate move shows no options at all.
    booking?.id,
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

  /**
   * What travel time made of each slot the owner is being shown.
   *
   * THE OWNER IS NEVER BLOCKED, ONLY WARNED. Feasibility is a hard constraint against the bot
   * and never against the person who owns the diary — an owner rearranging their own day knows
   * things the scheduler does not. So every slot stays clickable and the picker says which ones
   * carry a drive nobody could vouch for.
   *
   * Annotating without warning would be strictly worse than filtering: the list would silently
   * regain the impossible times and they would look exactly like the safe ones.
   */
  const travelVerdict = useMemo(() => travelVerdictLookup(data?.travel), [data]);

  // The fourth state, and the one easiest to drop: the check could not run at all, so NOTHING
  // below was assessed. Without saying so the picker implies a verification that never
  // happened — which is exactly the state travel is in during a Google outage, when the owner
  // most needs to know they are on their own judgement.
  const unassessed = data?.travel?.unavailableReason;

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
              {unassessed && (
                <p
                  data-testid="travel-unassessed"
                  className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-text-primary"
                >
                  {unassessed === 'no_address'
                    ? 'This booking has no address on it, so none of these times have been checked for travel.'
                    : unassessed === 'not_placeable'
                      ? 'This booking’s address could not be located, so none of these times have been checked for travel.'
                      : 'Travel could not be checked just now, so none of these times have been checked for it.'}{' '}
                  You can still pick any of them.
                </p>
              )}
              {grouped.map(([day, slots]) => (
                <div key={day}>
                  <div className="mb-2 text-xs font-medium uppercase tracking-wide text-text-secondary">
                    {day}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {slots.map((s) => {
                      const verdict = travelVerdict(s.start);
                      return (
                        <button
                          type="button"
                          key={s.start}
                          // Never disabled on a travel verdict. The owner decides.
                          disabled={reschedule.isPending}
                          title={
                            verdict === 'unreachable'
                              ? 'Too far from the job before or after it — this drive does not fit'
                              : verdict === 'requestable'
                                ? 'The drive may not fit; nothing has measured it'
                                : undefined
                          }
                          data-travel={verdict ?? undefined}
                          onClick={() => {
                            if (!booking) return;
                            reschedule.mutate(
                              { id: booking.id, newStartTime: s.start },
                              { onSuccess: onClose },
                            );
                          }}
                          className={`rounded-lg border px-3 py-1.5 text-sm text-text-primary disabled:opacity-50 ${
                            verdict === 'unreachable'
                              ? 'border-red-500/50 bg-red-500/10 hover:border-red-400'
                              : verdict === 'requestable'
                                ? 'border-amber-500/50 bg-amber-500/10 hover:border-amber-400'
                                : 'border-edge bg-surface-2 hover:border-primary-500 hover:bg-primary-500/10'
                          }`}
                        >
                          {timeLabel(s.start, timezone)}
                          {verdict === 'unreachable' && <span className="ml-1 text-red-400">·&nbsp;too far</span>}
                          {verdict === 'requestable' && <span className="ml-1 text-amber-400">·&nbsp;tight</span>}
                        </button>
                      );
                    })}
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
