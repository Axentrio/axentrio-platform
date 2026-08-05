/**
 * Internal scheduler settings — configure the in-house booking engine: Google
 * Calendar connection, the event type, and weekly availability. (Cal.com is
 * shelved; the built-in scheduler is the only provider.)
 */
import React, { useEffect, useMemo, useState } from 'react';
import { CalendarClock, Save, Check, Plus, Trash2, Eye, Loader2, AlertTriangle } from 'lucide-react';
import { toast } from 'sonner';
import { useQueryClient } from '@tanstack/react-query';
import { Card, CardHeader, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { DatePicker } from '@/components/ui/date-picker';
import { TimeSelect } from '@/components/ui/time-select';
import { cn } from '@/lib/utils';
import {
  useSchedulerConfig,
  useUpdateSchedulerConfig,
  useBookingAvailability,
  type WeeklyHours,
  type Weekday,
  type TimeWindow,
  type ServiceAreaEntry,
  type VenueAddress,
  type BookingRules,
  type AvailabilityMode,
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
import { ServicesSection } from './ServicesSection';
import { ServiceAreaField } from './ServiceAreaField';

const DAYS: { key: Weekday; label: string }[] = [
  { key: 'mon', label: 'Monday' },
  { key: 'tue', label: 'Tuesday' },
  { key: 'wed', label: 'Wednesday' },
  { key: 'thu', label: 'Thursday' },
  { key: 'fri', label: 'Friday' },
  { key: 'sat', label: 'Saturday' },
  { key: 'sun', label: 'Sunday' },
];

const TIMEZONES = [
  'Europe/Brussels',
  'Europe/Amsterdam',
  'Europe/Paris',
  'Europe/London',
  'Europe/Berlin',
  'UTC',
];

// Full IANA list where the browser supports it (modern Chromium/Safari/FF),
// falling back to the short curated list. Feeds a searchable <datalist>.
const ALL_TIMEZONES: string[] = (() => {
  try {
    const sv = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf;
    return typeof sv === 'function' ? sv('timeZone') : TIMEZONES;
  } catch {
    return TIMEZONES;
  }
})();

const DEFAULT_WINDOW: TimeWindow = { start: '09:00', end: '17:00' };

interface DayRow {
  enabled: boolean;
  /** One or more open windows. A lunch break is simply two of them. */
  windows: TimeWindow[];
}

type DayState = Record<Weekday, DayRow>;

/** A single date override row (holiday closure or one-off custom hours). */
interface OverrideRow {
  date: string;
  /** Inclusive last day of a multi-day closure. '' = a single day. */
  endDate: string;
  closed: boolean;
  windows: TimeWindow[];
}

function overridesFromConfig(raw: unknown[] | undefined): OverrideRow[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((o) => {
    const ov = o as { date?: string; endDate?: string | null; closed?: boolean; windows?: TimeWindow[] };
    const windows = Array.isArray(ov.windows) && ov.windows.length ? ov.windows : [{ ...DEFAULT_WINDOW }];
    return { date: ov.date ?? '', endDate: ov.endDate ?? '', closed: !!ov.closed, windows };
  });
}

function rowsFromWeeklyHours(weekly: WeeklyHours | undefined): DayState {
  const out = {} as DayState;
  for (const { key } of DAYS) {
    const wins = weekly?.[key];
    out[key] = wins?.length
      ? { enabled: true, windows: wins.map((w) => ({ ...w })) }
      : { enabled: false, windows: [{ ...DEFAULT_WINDOW }] };
  }
  return out;
}

/**
 * The open windows for one day (or one date override).
 *
 * The entity, the API and the slot engine have always stored an ARRAY. This editor used to
 * render `windows[0]` and write a single-element array back, so a lunch break — or any
 * second window seeded by a preset or written through the API — was silently destroyed the
 * next time the owner pressed Save. Editing the whole array is the fix.
 */
const WindowList: React.FC<{
  windows: TimeWindow[];
  disabled?: boolean;
  onChange: (next: TimeWindow[]) => void;
}> = ({ windows, disabled, onChange }) => (
  <div className="flex flex-col gap-1.5">
    {windows.map((w, i) => (
      // react-doctor-disable-next-line react-doctor/no-array-index-as-key -- no-stable-id
      <div key={i} className="flex items-center gap-2">
        <TimeSelect
          value={w.start}
          disabled={disabled}
          onChange={(v) => onChange(windows.map((x, j) => (j === i ? { ...x, start: v } : x)))}
        />
        <span className="text-text-muted">–</span>
        <TimeSelect
          value={w.end}
          disabled={disabled}
          onChange={(v) => onChange(windows.map((x, j) => (j === i ? { ...x, end: v } : x)))}
        />
        {windows.length > 1 && (
          <Button
            variant="ghost"
            size="sm"
            type="button"
            disabled={disabled}
            aria-label="Remove this time range"
            className="text-red-400 hover:text-red-300"
            onClick={() => onChange(windows.filter((_, j) => j !== i))}
          >
            <Trash2 className="w-3.5 h-3.5" />
          </Button>
        )}
        {i === windows.length - 1 && (
          <Button
            variant="ghost"
            size="sm"
            type="button"
            disabled={disabled}
            aria-label="Add another time range"
            onClick={() => onChange([...windows, { ...DEFAULT_WINDOW }])}
          >
            <Plus className="w-3.5 h-3.5" />
          </Button>
        )}
      </div>
    ))}
  </div>
);

export const SchedulerSettings: React.FC = () => {
  const { data, isLoading, refetch } = useSchedulerConfig();
  const update = useUpdateSchedulerConfig();
  const queryClient = useQueryClient();
  const googleStatus = useGoogleCalendarStatus();
  const connectGoogle = useConnectGoogleCalendar();
  const disconnectGoogle = useDisconnectGoogleCalendar();
  const outlookStatus = useOutlookCalendarStatus();
  const connectOutlook = useConnectOutlookCalendar();
  const disconnectOutlook = useDisconnectOutlookCalendar();

  // Toast + refresh after a calendar OAuth callback redirects back with
  // ?google=connected|error or ?outlook=connected|error.
  useEffect(() => {
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
        toast.error(`${label} connection failed`);
      }
      params.delete(key);
      changed = true;
    }
    if (!changed) return;
    const qs = params.toString();
    window.history.replaceState({}, '', window.location.pathname + (qs ? `?${qs}` : ''));
  }, [queryClient]);

  const [timezone, setTimezone] = useState('Europe/Brussels');
  const [availabilityMode, setAvailabilityMode] = useState<AvailabilityMode>('business_hours');
  const [slotGranularityMin, setSlotGranularityMin] = useState(30);
  const [days, setDays] = useState<DayState>(() => rowsFromWeeklyHours(undefined));
  const [overrides, setOverrides] = useState<OverrideRow[]>([]);
  const [serviceArea, setServiceArea] = useState<ServiceAreaEntry[]>([]);
  const [venue, setVenue] = useState<VenueAddress>({ street: null, postalCode: null, city: null, country: null });
  const [rules, setRules] = useState<BookingRules>({
    maxBookingsPerDay: null,
    maxBookedMinutesPerDay: null,
    minGapMin: null,
    defaultBufferBeforeMin: null,
    defaultBufferAfterMin: null,
    defaultMinNoticeMin: null,
    defaultMaxHorizonDays: null,
  });
  const [showPreview, setShowPreview] = useState(false);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    if (!data || hydrated) return;
    if (data.availability) {
      setTimezone(data.availability.timezone);
      setAvailabilityMode(data.availability.availabilityMode ?? 'business_hours');
      setSlotGranularityMin(data.availability.slotGranularityMin);
      setDays(rowsFromWeeklyHours(data.availability.weeklyHours));
      setOverrides(overridesFromConfig(data.availability.dateOverrides));
    }
    // Outside the availability branch: a bot can have a service area before it has hours.
    setServiceArea(Array.isArray(data.serviceArea) ? data.serviceArea : []);
    setVenue({
      street: data.venueAddress?.street ?? null,
      postalCode: data.venueAddress?.postalCode ?? null,
      city: data.venueAddress?.city ?? null,
      country: data.venueAddress?.country ?? null,
    });
    setRules({
      maxBookingsPerDay: data.bookingRules?.maxBookingsPerDay ?? null,
      maxBookedMinutesPerDay: data.bookingRules?.maxBookedMinutesPerDay ?? null,
      minGapMin: data.bookingRules?.minGapMin ?? null,
      defaultBufferBeforeMin: data.bookingRules?.defaultBufferBeforeMin ?? null,
      defaultBufferAfterMin: data.bookingRules?.defaultBufferAfterMin ?? null,
      defaultMinNoticeMin: data.bookingRules?.defaultMinNoticeMin ?? null,
      defaultMaxHorizonDays: data.bookingRules?.defaultMaxHorizonDays ?? null,
    });
    setHydrated(true);
  }, [data, hydrated]);

  const setDay = (key: Weekday, patch: Partial<DayRow>) =>
    setDays((prev) => ({ ...prev, [key]: { ...prev[key], ...patch } }));

  // Inline validation for the availability section (per-service rules live in
  // the service editor). Blocks an invalid availability save.
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
    return [...new Set(e)];
  }, [days, overrides, availabilityMode]);

  const handleSave = () => {
    const weeklyHours: WeeklyHours = {};
    for (const { key } of DAYS) {
      const row = days[key];
      if (row.enabled && row.windows.length) weeklyHours[key] = row.windows;
    }
    const dateOverrides = overrides.flatMap((o) => {
      if (!o.date) return [];
      // Only send an end date when it is a real, later day — an equal or earlier one is a
      // half-finished edit, and the API rejects it rather than guessing.
      const span = o.endDate && o.endDate > o.date ? { endDate: o.endDate } : {};
      return [o.closed ? { date: o.date, ...span, closed: true } : { date: o.date, ...span, windows: o.windows }];
    });
    update.mutate({
      provider: 'internal',
      availability: { timezone, availabilityMode, weeklyHours, dateOverrides, slotGranularityMin },
      // Always sent, including when empty — [] is how the owner clears their area.
      serviceArea,
      // Whole object every time: a null clears one rule, an omitted key would leave the
      // stored value untouched, and this editor shows all three.
      bookingRules: rules,
      // Same contract as the rules — always sent, so clearing a field really clears it.
      venueAddress: venue,
    });
  };

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
                {/* Google Calendar connection (Phase 1) */}
                <div className="space-y-2 border-t border-edge pt-4">
                  <h3 className="text-sm font-medium text-text-primary">Google Calendar</h3>
                  {googleStatus.data?.connected && googleStatus.data?.needsReauth ? (
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-sm text-status-busy flex items-center gap-2">
                        <AlertTriangle className="w-4 h-4 shrink-0" />
                        Reconnect needed{googleStatus.data.accountEmail ? ` · ${googleStatus.data.accountEmail}` : ''} — the link to Google has expired, so the bot can't read your availability and will fall back to capturing requests. Reconnect to restore booking.
                      </span>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => connectGoogle.mutate()}
                        disabled={connectGoogle.isPending}
                      >
                        {connectGoogle.isPending ? (
                          <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-text-secondary" />
                        ) : null}
                        Reconnect
                      </Button>
                    </div>
                  ) : googleStatus.data?.connected ? (
                    <div className="flex items-center justify-between">
                      <span className="text-sm text-text-secondary flex items-center gap-2">
                        <Check className="w-4 h-4 text-status-online" />
                        Connected{googleStatus.data.accountEmail ? ` · ${googleStatus.data.accountEmail}` : ''} — bookings sync to your calendar and the bot won't double-book over your events.
                      </span>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => disconnectGoogle.mutate()}
                        disabled={disconnectGoogle.isPending}
                      >
                        Disconnect
                      </Button>
                    </div>
                  ) : (
                    <div className="flex items-center justify-between">
                      <span className="text-sm text-text-muted">
                        Optional: connect Google so bookings land on your calendar with a Meet link and respect your existing events.
                      </span>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => connectGoogle.mutate()}
                        disabled={connectGoogle.isPending}
                      >
                        {connectGoogle.isPending ? (
                          <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-text-secondary" />
                        ) : null}
                        Connect Google Calendar
                      </Button>
                    </div>
                  )}
                </div>

                {/* Outlook Calendar connection (Phase 6b) */}
                <div className="space-y-2 border-t border-edge pt-4">
                  <h3 className="text-sm font-medium text-text-primary">Outlook Calendar</h3>
                  {outlookStatus.data?.connected && outlookStatus.data?.needsReauth ? (
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-sm text-status-busy flex items-center gap-2">
                        <AlertTriangle className="w-4 h-4 shrink-0" />
                        Reconnect needed{outlookStatus.data.accountEmail ? ` · ${outlookStatus.data.accountEmail}` : ''} — the link to Outlook has expired, so the bot can't read your availability and will fall back to capturing requests. Reconnect to restore booking.
                      </span>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => connectOutlook.mutate()}
                        disabled={connectOutlook.isPending}
                      >
                        {connectOutlook.isPending ? (
                          <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-text-secondary" />
                        ) : null}
                        Reconnect
                      </Button>
                    </div>
                  ) : outlookStatus.data?.connected ? (
                    <div className="flex items-center justify-between">
                      <span className="text-sm text-text-secondary flex items-center gap-2">
                        <Check className="w-4 h-4 text-status-online" />
                        Connected{outlookStatus.data.accountEmail ? ` · ${outlookStatus.data.accountEmail}` : ''} — bookings sync to your calendar and the bot won't double-book over your events.
                      </span>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => disconnectOutlook.mutate()}
                        disabled={disconnectOutlook.isPending}
                      >
                        Disconnect
                      </Button>
                    </div>
                  ) : (
                    <div className="flex items-center justify-between">
                      <span className="text-sm text-text-muted">
                        Optional: connect Outlook so bookings land on your calendar and respect your existing events.
                      </span>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => connectOutlook.mutate()}
                        disabled={connectOutlook.isPending}
                      >
                        {connectOutlook.isPending ? (
                          <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-text-secondary" />
                        ) : null}
                        Connect Outlook Calendar
                      </Button>
                    </div>
                  )}
                </div>

                {/* Services catalog (multi-service) */}
                <ServicesSection
                  onApplied={async () => {
                    // Re-hydrate the availability form from the POST-apply config: refetch
                    // FIRST, then flip `hydrated` so the hydrate effect sees fresh data
                    // (flipping before the refetch resolves would re-hydrate the stale cache).
                    await refetch();
                    setHydrated(false);
                  }}
                />

                {/* Availability (shared across all services) */}
                <div className="space-y-3 border-t border-edge pt-4">
                  <h3 className="text-sm font-medium text-text-primary">Availability</h3>
                  <p className="text-xs text-text-muted">
                    These hours tell the assistant when you're open and which times it can auto-confirm. They never stop
                    it from helping customers or capturing an out-of-hours request for you to confirm.
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
                      <Label className="text-text-secondary mb-1 block">Timezone</Label>
                      <Input
                        list="scheduler-timezones"
                        aria-label="Timezone"
                        value={timezone}
                        onChange={(e) => setTimezone(e.target.value)}
                        placeholder="Search timezone…"
                      />
                      <datalist id="scheduler-timezones">
                        {ALL_TIMEZONES.map((tz) => (
                          <option key={tz} value={tz}>{tz}</option>
                        ))}
                      </datalist>
                    </div>
                    <NumberField label="Slot interval (min)" value={slotGranularityMin} onChange={setSlotGranularityMin} min={5} />
                  </div>
                  {availabilityMode === 'business_hours' ? (
                    <div className="space-y-2">
                      <Label className="text-text-secondary block">Weekly hours</Label>
                      {DAYS.map(({ key, label }) => (
                        <div key={key} className="flex items-start gap-3">
                          <label className="flex items-center gap-2 w-32 shrink-0 cursor-pointer pt-2">
                            <Checkbox
                              checked={days[key].enabled}
                              onCheckedChange={(c) => setDay(key, { enabled: c === true })}
                            />
                            <span className="text-sm text-text-primary">{label}</span>
                          </label>
                          <WindowList
                            windows={days[key].windows}
                            disabled={!days[key].enabled}
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

                {/* Booking rules — business-wide ceilings over every service */}
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
                      hint="Free time around each appointment"
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

                {/* Service area — where the business will travel */}
                <ServiceAreaField
                  value={serviceArea}
                  onChange={setServiceArea}
                  // The area is only enforceable against services that collect an address.
                  hasAddressService={(data?.services ?? []).some(
                    (svc) => svc.isActive && svc.customerAddressRequired,
                  )}
                />

                {/* Venue — where customers come TO. Never the VAT/legal address. */}
                <div className="space-y-3 border-t border-edge pt-4">
                  <div>
                    <h3 className="text-sm font-medium text-text-primary">Your address</h3>
                    <p className="text-xs text-text-secondary mt-1">
                      Where customers come to you. This goes on the calendar invite so they can find
                      you — leave it empty and the invite simply won't mention a place. It is not used
                      for jobs where you travel to the customer; those use their address instead.
                    </p>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div className="sm:col-span-2">
                      <Label htmlFor="venue-street">Street and number</Label>
                      <Input
                        id="venue-street"
                        value={venue.street ?? ''}
                        maxLength={200}
                        placeholder="Grote Markt 1"
                        onChange={(e) => setVenue((v) => ({ ...v, street: e.target.value || null }))}
                      />
                    </div>
                    <div>
                      <Label htmlFor="venue-postal-code">Postcode</Label>
                      <Input
                        id="venue-postal-code"
                        value={venue.postalCode ?? ''}
                        maxLength={200}
                        placeholder="9300"
                        onChange={(e) => setVenue((v) => ({ ...v, postalCode: e.target.value || null }))}
                      />
                    </div>
                    <div>
                      <Label htmlFor="venue-city">City</Label>
                      <Input
                        id="venue-city"
                        value={venue.city ?? ''}
                        maxLength={200}
                        placeholder="Aalst"
                        onChange={(e) => setVenue((v) => ({ ...v, city: e.target.value || null }))}
                      />
                    </div>
                    <div>
                      <Label htmlFor="venue-country">Country code</Label>
                      <Input
                        id="venue-country"
                        value={venue.country ?? ''}
                        maxLength={2}
                        placeholder="BE"
                        onChange={(e) =>
                          setVenue((v) => ({ ...v, country: e.target.value.toUpperCase() || null }))
                        }
                      />
                    </div>
                  </div>
                </div>

                {/* Date overrides — holidays / closures / one-off hours */}
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
                            className="w-44"
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
                            className="w-44"
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

                {/* Live slot preview (reflects the last SAVED config) */}
                <div className="space-y-2 border-t border-edge pt-4">
                  <div className="flex items-center justify-between">
                    <h3 className="text-sm font-medium text-text-primary">Preview</h3>
                    <Button variant="outline" size="sm" type="button" onClick={() => setShowPreview((v) => !v)}>
                      <Eye className="w-3.5 h-3.5" /> {showPreview ? 'Hide' : 'Show'} next 7 days
                    </Button>
                  </div>
                  {showPreview && <SlotPreview timezone={timezone} />}
                </div>

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

/** Calls the availability endpoint for the next 7 days. Reflects SAVED config. */
const SlotPreview: React.FC<{ timezone: string }> = ({ timezone }) => {
  const range = useMemo(() => {
    const s = new Date();
    const e = new Date(s.getTime() + 7 * 24 * 3600_000);
    return { start: s.toISOString(), end: e.toISOString() };
  }, []);
  const { data, isLoading, isError } = useBookingAvailability(range.start, range.end, true);

  const grouped = useMemo(() => {
    const out = new Map<string, string[]>();
    for (const s of data?.slots ?? []) {
      const day = new Intl.DateTimeFormat('en-GB', {
        timeZone: data?.timezone ?? timezone,
        weekday: 'short',
        day: 'numeric',
        month: 'short',
      }).format(new Date(s.start));
      const time = new Intl.DateTimeFormat('en-GB', {
        timeZone: data?.timezone ?? timezone,
        hour: 'numeric',
        minute: '2-digit',
        hour12: true,
      }).format(new Date(s.start));
      if (!out.has(day)) out.set(day, []);
      out.get(day)!.push(time);
    }
    return Array.from(out.entries());
  }, [data, timezone]);

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-text-muted">
        <Loader2 className="w-4 h-4 animate-spin" /> Computing slots…
      </div>
    );
  }
  if (isError) {
    return <p className="text-xs text-text-muted">Save your settings first, then preview.</p>;
  }
  const total = data?.slots.length ?? 0;
  return (
    <div className="space-y-2">
      <p className="text-xs text-text-muted">
        {total} open slot{total === 1 ? '' : 's'} in the next 7 days · reflects saved settings · {data?.timezone ?? timezone}
      </p>
      {grouped.length === 0 ? (
        <p className="text-xs text-text-muted">No open slots in this window.</p>
      ) : (
        <div className="space-y-1.5">
          {grouped.map(([day, times]) => (
            <SlotPreviewDay key={day} day={day} times={times} />
          ))}
        </div>
      )}
    </div>
  );
};

/** One day's row in the preview: label + wrapping time chips, expandable. */
const SlotPreviewDay: React.FC<{ day: string; times: string[] }> = ({ day, times }) => {
  const [expanded, setExpanded] = useState(false);
  const LIMIT = 8;
  const shown = expanded ? times : times.slice(0, LIMIT);
  const hidden = times.length - shown.length;
  return (
    <div className="flex items-start gap-3 rounded-lg border border-edge bg-surface-1/40 px-3 py-2">
      <span className="w-24 shrink-0 pt-0.5 text-xs font-medium text-text-secondary">{day}</span>
      <div className="flex flex-wrap gap-1.5">
        {shown.map((t) => (
          <span
            key={t}
            className="rounded-md border border-edge bg-surface-2 px-2 py-0.5 text-xs tabular-nums text-text-primary"
          >
            {t}
          </span>
        ))}
        {hidden > 0 && (
          <button
            type="button"
            onClick={() => setExpanded(true)}
            className="rounded-md px-2 py-0.5 text-xs font-medium text-primary-400 hover:text-primary-300"
          >
            +{hidden} more
          </button>
        )}
        {expanded && times.length > LIMIT && (
          <button
            type="button"
            onClick={() => setExpanded(false)}
            className="rounded-md px-2 py-0.5 text-xs text-text-muted hover:text-text-secondary"
          >
            show less
          </button>
        )}
      </div>
    </div>
  );
};

/**
 * A number input that may be EMPTY, meaning "no limit".
 *
 * Holds the raw string so clearing the box doesn't snap back to a value mid-edit, and only
 * ever emits a finite number or null — the plain NumberField below does
 * `parseInt(e.target.value, 10)` unguarded, so clearing it yields NaN, which JSON.stringify
 * writes as null and the schema then rejects with what looks to the owner like a server error.
 */
const OptionalNumberField: React.FC<{
  label: string;
  hint?: string;
  value: number | null;
  min?: number;
  max?: number;
  step?: number;
  onChange: (v: number | null) => void;
}> = ({ label, hint, value, min, max, step, onChange }) => {
  const [draft, setDraft] = useState<string>(value === null ? '' : String(value));
  // Re-sync when the parent value changes from outside (hydration, preset apply).
  useEffect(() => setDraft(value === null ? '' : String(value)), [value]);
  return (
    <div>
      <Label className="text-text-secondary mb-1 block">{label}</Label>
      <Input
        type="number"
        inputMode="decimal"
        value={draft}
        min={min}
        max={max}
        step={step}
        placeholder="No limit"
        onChange={(e) => {
          const next = e.target.value;
          setDraft(next);
          if (next.trim() === '') return onChange(null);
          const n = Number(next);
          if (Number.isFinite(n)) onChange(n);
        }}
      />
      {hint && <p className="mt-1 text-xs text-text-muted">{hint}</p>}
    </div>
  );
};

const NumberField: React.FC<{
  label: string;
  value: number;
  onChange: (v: number) => void;
  min?: number;
}> = ({ label, value, onChange, min }) => (
  <div>
    <Label className="text-text-secondary mb-1 block">{label}</Label>
    <Input
      type="number"
      value={Number.isFinite(value) ? value : ''}
      min={min}
      onChange={(e) => onChange(parseInt(e.target.value, 10))}
      className={cn('w-full')}
    />
  </div>
);

