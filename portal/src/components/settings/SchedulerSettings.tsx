/**
 * Internal scheduler settings — configure the in-house booking engine: Google
 * Calendar connection, the event type, and weekly availability. (Cal.com is
 * shelved; the built-in scheduler is the only provider.)
 */
import React, { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { CalendarClock, Save, Check, Plus, Trash2, Eye, AlertTriangle } from 'lucide-react';
import { toast } from 'sonner';
import { useQueryClient } from '@tanstack/react-query';
import { Card, CardHeader, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { AddressAutocomplete } from './AddressAutocomplete';
import { Checkbox } from '@/components/ui/checkbox';
import { DatePicker } from '@/components/ui/date-picker';
import { cn } from '@/lib/utils';
import {
  useSchedulerConfig,
  useUpdateSchedulerConfig,
  useUploadConfirmationAttachment,
  useDeleteConfirmationAttachment,
  type ConfirmationAttachment,
  type WeeklyHours,
  type Weekday,
  type TimeWindow,
  type VenueAddress,
  type WorkLocation,
  type SchedulerConfig,
  type UpdateSchedulerPayload,
} from '../../queries/useSchedulerQueries';
import {
  useGoogleCalendarStatus,
  useConnectGoogleCalendar,
  useDisconnectGoogleCalendar,
} from '../../queries/useGoogleCalendarQueries';
import {
  useOutlookCalendarStatus,
  useConnectOutlookCalendar,
  useDisconnectOutlookCalendar,
} from '../../queries/useOutlookCalendarQueries';
import { useBots } from '@/queries/useBotsQueries';
import { ServicesSection } from './ServicesSection';
import { ServiceAreaField } from './ServiceAreaField';
import {
  DAYS,
  DEFAULT_WINDOW,
  type DayRow,
  type SchedulerFormState,
  overridesFromConfig,
  rowsFromWeeklyHours,
  createSchedulerForm,
  schedulerFormReducer,
  makeFieldSetter,
} from './scheduler/scheduler-types';
import { WindowList } from './scheduler/window-list';
import { SlotPreview } from './scheduler/slot-preview';
import { OptionalNumberField, NumberField } from './scheduler/number-fields';

/** The useState-shaped setter `makeFieldSetter` returns for one form field. */
type FormSetter<K extends keyof SchedulerFormState> = (
  value: SchedulerFormState[K] | ((prev: SchedulerFormState[K]) => SchedulerFormState[K]),
) => void;

/** The venue fields hydration writes into the form. */
function venueFromConfig(data: SchedulerConfig): VenueAddress {
  return {
    placeId: data.venueAddress?.placeId ?? null,
    street: data.venueAddress?.street ?? null,
    postalCode: data.venueAddress?.postalCode ?? null,
    city: data.venueAddress?.city ?? null,
    country: data.venueAddress?.country ?? null,
  };
}

/** The travel fields hydration writes into the form. */
function travelFieldsFromConfig(data: SchedulerConfig) {
  return {
    enabled: data.travel?.enabled === true,
    startFromBase: data.travel?.startFromBase === true,
    baseDepartOffsetMin: data.travel?.baseDepartOffsetMin ?? 0,
    groupingPeriod: data.travel?.groupingPeriod ?? 'none',
    maxTravelMin:
      data.travel?.maxTravelMin === null || data.travel?.maxTravelMin === undefined
        ? ''
        : String(data.travel.maxTravelMin),
  };
}

/** The business-wide booking rules hydration writes into the form. */
function rulesFromConfig(data: SchedulerConfig): SchedulerFormState['rules'] {
  return {
    maxBookingsPerDay: data.bookingRules?.maxBookingsPerDay ?? null,
    maxBookedMinutesPerDay: data.bookingRules?.maxBookedMinutesPerDay ?? null,
    minGapMin: data.bookingRules?.minGapMin ?? null,
    defaultBufferBeforeMin: data.bookingRules?.defaultBufferBeforeMin ?? null,
    defaultBufferAfterMin: data.bookingRules?.defaultBufferAfterMin ?? null,
    defaultMinNoticeMin: data.bookingRules?.defaultMinNoticeMin ?? null,
    defaultMaxHorizonDays: data.bookingRules?.defaultMaxHorizonDays ?? null,
  };
}



function initialSchedulerBotId(): string | undefined {
  return new URLSearchParams(window.location.search).get('botId') ?? undefined;
}

function useCalendarOAuthReturnToast(
  googleStatus: { isFetched: boolean; data?: { connected?: boolean } },
  outlookStatus: { isFetched: boolean; data?: { connected?: boolean } },
  queryClient: ReturnType<typeof useQueryClient>,
) {
  useEffect(() => {
    if (!googleStatus.isFetched || !outlookStatus.isFetched) return;
    const params = new URLSearchParams(window.location.search);
    const providers: Array<{ key: 'google' | 'outlook'; label: string }> = [
      { key: 'google', label: 'Google Calendar' },
      { key: 'outlook', label: 'Outlook Calendar' },
    ];
    let changed = false;
    for (const { key, label } of providers) {
      const v = params.get(key);
      if (!v) continue;
      if (v === 'connected') {
        toast.success(`${label} connected`);
        queryClient.invalidateQueries({ queryKey: [key, 'status'] });
      } else if (v === 'error') {
        const otherConnected =
          key === 'google' ? outlookStatus.data?.connected : googleStatus.data?.connected;
        const otherLabel = key === 'google' ? 'Outlook' : 'Google';
        toast.error(
          otherConnected
            ? `This Agent already uses ${otherLabel} Calendar. Disconnect ${otherLabel} first.`
            : `${label} connection failed`,
        );
      }
      params.delete(key);
      params.delete('botId');
      changed = true;
    }
    if (params.get('teams') === 'unavailable') {
      toast.warning(
        "Connected a personal Microsoft account — video bookings won't get a Teams meeting link. Reconnect a work or school account to enable video links.",
      );
      params.delete('teams');
      changed = true;
    }
    if (!changed) return;
    const qs = params.toString();
    window.history.replaceState({}, '', window.location.pathname + (qs ? `?${qs}` : ''));
  }, [
    queryClient,
    googleStatus.isFetched,
    outlookStatus.isFetched,
    googleStatus.data?.connected,
    outlookStatus.data?.connected,
  ]);
}


export const SchedulerSettings: React.FC = () => {
  const { data: bots } = useBots();
  const agents = bots?.bots ?? [];
  const multiAgent = agents.length > 1;

  /**
   * Which Agent is being edited. `undefined` means the tenant's default.
   *
   * Undefined rather than "the anchor's id" on purpose: a single-Agent tenant then sends
   * exactly the requests it always sent, which is what makes "no change for them" a fact
   * about the wire rather than a claim about the UI.
   */
  const [botId, setBotId] = useState<string | undefined>(
    // SEEDED FROM THE URL, because the calendar connect flow leaves the page and comes back.
    // The OAuth callback appends the Agent it connected FOR, taken from its signed state — so
    // without reading it here an owner who connects Agent B's calendar returns to the DEFAULT
    // Agent's editor and is toasted "connected" over the anchor's disconnected status. An id
    // that is not theirs simply 404s on the next read, which is the same refusal any other
    // route takes.
    initialSchedulerBotId
  );
  /** The serialised payload as hydration left it — `null` until the next hydration lands. */
  const hydratedPayload = useRef<string | null>(null);

  const { data, isLoading, refetch } = useSchedulerConfig(true, botId);
  /**
   * Which roles this owner's address actually plays (#79, LP1).
   *
   * Derived server-side from the Service catalog and read here rather than re-derived: the
   * precedence between `locationType` and `customerAddressRequired` is subtle, and two
   * implementations of it would eventually disagree about which copy to show. Defaults to
   * `at_one_location`, which is the wording this screen has always used - an older API that does
   * not send the field yet changes nothing.
   */
  const workLocation = data?.workLocation ?? 'at_one_location';

  const update = useUpdateSchedulerConfig(botId);
  const queryClient = useQueryClient();
  // EVERY calendar hook takes the Agent too. Scoping the settings without these would leave
  // the Disconnect button beside Agent B's name disconnecting Agent A's calendar.
  const googleStatus = useGoogleCalendarStatus(botId);
  const connectGoogle = useConnectGoogleCalendar(botId);
  const disconnectGoogle = useDisconnectGoogleCalendar(botId);
  const outlookStatus = useOutlookCalendarStatus(botId);
  const connectOutlook = useConnectOutlookCalendar(botId);
  const disconnectOutlook = useDisconnectOutlookCalendar(botId);

  useCalendarOAuthReturnToast(googleStatus, outlookStatus, queryClient);

  // One reducer for the whole scheduler form (react-doctor prefer-useReducer).
  // Field state + hydration live in `form`; the `setX` wrappers below keep the
  // exact useState API, so every existing call site is unchanged.
  const [form, dispatch] = useReducer(schedulerFormReducer, undefined, createSchedulerForm);
  const {
    availabilityMode,
    slotGranularityMin,
    days,
    overrides,
    serviceArea,
    venue,
    reviewingVenue,
    travelEnabled,
    travelStartFromBase,
    travelBaseDepart,
    travelGroupingPeriod,
    travelMaxTravelMin,
    bookingsPaused,
    confirmationExtraInfo,
    rules,
    showPreview,
    hydrated,
  } = form;
  const {
    setAvailabilityMode,
    setSlotGranularityMin,
    setDays,
    setOverrides,
    setServiceArea,
    setVenue,
    setReviewingVenue,
    setTravelEnabled,
    setTravelStartFromBase,
    setTravelBaseDepart,
    setTravelGroupingPeriod,
    setTravelMaxTravelMin,
    setBookingsPaused,
    setConfirmationExtraInfo,
    setRules,
    setShowPreview,
    setHydrated,
  } = useMemo(
    () => ({
      setAvailabilityMode: makeFieldSetter(dispatch, 'availabilityMode'),
      setSlotGranularityMin: makeFieldSetter(dispatch, 'slotGranularityMin'),
      setDays: makeFieldSetter(dispatch, 'days'),
      setOverrides: makeFieldSetter(dispatch, 'overrides'),
      setServiceArea: makeFieldSetter(dispatch, 'serviceArea'),
      setVenue: makeFieldSetter(dispatch, 'venue'),
      setReviewingVenue: makeFieldSetter(dispatch, 'reviewingVenue'),
      setTravelEnabled: makeFieldSetter(dispatch, 'travelEnabled'),
      setTravelStartFromBase: makeFieldSetter(dispatch, 'travelStartFromBase'),
      setTravelBaseDepart: makeFieldSetter(dispatch, 'travelBaseDepart'),
      setTravelGroupingPeriod: makeFieldSetter(dispatch, 'travelGroupingPeriod'),
      setTravelMaxTravelMin: makeFieldSetter(dispatch, 'travelMaxTravelMin'),
      setBookingsPaused: makeFieldSetter(dispatch, 'bookingsPaused'),
      setConfirmationExtraInfo: makeFieldSetter(dispatch, 'confirmationExtraInfo'),
      setRules: makeFieldSetter(dispatch, 'rules'),
      setShowPreview: makeFieldSetter(dispatch, 'showPreview'),
      setHydrated: makeFieldSetter(dispatch, 'hydrated'),
    }),
    [],
  );
  // travel*, bookingsPaused, rules, showPreview and hydrated now live in `form` above.

  useEffect(() => {
    if (!data || hydrated) return;
    if (data.availability) {
      setAvailabilityMode(data.availability.availabilityMode ?? 'business_hours');
      setSlotGranularityMin(data.availability.slotGranularityMin);
      setDays(rowsFromWeeklyHours(data.availability.weeklyHours));
      setOverrides(overridesFromConfig(data.availability.dateOverrides));
    }
    // Outside the availability branch: a bot can have a service area before it has hours.
    setServiceArea(Array.isArray(data.serviceArea) ? data.serviceArea : []);
    setBookingsPaused(data.bookingsPaused === true);
    setConfirmationExtraInfo(data.confirmationEmail?.extraInfo ?? '');
    setVenue(venueFromConfig(data));
    // Read as one object, then written field by field: the setters are per-field, and the
    // mapping is what the hydration test pins.
    const travel = travelFieldsFromConfig(data);
    setTravelEnabled(travel.enabled);
    setTravelStartFromBase(travel.startFromBase);
    setTravelBaseDepart(travel.baseDepartOffsetMin);
    setTravelGroupingPeriod(travel.groupingPeriod);
    setTravelMaxTravelMin(travel.maxTravelMin);
    setRules(rulesFromConfig(data));
    setHydrated(true);
  }, [data, hydrated]);

  /**
   * What "unchanged" means for the Agent currently loaded.
   *
   * Taken in a SEPARATE effect, after hydration has flipped, because the payload is built from
   * state the hydrating effect is still in the middle of setting — snapshotting inside it would
   * capture the previous Agent's values and call every form clean.
   */
  useEffect(() => {
    if (hydrated && hydratedPayload.current === null) {
      hydratedPayload.current = JSON.stringify(buildPayload());
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- snapshot once per hydration
  }, [hydrated]);


  // Inline validation for the availability section (per-service rules live in
  // the service editor). Blocks an invalid availability save.
  /**
   * Change which Agent is being edited, without carrying one Agent's edits onto another.
   *
   * THE EDITOR HOLDS THE WHOLE CONFIGURATION IN LOCAL STATE and writes it back wholesale, so
   * switching mid-edit would leave Agent A's opening hours sitting in the form and the next
   * Save would write them onto Agent B. That is the same wholesale-write trap the hydrate/save
   * tests exist for, arriving through a control that did not exist when they were written.
   *
   * Hydration is keyed on the loaded config, so the switch itself only has to clear the
   * decision: confirm, then let the new Agent's data land.
   */
  const switchAgent = (next: string | undefined) => {
    if (next === botId) return;
    const dirty = hydratedPayload.current !== null && hydratedPayload.current !== JSON.stringify(buildPayload());
    if (dirty && !window.confirm('You have unsaved changes. Switching Agent will discard them.')) return;
    // Cleared so the next Agent's hydration is what defines "unchanged" from here.
    hydratedPayload.current = null;
    // AND re-armed, or the new Agent's config never lands: hydration is gated on this flag, so
    // leaving it true would show Agent A's form under Agent B's name — the exact confusion the
    // picker exists to remove.
    setHydrated(false);
    setBotId(next);
  };

  const errors = useMemo<string[]>(() => {
    const e: string[] = [];
    const check = (label: string, windows: TimeWindow[]) => {
      for (const w of windows) if (w.start >= w.end) e.push(`${label}: end time must be after start time.`);
      // Split shifts must not overlap — the engine would merge them into nonsense.
      const sorted = [...windows].sort((a, b) => a.start.localeCompare(b.start));
      for (let i = 1; i < sorted.length; i++) {
        if (sorted[i].start < sorted[i - 1].end) e.push(`${label}: time ranges overlap.`);
      }
    };
    // Weekly-hours validity only matters when those hours gate bookings.
    if (availabilityMode === 'business_hours') {
      for (const { key, label } of DAYS) if (days[key].enabled) check(label, days[key].windows);
    }
    for (const o of overrides) if (o.date && !o.closed) check(`Override ${o.date}`, o.windows);
    // A backwards range used to be dropped on the way out and saved as a ONE-DAY row under a
    // success toast, so the rest of the intended closure stayed bookable and the pickers went
    // on showing the range the owner thought they had saved. The API has always rejected it;
    // silently repairing the payload is what stopped that rejection from being seen.
    for (const o of overrides) {
      if (o.date && o.endDate && o.endDate < o.date) {
        e.push(`Override ${o.date}: end date must be on or after the start date.`);
      }
    }
    // Sent in the same PUT as everything else, and the API parses the whole payload before
    // any write — so one bad character here rejected the entire scheduler save, and the toast
    // could only say "Validation failed" with nothing pointing at this box.
    if (venue.country && !/^[A-Za-z]{2}$/.test(venue.country)) {
      e.push('Venue address: country must be a 2-letter code, like BE.');
    }
    // Mirrors `travelSettingsSchema`: an integer 0-240. Past four hours the owner is describing
    // a different working day rather than a head start, and the API refuses it — this is the
    // difference between being told before the Save and after it.
    if (!Number.isInteger(travelBaseDepart) || travelBaseDepart < 0 || travelBaseDepart > 240) {
      e.push('Travel time: leaving early must be a whole number of minutes between 0 and 240.');
    }
    if (travelMaxTravelMin.trim() !== '') {
      const n = Number(travelMaxTravelMin);
      if (!Number.isInteger(n) || n < 0 || n > 120) {
        e.push('Travel time: maximum travel time must be a whole number between 0 and 120.');
      }
    }
    return [...new Set(e)];
  }, [days, overrides, availabilityMode, venue, travelMaxTravelMin, travelBaseDepart]);

  /**
   * The payload this form would send right now.
   *
   * Extracted from `handleSave` so "has the owner changed anything?" can be answered by
   * comparing it to what hydration loaded, rather than by threading a dirty flag through
   * fifteen setters — where the one that got forgotten would silently discard their work on an
   * Agent switch.
   */
  const buildPayload = (): UpdateSchedulerPayload => {
    const weeklyHours: WeeklyHours = {};
    for (const { key } of DAYS) {
      const row = days[key];
      if (row.enabled && row.windows.length) weeklyHours[key] = row.windows;
    }
    const dateOverrides = overrides.flatMap((o) => {
      if (!o.date) return [];
      // Only send an end date when it is a real, later day. An EQUAL one is just a one-day
      // override stated the long way; an earlier one can no longer reach here at all, because
      // `errors` now blocks the save instead of quietly rewriting what the owner asked for.
      const span = o.endDate && o.endDate > o.date ? { endDate: o.endDate } : {};
      return [o.closed ? { date: o.date, ...span, closed: true } : { date: o.date, ...span, windows: o.windows }];
    });
    return {
      provider: 'internal',
      availability: { availabilityMode, weeklyHours, dateOverrides, slotGranularityMin },
      // Always sent, including when empty — [] is how the owner clears their area.
      serviceArea,
      // Whole object every time: a null clears one rule, an omitted key would leave the
      // stored value untouched, and this editor shows all three.
      bookingRules: rules,
      // Same contract as the rules — always sent, so clearing a field really clears it.
      venueAddress: venue,
      // Sent whole rather than as a diff: the endpoint treats an absent key as "leave alone",
      // so a partial travel object would silently keep a stale switch on.
      travel: {
        enabled: travelEnabled,
        startFromBase: travelStartFromBase,
        baseDepartOffsetMin: travelBaseDepart,
        groupingPeriod: travelGroupingPeriod,
        // Empty means "no limit", which the API takes as null rather than 0 - zero is a value
        // an owner can type and it means the same thing, but blank is absence, not a number.
        maxTravelMin: travelMaxTravelMin.trim() === '' ? null : Number(travelMaxTravelMin),
      },
      bookingsPaused,
      // Sent whole every time, matching the venue and travel contract above: an omitted key
      // leaves the stored text alone, so clearing the box has to send an explicit null.
      confirmationEmail: {
        extraInfo: confirmationExtraInfo.trim() === '' ? null : confirmationExtraInfo,
      },
    };
  };

  const handleSave = () => update.mutate(buildPayload());

  return (
    <Card variant="glass">
      <CardHeader>
        <h2 className="text-lg font-semibold text-text-primary flex items-center gap-2">
          <CalendarClock className="w-5 h-5" />
          Appointment Booking
        </h2>
        <p className="text-sm text-text-secondary mt-1">
          Choose how the assistant books appointments.
        </p>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="py-6 text-sm text-text-muted">Loading…</div>
        ) : (
          <div className="space-y-5">
                <div className="space-y-4 border-t border-edge pt-4">
                  <p className="text-xs text-text-secondary">
                    One calendar per Agent. Connect Google or Outlook, not both.
                  </p>
                  <GoogleCalendarSection
                    status={googleStatus}
                    connect={connectGoogle}
                    disconnect={disconnectGoogle}
                    blockedBy={outlookStatus.data?.connected ? 'Outlook' : null}
                  />
                  <OutlookCalendarSection
                    status={outlookStatus}
                    connect={connectOutlook}
                    disconnect={disconnectOutlook}
                    blockedBy={googleStatus.data?.connected ? 'Google' : null}
                  />
                </div>

                {/* Services catalog (multi-service) */}
                <ServicesSection
                  botId={botId}
                  workLocation={workLocation}
                  onApplied={async () => {
                    // Re-hydrate the availability form from the POST-apply config: refetch
                    // FIRST, then flip `hydrated` so the hydrate effect sees fresh data
                    // (flipping before the refetch resolves would re-hydrate the stale cache).
                    await refetch();
                    setHydrated(false);
                  }}
                />

                {/* Availability (shared across all services) */}
                <AvailabilitySection
                  config={data}
                  availabilityMode={availabilityMode}
                  setAvailabilityMode={setAvailabilityMode}
                  slotGranularityMin={slotGranularityMin}
                  setSlotGranularityMin={setSlotGranularityMin}
                  days={days}
                  setDays={setDays}
                />

                {/* Booking rules — business-wide ceilings over every service */}
                <BookingRulesSection rules={rules} setRules={setRules} />

                {/* What every customer confirmation email carries, on top of the booking itself */}
                <ConfirmationEmailSection
                  extraInfo={confirmationExtraInfo}
                  setExtraInfo={setConfirmationExtraInfo}
                  attachments={data?.confirmationEmail?.attachments ?? []}
                  botId={botId}
                />

                {/*
                  WHICH Agent this edits. Shown only when the tenant has more than one, so a
                  solo business is not handed a distinction it does not have — but shown
                  plainly when they do, because the settings endpoint writes the DEFAULT
                  Agent's row and nothing else (#86). Without this an owner of two Agents
                  edits one and believes they edited both. The sentence comes out when #86
                  lands and every Agent becomes editable.
                */}
                {/*
                  WHICH AGENT. Replaces #67's "you can only edit the default one" notice, which
                  was a disclaimer about a limitation this ticket removes.
                  Rendered only for a tenant that HAS more than one Agent — a solo business is
                  not handed a choice it does not have, which is also what keeps their screen
                  byte-identical.
                */}
                {multiAgent && (
                  <div className="space-y-1 rounded-md bg-surface-muted px-3 py-2">
                    <Label htmlFor="settings-agent">Agent</Label>
                    <select
                      id="settings-agent"
                      className="w-full rounded-md border border-edge bg-surface-1 px-2 py-1.5 text-sm text-text-primary"
                      value={botId ?? ''}
                      onChange={(e) => switchAgent(e.target.value || undefined)}
                    >
                      {agents.map((a) => (
                        <option key={a.id} value={a.isDefault ? '' : a.id}>
                          {a.name}
                          {a.isDefault ? ' (default)' : ''}
                        </option>
                      ))}
                    </select>
                    <p className="text-xs text-text-secondary">
                      Opening hours, services, capacity, your address and the calendar below all
                      belong to this Agent.
                    </p>
                  </div>
                )}

                <ServiceAreaBlock
                  config={data}
                  serviceArea={serviceArea}
                  setServiceArea={setServiceArea}
                />

                {/*
                  Pause. Deliberately at the TOP of this card: it is the thing an owner
                  reaches for in a hurry, and the alternatives were deleting their weekly
                  hours or pausing the whole bot (which also silences every non-booking
                  question the assistant answers).
                */}
                <div className="space-y-2 border-t border-edge pt-4">
                  <label htmlFor="bookings-paused" className="flex items-start gap-2 cursor-pointer">
                    <Checkbox
                      id="bookings-paused"
                      checked={bookingsPaused}
                      onCheckedChange={(c) => setBookingsPaused(c === true)}
                    />
                    <span className="text-sm text-text-secondary">
                      Pause new online bookings
                      <span className="block text-xs text-text-muted">
                        The assistant stops confirming appointments and instead takes down what the
                        customer wants, for you to confirm. It never tells them you are closed or
                        fully booked, and it keeps answering everything else. Your existing
                        appointments are untouched.
                      </span>
                    </span>
                  </label>
                </div>

                <VenueSection
                  config={data}
                  workLocation={workLocation}
                  venue={venue}
                  setVenue={setVenue}
                  reviewingVenue={reviewingVenue}
                  setReviewingVenue={setReviewingVenue}
                />

                <TravelSection
                  config={data}
                  workLocation={workLocation}
                  travelEnabled={travelEnabled}
                  setTravelEnabled={setTravelEnabled}
                  travelStartFromBase={travelStartFromBase}
                  setTravelStartFromBase={setTravelStartFromBase}
                  travelBaseDepart={travelBaseDepart}
                  setTravelBaseDepart={setTravelBaseDepart}
                  travelGroupingPeriod={travelGroupingPeriod}
                  setTravelGroupingPeriod={setTravelGroupingPeriod}
                  travelMaxTravelMin={travelMaxTravelMin}
                  setTravelMaxTravelMin={setTravelMaxTravelMin}
                />

                {/* Date overrides — holidays / closures / one-off hours */}
                <DateOverridesSection overrides={overrides} setOverrides={setOverrides} timezone={data?.availability?.timezone} />

                {/* Live slot preview (reflects the last SAVED config) */}
                <PreviewSection
                  config={data}
                  showPreview={showPreview}
                  setShowPreview={setShowPreview}
                />

            {errors.length > 0 && (
              <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3">
                <div className="flex items-center gap-2 text-sm font-medium text-amber-400">
                  <AlertTriangle className="w-4 h-4" /> Fix before saving
                </div>
                <ul className="mt-1 list-disc pl-5 text-xs text-amber-300/90 space-y-0.5">
                  {errors.map((e) => (
                    <li key={e}>{e}</li>
                  ))}
                </ul>
              </div>
            )}

            <div className="flex justify-end">
              <Button onClick={handleSave} disabled={update.isPending || errors.length > 0}>
                {update.isPending ? (
                  <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white" />
                ) : (
                  <Save className="w-4 h-4" />
                )}
                Save
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
};


/** What a calendar row reads off a connection status query and its two mutations.
 *  Both providers report the same three facts; only the copy around them differs,
 *  which is why the two rows stay separate. */
interface CalendarSectionProps {
  status: { data?: { connected: boolean; accountEmail: string | null; needsReauth?: boolean; supportsOnlineMeetings?: boolean } };
  connect: { mutate: () => void; isPending: boolean };
  disconnect: { mutate: () => void; isPending: boolean };
  /** Other provider already active. Connect is off until they disconnect that one. */
  blockedBy: string | null;
}

function CalendarIdleConnect({
  hint,
  blockedBy,
  buttonLabel,
  connect,
}: {
  hint: string;
  blockedBy: string | null;
  buttonLabel: string;
  connect: { mutate: () => void; isPending: boolean };
}) {
  const blocked = Boolean(blockedBy);
  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
      <span className="text-sm text-text-muted">
        {blocked
          ? `This Agent already uses ${blockedBy}. Disconnect ${blockedBy} first. One calendar per Agent.`
          : hint}
      </span>
      <Button
        variant="outline"
        size="sm"
        onClick={() => connect.mutate()}
        disabled={blocked || connect.isPending}
      >
        {connect.isPending && !blocked ? (
          <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-text-secondary" />
        ) : null}
        {buttonLabel}
      </Button>
    </div>
  );
}

/** Google Calendar connect / reconnect / disconnect row. Verbatim JSX, lifted out
 *  of SchedulerSettings so each section stays readable. */
const GoogleCalendarSection: React.FC<CalendarSectionProps> = ({ status, connect, disconnect, blockedBy }) => (
  <div className="space-y-2">
    <h3 className="text-sm font-medium text-text-primary">Google Calendar</h3>
    {status.data?.connected && status.data?.needsReauth ? (
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <span className="text-sm text-status-busy flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 shrink-0" />
          Reconnect needed{status.data.accountEmail ? ` · ${status.data.accountEmail}` : ''} — the link to Google has expired, so the bot can't read your availability and will fall back to capturing requests. Reconnect to restore booking.
        </span>
        <Button
          variant="outline"
          size="sm"
          onClick={() => connect.mutate()}
          disabled={connect.isPending}
        >
          {connect.isPending ? (
            <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-text-secondary" />
          ) : null}
          Reconnect
        </Button>
      </div>
    ) : status.data?.connected ? (
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <span className="text-sm text-text-secondary flex items-center gap-2">
          <Check className="w-4 h-4 text-status-online" />
          Connected{status.data.accountEmail ? ` · ${status.data.accountEmail}` : ''} — bookings sync to your calendar and the bot won't double-book over your events.
        </span>
        <Button
          variant="outline"
          size="sm"
          onClick={() => disconnect.mutate()}
          disabled={disconnect.isPending}
        >
          Disconnect
        </Button>
      </div>
    ) : (
      <CalendarIdleConnect
        hint="Optional: connect Google so bookings land on your calendar with a Meet link and respect your existing events."
        blockedBy={blockedBy}
        buttonLabel="Connect Google Calendar"
        connect={connect}
      />
    )}
  </div>
);

/** Outlook Calendar connect / reconnect / disconnect row. */
const OutlookCalendarSection: React.FC<CalendarSectionProps> = ({ status, connect, disconnect, blockedBy }) => (
  <div className="space-y-2 border-t border-edge pt-4">
    <h3 className="text-sm font-medium text-text-primary">Outlook Calendar</h3>
    {status.data?.connected && status.data?.needsReauth ? (
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <span className="text-sm text-status-busy flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 shrink-0" />
          Reconnect needed{status.data.accountEmail ? ` · ${status.data.accountEmail}` : ''} — the link to Outlook has expired, so the bot can't read your availability and will fall back to capturing requests. Reconnect to restore booking.
        </span>
        <Button
          variant="outline"
          size="sm"
          onClick={() => connect.mutate()}
          disabled={connect.isPending}
        >
          {connect.isPending ? (
            <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-text-secondary" />
          ) : null}
          Reconnect
        </Button>
      </div>
    ) : status.data?.connected ? (
      <>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <span className="text-sm text-text-secondary flex items-center gap-2">
            <Check className="w-4 h-4 text-status-online" />
            Connected{status.data.accountEmail ? ` · ${status.data.accountEmail}` : ''} — bookings sync to your calendar and the bot won't double-book over your events.
          </span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => disconnect.mutate()}
            disabled={disconnect.isPending}
          >
            Disconnect
          </Button>
        </div>
        {status.data?.supportsOnlineMeetings === false ? (
          <span className="text-sm text-status-busy flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 shrink-0" />
            This is a personal Microsoft account, which can't host Teams meetings — video bookings won't get a join link. Reconnect a work or school account to enable video links.
          </span>
        ) : null}
      </>
    ) : (
      <CalendarIdleConnect
        hint="Optional: connect Outlook so bookings land on your calendar and respect your existing events."
        blockedBy={blockedBy}
        buttonLabel="Connect Outlook Calendar"
        connect={connect}
      />
    )}
  </div>
);

/** Availability mode, slot interval and the weekly-hours grid. */
const AvailabilitySection: React.FC<{
  config: SchedulerConfig | undefined;
  availabilityMode: SchedulerFormState['availabilityMode'];
  setAvailabilityMode: FormSetter<'availabilityMode'>;
  slotGranularityMin: number;
  setSlotGranularityMin: FormSetter<'slotGranularityMin'>;
  days: SchedulerFormState['days'];
  setDays: FormSetter<'days'>;
}> = ({
  config,
  availabilityMode,
  setAvailabilityMode,
  slotGranularityMin,
  setSlotGranularityMin,
  days,
  setDays,
}) => {
  const setDay = (key: Weekday, patch: Partial<DayRow>) =>
    setDays((prev) => ({ ...prev, [key]: { ...prev[key], ...patch } }));
  return (
    <div className="space-y-3 border-t border-edge pt-4">
      <h3 className="text-sm font-medium text-text-primary">Availability</h3>
      <p className="text-xs text-text-muted">
        These hours gate bookable slots. They are managed from your AI bot's business hours; changes here may
        be overwritten the next time those hours are saved. They never stop the assistant from helping
        customers or capturing an out-of-hours request.
      </p>
      {/* Always-open vs business-hours mode */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        {([
          { mode: 'business_hours' as const, title: 'Set business hours', desc: 'The assistant offers slots only within the weekly hours below.' },
          { mode: 'always_open' as const, title: 'Always open (24/7)', desc: "Bookable around the clock — only your calendar's busy times limit slots." },
        ]).map(({ mode, title, desc }) => (
          <button
            key={mode}
            type="button"
            onClick={() => setAvailabilityMode(mode)}
            className={cn(
              'rounded-lg border p-3 text-left transition-colors',
              availabilityMode === mode
                ? 'border-primary-400 bg-primary-400/10'
                : 'border-edge hover:border-text-muted',
            )}
          >
            <div className="flex items-center gap-2 text-sm font-medium text-text-primary">
              <span
                className={cn(
                  'flex h-4 w-4 items-center justify-center rounded-full border',
                  availabilityMode === mode ? 'border-primary-400' : 'border-text-muted',
                )}
              >
                {availabilityMode === mode && <span className="h-2 w-2 rounded-full bg-primary-400" />}
              </span>
              {title}
            </div>
            <p className="mt-1 pl-6 text-xs text-text-muted">{desc}</p>
          </button>
        ))}
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <span className="mb-1 block text-sm text-text-secondary">Timezone</span>
          <span className="text-sm text-text-primary">
            {config?.availability?.timezone ?? '—'}
          </span>
        </div>
        <NumberField label="Slot interval (min)" value={slotGranularityMin} onChange={setSlotGranularityMin} min={5} />
      </div>
      {availabilityMode === 'business_hours' ? (
        <div className="space-y-2">
          <Label className="text-text-secondary block">Weekly hours</Label>
          {DAYS.map(({ key, label }) => (
            <div key={key} className="flex items-start gap-3">
              <label className="flex items-center gap-2 w-24 shrink-0 cursor-pointer pt-2">
                <Checkbox
                  checked={days[key].enabled}
                  onCheckedChange={(c) => setDay(key, { enabled: c === true })}
                />
                <span className="text-sm text-text-primary">{label}</span>
              </label>
              <WindowList
                windows={days[key].windows}
                disabled={!days[key].enabled}
                timezone={config?.availability?.timezone}
                onChange={(windows) => setDay(key, { windows })}
              />
            </div>
          ))}
        </div>
      ) : (
        <p className="rounded-lg border border-edge bg-surface-1/40 px-3 py-2 text-xs text-text-muted">
          Open 24/7 — the assistant can offer any time, limited only by your connected calendar's busy
          periods and each service's notice/buffer settings. Use date overrides below to close specific days.
        </p>
      )}
    </div>
  );
};

/** Business-wide ceilings and the per-service defaults. */
const BookingRulesSection: React.FC<{
  rules: SchedulerFormState['rules'];
  setRules: FormSetter<'rules'>;
}> = ({ rules, setRules }) => (
  <div className="space-y-3 border-t border-edge pt-4">
    <h3 className="text-sm font-medium text-text-primary">Booking rules</h3>
    <p className="text-xs text-text-muted">
      Limits for this bot as a whole, on top of each service's own settings — whichever is stricter wins.
      Leave a field empty for no limit.
    </p>
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
      <OptionalNumberField
        label="Max appointments per day"
        hint="Across all services"
        value={rules.maxBookingsPerDay}
        min={1}
        max={100}
        onChange={(v) => setRules((r) => ({ ...r, maxBookingsPerDay: v }))}
      />
      <OptionalNumberField
        label="Max booked hours per day"
        hint="Total time, not slots"
        value={rules.maxBookedMinutesPerDay === null ? null : rules.maxBookedMinutesPerDay / 60}
        min={0.25}
        max={24}
        step={0.25}
        onChange={(v) =>
          setRules((r) => ({ ...r, maxBookedMinutesPerDay: v === null ? null : Math.round(v * 60) }))
        }
      />
      <OptionalNumberField
        label="Minimum gap (min)"
        hint="Free time around each appointment. With travel time on, it is added on top of every drive."
        value={rules.minGapMin}
        min={0}
        max={480}
        onChange={(v) => setRules((r) => ({ ...r, minGapMin: v }))}
      />
    </div>

    <p className="pt-2 text-xs text-text-muted">
      Defaults for new services. A service that sets its own value keeps it — these
      only fill the fields a service leaves blank, so you can change your notice
      period or buffers once instead of on every service.
    </p>
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      <OptionalNumberField
        label="Min notice (min)"
        value={rules.defaultMinNoticeMin}
        min={0}
        max={43200}
        onChange={(v) => setRules((r) => ({ ...r, defaultMinNoticeMin: v }))}
      />
      <OptionalNumberField
        label="Max horizon (days)"
        value={rules.defaultMaxHorizonDays}
        min={1}
        max={365}
        onChange={(v) => setRules((r) => ({ ...r, defaultMaxHorizonDays: v }))}
      />
      <OptionalNumberField
        label="Buffer before (min)"
        value={rules.defaultBufferBeforeMin}
        min={0}
        max={480}
        onChange={(v) => setRules((r) => ({ ...r, defaultBufferBeforeMin: v }))}
      />
      <OptionalNumberField
        label="Buffer after (min)"
        value={rules.defaultBufferAfterMin}
        min={0}
        max={480}
        onChange={(v) => setRules((r) => ({ ...r, defaultBufferAfterMin: v }))}
      />
    </div>
  </div>
);


/** What the file picker offers. The API re-checks the real bytes, which is the check that holds. */
const ATTACHMENT_ACCEPT = '.pdf,.png,.jpg,.jpeg,.webp,.doc,.docx';

const formatAttachmentSize = (bytes: number): string =>
  bytes >= 1024 * 1024
    ? `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`;

/**
 * Extras carried by EVERY customer confirmation email for this Agent.
 *
 * The text rides the normal Save, because it is a settings field. The files do not: they go
 * straight to their own multipart endpoints and land immediately, because an owner who picks
 * a file expects it uploaded, not queued behind a form they might never submit.
 */
const ConfirmationEmailSection: React.FC<{
  extraInfo: string;
  setExtraInfo: FormSetter<'confirmationExtraInfo'>;
  attachments: ConfirmationAttachment[];
  botId: string | undefined;
}> = ({ extraInfo, setExtraInfo, attachments, botId }) => {
  const uploadAttachment = useUploadConfirmationAttachment(botId);
  const deleteAttachment = useDeleteConfirmationAttachment(botId);
  const fileInput = useRef<HTMLInputElement | null>(null);

  return (
    <div className="space-y-3 border-t border-edge pt-4">
      <h3 className="text-sm font-medium text-text-primary">Booking confirmation email</h3>
      <p className="text-xs text-text-muted">
        Added to every confirmation email this Agent sends. The headings follow the customer's own
        language; your own text goes exactly as you write it.
      </p>

      <div className="space-y-1">
        <Label htmlFor="confirmation-extra-info">Extra information</Label>
        <textarea
          id="confirmation-extra-info"
          className="min-h-[96px] w-full rounded-md border border-edge bg-surface-1 px-2 py-1.5 text-sm text-text-primary"
          maxLength={2000}
          value={extraInfo}
          onChange={(e) => setExtraInfo(e.target.value)}
          placeholder={
            'Please arrive 10 minutes early.\nParking is behind the building.\nTell us at least 24 hours before if you need to change the appointment.'
          }
        />
        <p className="text-xs text-text-muted">
          Up to 2000 characters. Line breaks are kept. This text is never rewritten or translated.
        </p>
      </div>

      <div className="space-y-2">
        <Label>Attachments</Label>
        {attachments.length === 0 && <p className="text-xs text-text-muted">No files attached yet.</p>}
        {attachments.map((a) => (
          <div
            key={a.id}
            className="flex items-center justify-between gap-2 rounded-md bg-surface-muted px-3 py-2"
          >
            <span className="truncate text-sm text-text-primary">{a.fileName}</span>
            <div className="flex shrink-0 items-center gap-2">
              <span className="text-xs text-text-muted">{formatAttachmentSize(a.fileSize)}</span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-label={`Remove ${a.fileName}`}
                disabled={deleteAttachment.isPending}
                onClick={() => deleteAttachment.mutate(a.id)}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          </div>
        ))}
        <input
          ref={fileInput}
          type="file"
          className="hidden"
          accept={ATTACHMENT_ACCEPT}
          onChange={(e) => {
            const file = e.target.files?.[0];
            // Cleared before the request so picking the SAME file twice still fires a change.
            e.target.value = '';
            if (file) uploadAttachment.mutate(file);
          }}
        />
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={uploadAttachment.isPending}
          onClick={() => fileInput.current?.click()}
        >
          <Plus className="mr-1 h-4 w-4" />
          Add attachment
        </Button>
        <p className="text-xs text-text-muted">
          PDF, Word or image files. Each file is uploaded straight away - you do not have to save.
        </p>
      </div>
    </div>
  );
};

/** Service area — where the business will travel. Hidden only when it is both
 *  inapplicable AND empty; a stored area always stays visible, with the field's
 *  own note explaining that nothing is being enforced against it. */
const ServiceAreaBlock: React.FC<{
  config: SchedulerConfig | undefined;
  serviceArea: SchedulerFormState['serviceArea'];
  setServiceArea: FormSetter<'serviceArea'>;
}> = ({ config, serviceArea, setServiceArea }) => {
  const hasAddressService = (config?.services ?? []).some((svc) => svc.isActive && svc.customerAddressRequired);
  if (!hasAddressService && serviceArea.length === 0) return null;
  return (
    <ServiceAreaField
      value={serviceArea}
      onChange={setServiceArea}
      // The area is only enforceable against services that collect an address.
      hasAddressService={hasAddressService}
    />
  );
};

/** Which of the two roles this address plays, in the owner's own terms (#79, LP1).
 *  The copy used to end "It is not used for jobs where you travel to the customer",
 *  which is exactly what Home Base needs it to be. One address, two roles — where
 *  customers come TO, and where the van sets out FROM — so what it says depends on
 *  which roles are actually in play. Derived from the catalog rather than asked as a
 *  second question: the services already say which kinds of work exist. */
const VenueRoleCopy: React.FC<{ workLocation: WorkLocation }> = ({ workLocation }) => {
  if (workLocation === 'on_the_road') {
    return (
      <>
        Where your working day starts. Travel time measures the first job of a day
        from here, so an early job an hour away is not offered against a start you
        could not make — leave it empty and the day's first job is not measured
        from anywhere.
      </>
    );
  }
  if (workLocation === 'both') {
    return (
      <>
        Two jobs for one address: customers come here for the services you do on
        site, and it is where your working day starts for the ones you travel to.
        It goes on the calendar invite for the first kind — leave it empty and the
        invite simply won't mention a place.
      </>
    );
  }
  if (workLocation === 'no_location') {
    return (
      <>
        None of your services happen anywhere in particular, so nothing here is
        used. It is still shown because you have an address stored — clear the
        fields if you would rather it went away.
      </>
    );
  }
  return (
    <>
      Where customers come to you. This goes on the calendar invite so they can
      find you — leave it empty and the invite simply won't mention a place.
    </>
  );
};

/** The four editable address lines plus the Google picker. */
const VenueAddressFields: React.FC<{
  venue: VenueAddress;
  setVenue: FormSetter<'venue'>;
}> = ({ venue, setVenue }) => {
  /**
   * Any hand-edit invalidates a selection, so every field goes through here rather than calling
   * `setVenue` directly. Four call sites each remembering to null the id is three chances to
   * forget, and forgetting means the base routes from an address the owner has replaced.
   */
  const editVenue = (patch: Partial<VenueAddress>) =>
    setVenue((v) => ({ ...v, ...patch, placeId: null }));
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
      <AddressAutocomplete
        onSelect={(picked) =>
          // Straight to `setVenue`, deliberately NOT `editVenue`: this is the one
          // change that CREATES the identity rather than invalidating it.
          setVenue({
            placeId: picked.placeId,
            street: picked.components?.street ?? null,
            postalCode: picked.components?.postalCode ?? null,
            city: picked.components?.city ?? null,
            country: picked.components?.country ?? null,
          })
        }
      />
      <div className="sm:col-span-2">
        <Label htmlFor="venue-street">Street and number</Label>
        <Input
          id="venue-street"
          value={venue.street ?? ''}
          maxLength={200}
          placeholder="Grote Markt 1"
          onChange={(e) => editVenue({ street: e.target.value || null })}
        />
      </div>
      <div>
        <Label htmlFor="venue-postal-code">Postcode</Label>
        <Input
          id="venue-postal-code"
          value={venue.postalCode ?? ''}
          maxLength={200}
          placeholder="9300"
          onChange={(e) => editVenue({ postalCode: e.target.value || null })}
        />
      </div>
      <div>
        <Label htmlFor="venue-city">City</Label>
        <Input
          id="venue-city"
          value={venue.city ?? ''}
          maxLength={200}
          placeholder="Aalst"
          onChange={(e) => editVenue({ city: e.target.value || null })}
        />
      </div>
      <div>
        <Label htmlFor="venue-country">Country code</Label>
        <Input
          id="venue-country"
          value={venue.country ?? ''}
          maxLength={2}
          placeholder="BE"
          onChange={(e) => editVenue({ country: e.target.value.toUpperCase() || null })}
        />
      </div>
    </div>
  );
};

/**
 * Services nobody was ever asked about, on a business that HAS an address (#71).
 *
 * `unset` resolves to the premises, so those services put this address on their invites. That
 * was the right default - between two wrong invites, an address the owner can remove beats a
 * customer who does not know where to go - but it is only right until the owner has an address
 * and one of those services turns out to be a phone or video call.
 *
 * Named, not counted - "2 services" sends the owner hunting, and the whole point is that they
 * can settle it in the time it takes to read this.
 */
const NeverAskedWarning: React.FC<{ names: string[] }> = ({ names }) => {
  const one = names.length === 1;
  return (
    <p className="flex gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-text-secondary">
      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-400" />
      <span>
        This address is going on the invite for{' '}
        {names.join(', ')} — {one ? 'that service was' : 'those services were'}{' '}
        created before we asked where each one happens, so nobody has chosen. If{' '}
        {one ? 'it is' : 'any of them are'} a phone or video
        call, open {one ? 'it' : 'them'} above and pick the
        right answer.
      </span>
    </p>
  );
};

/**
 * Venue — where customers come TO, and where the van sets out FROM. Never the
 * VAT/legal address.
 *
 * Show a location control only where it applies - and NEVER hide one that holds something
 * (#79, LP1).
 *
 * The rule is "hide only when there is nothing stored to hide", and the second half is the
 * load-bearing one. This form sends `venueAddress` and `serviceArea` on every save, by design:
 * `[]` is how an owner clears their area and a null field is how they clear an address line. So
 * a control hidden while its value was non-empty would still round-trip that value today, and
 * would silently delete it the first time anyone made hiding also reset the state. Refusing to
 * hide a populated control means that mistake has nowhere to land.
 *
 * An empty control on a business the setting cannot apply to is just a question nobody needs to
 * answer.
 */
const VenueSection: React.FC<{
  config: SchedulerConfig | undefined;
  workLocation: WorkLocation;
  venue: VenueAddress;
  setVenue: FormSetter<'venue'>;
  reviewingVenue: boolean;
  setReviewingVenue: FormSetter<'reviewingVenue'>;
}> = ({ config, workLocation, venue, setVenue, reviewingVenue, setReviewingVenue }) => {
  const hasStoredVenue = Object.values(venue ?? {}).some((v) => typeof v === 'string' && v.trim());
  if (workLocation === 'no_location' && !hasStoredVenue) return null;
  const storedVenueSummary = [venue.street, venue.postalCode, venue.city, venue.country]
    .filter((part): part is string => typeof part === 'string' && part.trim().length > 0)
    .map((part) => part.trim())
    .join(', ') || 'Saved address';
  const neverAsked = (config?.services ?? []).filter((s) => s.isActive && s.locationType === 'unset');
  const collapsed = workLocation === 'no_location' && !reviewingVenue;
  return (
    <div className="space-y-3 border-t border-edge pt-4">
      {collapsed ? (
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="text-sm font-medium text-text-primary">Your address</h3>
            <p className="mt-1 truncate text-xs text-text-secondary" title={storedVenueSummary}>
              {storedVenueSummary}
            </p>
          </div>
          <div className="flex shrink-0 gap-2">
            <Button
              variant="outline"
              size="sm"
              type="button"
              onClick={() => setReviewingVenue(true)}
            >
              Review
            </Button>
            <Button
              variant="outline"
              size="sm"
              type="button"
              onClick={() =>
                setVenue({
                  street: null,
                  postalCode: null,
                  city: null,
                  country: null,
                  placeId: null,
                })
              }
            >
              Clear
            </Button>
          </div>
        </div>
      ) : (
        <>
          <div>
            <h3 className="text-sm font-medium text-text-primary">Your address</h3>
            <p className="text-xs text-text-secondary mt-1">
              <VenueRoleCopy workLocation={workLocation} />
            </p>
            {/* Never the VAT or registered address, and never backfilled from one. Said out
                loud rather than only enforced in the schema, because an owner filling this
                in has no way to know it is a separate field unless it says so. */}
            <p className="text-xs text-text-muted mt-1">
              This is yours to choose. It is not your registered or VAT address, and nothing
              fills it in from one.
            </p>
          </div>
          <VenueAddressFields venue={venue} setVenue={setVenue} />

          {hasStoredVenue && neverAsked.length > 0 && (
            <NeverAskedWarning names={neverAsked.map((s) => s.name)} />
          )}
        </>
      )}
    </div>
  );
};

/** Why the travel switch cannot be turned on, in the owner's own terms. */
function travelBlockedCopy(
  reason: 'no_maps_key' | 'not_entitled' | 'shared_itinerary',
  travelEnabled: boolean,
): string {
  if (reason === 'shared_itinerary') {
    return travelEnabled
      ? 'Another Agent now books into the same calendar, so travel time has stopped running. Their appointments would be read as one person’s day and times would be held back for journeys nobody makes. Give each Agent its own calendar, or switch this off.'
      : 'Another Agent books into the same calendar, so this cannot be switched on. Their appointments would be read as one person’s day and times would be held back for journeys nobody makes. Give each Agent its own calendar first.';
  }
  if (reason === 'not_entitled') return 'Travel time is not part of your current Tier.';
  return 'Travel time is not available on this platform yet.';
}

/**
 * Travel time. AFTER the address deliberately: the day's first job is measured
 * from it, so an owner who has not filled it in is looking at the field this
 * section depends on. C2: no-location services have no address-to-address journey,
 * so this preference has nothing to measure and is gated on workLocation alone.
 */
const TravelSection: React.FC<{
  config: SchedulerConfig | undefined;
  workLocation: WorkLocation;
  travelEnabled: boolean;
  setTravelEnabled: FormSetter<'travelEnabled'>;
  travelStartFromBase: boolean;
  setTravelStartFromBase: FormSetter<'travelStartFromBase'>;
  travelBaseDepart: number;
  setTravelBaseDepart: FormSetter<'travelBaseDepart'>;
  travelGroupingPeriod: SchedulerFormState['travelGroupingPeriod'];
  setTravelGroupingPeriod: FormSetter<'travelGroupingPeriod'>;
  travelMaxTravelMin: string;
  setTravelMaxTravelMin: FormSetter<'travelMaxTravelMin'>;
}> = ({
  config,
  workLocation,
  travelEnabled,
  setTravelEnabled,
  travelStartFromBase,
  setTravelStartFromBase,
  travelBaseDepart,
  setTravelBaseDepart,
  travelGroupingPeriod,
  setTravelGroupingPeriod,
  travelMaxTravelMin,
  setTravelMaxTravelMin,
}) => {
  if (workLocation === 'no_location') return null;
  /** Does this business go TO its customers? The only shape geographic grouping applies to. */
  const travelsToCustomers = workLocation === 'on_the_road' || workLocation === 'both';
  // NOT state — it is the server's answer to "may this be switched on", refreshed with the
  // config. Holding it in state would let a stale value keep the switch enabled after a
  // calendar change made it harmful.
  const travelBlockedReason = config?.travel?.blockedReason ?? null;
  return (
    <div className="space-y-3 border-t border-edge pt-4">
      <div>
        <h3 className="text-sm font-medium text-text-primary">Travel time</h3>
        <p className="text-xs text-text-secondary mt-1">
          For jobs at the customer's address, only offer times you can actually drive
          between. Times you could not reach are held back rather than confirmed and
          then rearranged.
        </p>
        {/*
          The single-driver assumption, stated before the switch rather than after it.
          A two-person business that turns this on gets slots stripped for journeys
          neither of them makes — the one configuration where the feature makes a
          business worse off than not having it.
        */}
        <p className="text-xs text-text-muted mt-1">
          This assumes <strong>one person on the road</strong>. If two of you take jobs
          from the same diary, leave it off.
        </p>
      </div>

      {travelBlockedReason && (
        <div className="rounded-md bg-amber-500/10 px-3 py-2 text-xs text-amber-400">
          {travelBlockedCopy(travelBlockedReason, travelEnabled)}
        </div>
      )}

      <label htmlFor="travel-enabled" className="flex items-start gap-2 cursor-pointer">
        <Checkbox
          id="travel-enabled"
          checked={travelEnabled}
          // Blocks turning it ON, never turning it OFF. A tenant whose diary became
          // shared months after enabling travel has it on and cannot fix that from
          // the calendar screen alone — disabling the box outright left them unable
          // to switch off the one thing making their settings unsaveable.
          disabled={!!travelBlockedReason && !travelEnabled}
          onCheckedChange={(c) => setTravelEnabled(c === true)}
        />
        <span className="text-sm text-text-secondary">
          Only offer times I can reach
          <span className="block text-xs text-text-muted">
            Uses the address the customer gives and the jobs either side of the time
            they want.
          </span>
        </span>
      </label>

      <label htmlFor="travel-start-from-base" className="flex items-start gap-2 cursor-pointer">
        <Checkbox
          id="travel-start-from-base"
          checked={travelStartFromBase}
          disabled={!travelEnabled}
          onCheckedChange={(c) => setTravelStartFromBase(c === true)}
        />
        <span className="text-sm text-text-secondary">
          I start the day from my own address
          <span className="block text-xs text-text-muted">
            The first job of each day is measured from the address above. Fill that
            address in, or this has nothing to measure from.
          </span>
        </span>
      </label>

      <div>
        <Label htmlFor="travel-grouping-period">Geographic grouping</Label>
        <select
          id="travel-grouping-period"
          className="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm disabled:opacity-50"
          value={travelGroupingPeriod}
          disabled={!travelEnabled || !travelsToCustomers}
          onChange={(e) =>
            setTravelGroupingPeriod(e.target.value as 'none' | 'half_day' | 'full_day')
          }
        >
          <option value="none">No grouping</option>
          <option value="half_day">Group by half day</option>
          <option value="full_day">Group by full day</option>
        </select>
        <p className="text-xs text-text-muted mt-1">
          Customers still see every time they could have had, in the same list. Only the
          order changes. The time that adds the least driving to the jobs already around it is offered first.
          Nothing about your other customers is ever mentioned.
          {!travelsToCustomers && travelGroupingPeriod !== 'none' && (
            <>
              {' '}
              Your setting is kept but does nothing right now, because none of your
              services send you to a customer. It starts working again if you add one.
            </>
          )}
        </p>
      </div>

      <div>
        <Label htmlFor="travel-max-travel">Maximum travel time between appointments (min)</Label>
        <Input
          id="travel-max-travel"
          type="number"
          min={0}
          max={120}
          value={travelMaxTravelMin}
          disabled={!travelEnabled}
          placeholder="No limit"
          onChange={(e) => setTravelMaxTravelMin(e.target.value)}
        />
        <p className="text-xs text-text-muted mt-1">
          The longest drive you accept between one appointment and the next, or from your
          address to the first one. Times that need a longer drive are not offered to
          customers. You can still pick them yourself from the calendar. Leave it empty
          for no limit.
        </p>
      </div>

      {travelStartFromBase && (
        <div className="pl-6">
          <Label htmlFor="travel-base-depart">Minutes I leave before opening</Label>
          <Input
            id="travel-base-depart"
            type="number"
            min={0}
            max={240}
            value={travelBaseDepart}
            disabled={!travelEnabled}
            onChange={(e) => setTravelBaseDepart(e.target.value === '' ? 0 : Number(e.target.value))}
          />
          <p className="text-xs text-text-muted mt-1">
            At 0 the van leaves exactly when you open, so a job at opening time is only
            bookable if it is next door. Put in how long before opening you actually set
            off and the first slot of the day comes back.
          </p>
        </div>
      )}
    </div>
  );
};

/** Date overrides — holidays, closures and one-off hours. */
const DateOverridesSection: React.FC<{
  overrides: SchedulerFormState['overrides'];
  setOverrides: FormSetter<'overrides'>;
  timezone?: string | null;
}> = ({ overrides, setOverrides, timezone }) => (
  <div className="space-y-3 border-t border-edge pt-4">
    <div className="flex items-center justify-between">
      <h3 className="text-sm font-medium text-text-primary">Date overrides</h3>
      <Button
        variant="outline"
        size="sm"
        type="button"
        onClick={() =>
          setOverrides((prev) => [...prev, { date: '', endDate: '', closed: true, windows: [{ ...DEFAULT_WINDOW }] }])
        }
      >
        <Plus className="w-3.5 h-3.5" /> Add
      </Button>
    </div>
    {overrides.length === 0 ? (
      <p className="text-xs text-text-muted">
        Close specific dates (holidays) or set one-off hours that override the weekly schedule.
      </p>
    ) : (
      <div className="space-y-2">
        {overrides.map((o, i) => (
          // react-doctor-disable-next-line react-doctor/no-array-index-as-key -- no-stable-id
          <div key={i} className="flex items-center gap-3 flex-wrap">
            <DatePicker
              value={o.date}
              onChange={(v) =>
                setOverrides((prev) => prev.map((x, j) => (j === i ? { ...x, date: v } : x)))
              }
              className="w-full sm:w-44"
            />
            {/*
              An optional end date, so a fortnight's holiday is ONE row.
              Without it an owner date-picked fourteen rows, and only the
              first eight upcoming closures ever reach the bot — so from day
              nine it went back to quoting the weekly hours.
            */}
            <span className="text-xs text-text-muted">to</span>
            <DatePicker
              value={o.endDate}
              onChange={(v) =>
                setOverrides((prev) => prev.map((x, j) => (j === i ? { ...x, endDate: v } : x)))
              }
              className="w-full sm:w-44"
            />
            <label htmlFor={`override-closed-${i}`} className="flex items-center gap-2 cursor-pointer">
              <Checkbox
                id={`override-closed-${i}`}
                checked={o.closed}
                onCheckedChange={(c) =>
                  setOverrides((prev) => prev.map((x, j) => (j === i ? { ...x, closed: c === true } : x)))
                }
              />
              <span className="text-sm text-text-secondary">Closed</span>
            </label>
            {!o.closed && (
              <WindowList
                windows={o.windows}
                timezone={timezone}
                onChange={(windows) =>
                  setOverrides((prev) => prev.map((x, j) => (j === i ? { ...x, windows } : x)))
                }
              />
            )}
            <Button
              variant="ghost"
              size="sm"
              type="button"
              className="text-red-400 hover:text-red-300"
              onClick={() => setOverrides((prev) => prev.filter((_, j) => j !== i))}
            >
              <Trash2 className="w-3.5 h-3.5" />
            </Button>
          </div>
        ))}
      </div>
    )}
  </div>
);

/** Live slot preview (reflects the last SAVED config). */
const PreviewSection: React.FC<{
  config: SchedulerConfig | undefined;
  showPreview: boolean;
  setShowPreview: FormSetter<'showPreview'>;
}> = ({ config, showPreview, setShowPreview }) => (
  <div className="space-y-2 border-t border-edge pt-4">
    <div className="flex items-center justify-between">
      <h3 className="text-sm font-medium text-text-primary">Preview</h3>
      <Button variant="outline" size="sm" type="button" onClick={() => setShowPreview((v) => !v)}>
        <Eye className="w-3.5 h-3.5" /> {showPreview ? 'Hide' : 'Show'} next 7 days
      </Button>
    </div>
    {showPreview && <SlotPreview timezone={config?.availability?.timezone ?? 'Europe/Brussels'} />}
  </div>
);
