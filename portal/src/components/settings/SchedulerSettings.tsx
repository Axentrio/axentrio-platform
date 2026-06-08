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
} from '../../queries/useSchedulerQueries';
import {
  useGoogleCalendarStatus,
  useConnectGoogleCalendar,
  useDisconnectGoogleCalendar,
} from '../../queries/useGoogleCalendarQueries';
import { ServicesSection } from './ServicesSection';

const DAYS: { key: string; label: string }[] = [
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

interface DayRow {
  enabled: boolean;
  start: string;
  end: string;
}

type DayState = Record<string, DayRow>;

/** A single date override row (holiday closure or one-off custom hours). */
interface OverrideRow {
  date: string;
  closed: boolean;
  start: string;
  end: string;
}

function overridesFromConfig(raw: unknown[] | undefined): OverrideRow[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((o) => {
    const ov = o as { date?: string; closed?: boolean; windows?: { start: string; end: string }[] };
    return {
      date: ov.date ?? '',
      closed: !!ov.closed,
      start: ov.windows?.[0]?.start ?? '09:00',
      end: ov.windows?.[0]?.end ?? '17:00',
    };
  });
}

function rowsFromWeeklyHours(weekly: WeeklyHours | undefined): DayState {
  const out: DayState = {};
  for (const { key } of DAYS) {
    const win = weekly?.[key]?.[0];
    out[key] = win
      ? { enabled: true, start: win.start, end: win.end }
      : { enabled: false, start: '09:00', end: '17:00' };
  }
  return out;
}

export const SchedulerSettings: React.FC = () => {
  const { data, isLoading } = useSchedulerConfig();
  const update = useUpdateSchedulerConfig();
  const queryClient = useQueryClient();
  const googleStatus = useGoogleCalendarStatus();
  const connectGoogle = useConnectGoogleCalendar();
  const disconnectGoogle = useDisconnectGoogleCalendar();

  // Toast + refresh after the OAuth callback redirects back with ?google=...
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const g = params.get('google');
    if (!g) return;
    if (g === 'connected') {
      toast.success('Google Calendar connected');
      queryClient.invalidateQueries({ queryKey: ['google', 'status'] });
    } else if (g === 'error') {
      toast.error('Google Calendar connection failed');
    }
    params.delete('google');
    const qs = params.toString();
    window.history.replaceState({}, '', window.location.pathname + (qs ? `?${qs}` : ''));
  }, [queryClient]);

  const [timezone, setTimezone] = useState('Europe/Brussels');
  const [slotGranularityMin, setSlotGranularityMin] = useState(30);
  const [days, setDays] = useState<DayState>(() => rowsFromWeeklyHours(undefined));
  const [overrides, setOverrides] = useState<OverrideRow[]>([]);
  const [showPreview, setShowPreview] = useState(false);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    if (!data || hydrated) return;
    if (data.availability) {
      setTimezone(data.availability.timezone);
      setSlotGranularityMin(data.availability.slotGranularityMin);
      setDays(rowsFromWeeklyHours(data.availability.weeklyHours));
      setOverrides(overridesFromConfig(data.availability.dateOverrides));
    }
    setHydrated(true);
  }, [data, hydrated]);

  const setDay = (key: string, patch: Partial<DayRow>) =>
    setDays((prev) => ({ ...prev, [key]: { ...prev[key], ...patch } }));

  // Inline validation for the availability section (per-service rules live in
  // the service editor). Blocks an invalid availability save.
  const errors = useMemo<string[]>(() => {
    const e: string[] = [];
    for (const { key, label } of DAYS) {
      const r = days[key];
      if (r.enabled && r.start >= r.end) e.push(`${label}: end time must be after start time.`);
    }
    for (const o of overrides) {
      if (o.date && !o.closed && o.start >= o.end) e.push(`Override ${o.date}: end time must be after start time.`);
    }
    return e;
  }, [days, overrides]);

  const handleSave = () => {
    const weeklyHours: WeeklyHours = {};
    for (const { key } of DAYS) {
      const row = days[key];
      if (row.enabled) weeklyHours[key] = [{ start: row.start, end: row.end }];
    }
    const dateOverrides = overrides
      .filter((o) => o.date)
      .map((o) => (o.closed ? { date: o.date, closed: true } : { date: o.date, windows: [{ start: o.start, end: o.end }] }));
    update.mutate({
      provider: 'internal',
      availability: { timezone, weeklyHours, dateOverrides, slotGranularityMin },
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
                  {googleStatus.data?.connected ? (
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

                {/* Services catalog (multi-service) */}
                <ServicesSection />

                {/* Availability (shared across all services) */}
                <div className="space-y-3 border-t border-edge pt-4">
                  <h3 className="text-sm font-medium text-text-primary">Weekly availability</h3>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                      <Label className="text-text-secondary mb-1 block">Timezone</Label>
                      <Input
                        list="scheduler-timezones"
                        value={timezone}
                        onChange={(e) => setTimezone(e.target.value)}
                        placeholder="Search timezone…"
                      />
                      <datalist id="scheduler-timezones">
                        {ALL_TIMEZONES.map((tz) => (
                          <option key={tz} value={tz} />
                        ))}
                      </datalist>
                    </div>
                    <NumberField label="Slot interval (min)" value={slotGranularityMin} onChange={setSlotGranularityMin} min={5} />
                  </div>
                  <div className="space-y-2">
                    {DAYS.map(({ key, label }) => (
                      <div key={key} className="flex items-center gap-3">
                        <label className="flex items-center gap-2 w-32 shrink-0 cursor-pointer">
                          <Checkbox
                            checked={days[key].enabled}
                            onCheckedChange={(c) => setDay(key, { enabled: c === true })}
                          />
                          <span className="text-sm text-text-primary">{label}</span>
                        </label>
                        <TimeSelect
                          value={days[key].start}
                          disabled={!days[key].enabled}
                          onChange={(v) => setDay(key, { start: v })}
                        />
                        <span className="text-text-muted">–</span>
                        <TimeSelect
                          value={days[key].end}
                          disabled={!days[key].enabled}
                          onChange={(v) => setDay(key, { end: v })}
                        />
                      </div>
                    ))}
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
                        setOverrides((prev) => [...prev, { date: '', closed: true, start: '09:00', end: '17:00' }])
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
                        <div key={i} className="flex items-center gap-3 flex-wrap">
                          <DatePicker
                            value={o.date}
                            onChange={(v) =>
                              setOverrides((prev) => prev.map((x, j) => (j === i ? { ...x, date: v } : x)))
                            }
                            className="w-44"
                          />
                          <label className="flex items-center gap-2 cursor-pointer">
                            <Checkbox
                              checked={o.closed}
                              onCheckedChange={(c) =>
                                setOverrides((prev) => prev.map((x, j) => (j === i ? { ...x, closed: c === true } : x)))
                              }
                            />
                            <span className="text-sm text-text-secondary">Closed</span>
                          </label>
                          {!o.closed && (
                            <>
                              <TimeSelect
                                value={o.start}
                                onChange={(v) =>
                                  setOverrides((prev) => prev.map((x, j) => (j === i ? { ...x, start: v } : x)))
                                }
                              />
                              <span className="text-text-muted">–</span>
                              <TimeSelect
                                value={o.end}
                                onChange={(v) =>
                                  setOverrides((prev) => prev.map((x, j) => (j === i ? { ...x, end: v } : x)))
                                }
                              />
                            </>
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
                  {errors.map((e, i) => (
                    <li key={i}>{e}</li>
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
        {total} slot{total === 1 ? '' : 's'} in the next 7 days (reflects saved settings · {data?.timezone ?? timezone}).
      </p>
      {grouped.map(([day, times]) => (
        <div key={day} className="text-sm">
          <span className="text-text-secondary">{day}: </span>
          <span className="text-text-primary">{times.slice(0, 8).join(', ')}</span>
          {times.length > 8 && <span className="text-text-muted"> +{times.length - 8} more</span>}
        </div>
      ))}
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

export default SchedulerSettings;
