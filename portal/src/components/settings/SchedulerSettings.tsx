/**
 * Internal scheduler settings — choose the booking provider and, for the
 * in-house scheduler, configure the event type and weekly availability.
 * Cal.com's own connection is configured in the separate CalcomSettings card.
 */
import React, { useEffect, useState } from 'react';
import { CalendarClock, Save } from 'lucide-react';
import { Card, CardHeader, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { cn } from '@/lib/utils';
import {
  useSchedulerConfig,
  useUpdateSchedulerConfig,
  type WeeklyHours,
} from '../../queries/useSchedulerQueries';

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

interface DayRow {
  enabled: boolean;
  start: string;
  end: string;
}

type DayState = Record<string, DayRow>;

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

  const [provider, setProvider] = useState<'calcom' | 'internal'>('calcom');
  const [name, setName] = useState('Appointment');
  const [durationMin, setDurationMin] = useState(30);
  const [bufferBeforeMin, setBufferBeforeMin] = useState(0);
  const [bufferAfterMin, setBufferAfterMin] = useState(0);
  const [minNoticeMin, setMinNoticeMin] = useState(60);
  const [maxHorizonDays, setMaxHorizonDays] = useState(60);
  const [timezone, setTimezone] = useState('Europe/Brussels');
  const [slotGranularityMin, setSlotGranularityMin] = useState(30);
  const [days, setDays] = useState<DayState>(() => rowsFromWeeklyHours(undefined));
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    if (!data || hydrated) return;
    setProvider(data.provider ?? 'calcom');
    if (data.eventType) {
      setName(data.eventType.name);
      setDurationMin(data.eventType.durationMin);
      setBufferBeforeMin(data.eventType.bufferBeforeMin);
      setBufferAfterMin(data.eventType.bufferAfterMin);
      setMinNoticeMin(data.eventType.minNoticeMin);
      setMaxHorizonDays(data.eventType.maxHorizonDays);
    }
    if (data.availability) {
      setTimezone(data.availability.timezone);
      setSlotGranularityMin(data.availability.slotGranularityMin);
      setDays(rowsFromWeeklyHours(data.availability.weeklyHours));
    }
    setHydrated(true);
  }, [data, hydrated]);

  const setDay = (key: string, patch: Partial<DayRow>) =>
    setDays((prev) => ({ ...prev, [key]: { ...prev[key], ...patch } }));

  const handleSave = () => {
    if (provider === 'calcom') {
      update.mutate({ provider: 'calcom' });
      return;
    }
    const weeklyHours: WeeklyHours = {};
    for (const { key } of DAYS) {
      const row = days[key];
      if (row.enabled) weeklyHours[key] = [{ start: row.start, end: row.end }];
    }
    update.mutate({
      provider: 'internal',
      eventType: {
        name,
        durationMin,
        bufferBeforeMin,
        bufferAfterMin,
        minNoticeMin,
        maxHorizonDays,
        locationType: 'custom',
      },
      availability: { timezone, weeklyHours, dateOverrides: [], slotGranularityMin },
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
            {/* Provider selector */}
            <div>
              <Label className="text-text-secondary mb-2 block">Booking provider</Label>
              <div className="flex gap-2">
                <Button
                  variant={provider === 'internal' ? 'default' : 'outline'}
                  onClick={() => setProvider('internal')}
                  type="button"
                >
                  Built-in scheduler
                </Button>
                <Button
                  variant={provider === 'calcom' ? 'default' : 'outline'}
                  onClick={() => setProvider('calcom')}
                  type="button"
                >
                  Cal.com
                </Button>
              </div>
              {provider === 'calcom' && (
                <p className="text-xs text-text-muted mt-2">
                  Configure your Cal.com API key and event type in the Cal.com card above.
                </p>
              )}
            </div>

            {provider === 'internal' && (
              <>
                {/* Event type */}
                <div className="space-y-3 border-t border-edge pt-4">
                  <h3 className="text-sm font-medium text-text-primary">Event type</h3>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div className="sm:col-span-2">
                      <Label className="text-text-secondary mb-1 block">Name</Label>
                      <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Intro call" />
                    </div>
                    <NumberField label="Duration (min)" value={durationMin} onChange={setDurationMin} min={5} />
                    <NumberField label="Slot interval (min)" value={slotGranularityMin} onChange={setSlotGranularityMin} min={5} />
                    <NumberField label="Buffer before (min)" value={bufferBeforeMin} onChange={setBufferBeforeMin} min={0} />
                    <NumberField label="Buffer after (min)" value={bufferAfterMin} onChange={setBufferAfterMin} min={0} />
                    <NumberField label="Min notice (min)" value={minNoticeMin} onChange={setMinNoticeMin} min={0} />
                    <NumberField label="Max horizon (days)" value={maxHorizonDays} onChange={setMaxHorizonDays} min={1} />
                  </div>
                </div>

                {/* Availability */}
                <div className="space-y-3 border-t border-edge pt-4">
                  <h3 className="text-sm font-medium text-text-primary">Weekly availability</h3>
                  <div>
                    <Label className="text-text-secondary mb-1 block">Timezone</Label>
                    <select
                      value={timezone}
                      onChange={(e) => setTimezone(e.target.value)}
                      className="w-full px-3 py-2 bg-surface-3 border border-edge rounded-xl text-text-primary text-sm"
                    >
                      {(TIMEZONES.includes(timezone) ? TIMEZONES : [timezone, ...TIMEZONES]).map((tz) => (
                        <option key={tz} value={tz}>
                          {tz}
                        </option>
                      ))}
                    </select>
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
                        <Input
                          type="time"
                          value={days[key].start}
                          disabled={!days[key].enabled}
                          onChange={(e) => setDay(key, { start: e.target.value })}
                          className="w-32"
                        />
                        <span className="text-text-muted">–</span>
                        <Input
                          type="time"
                          value={days[key].end}
                          disabled={!days[key].enabled}
                          onChange={(e) => setDay(key, { end: e.target.value })}
                          className="w-32"
                        />
                      </div>
                    ))}
                  </div>
                </div>
              </>
            )}

            <div className="flex justify-end">
              <Button onClick={handleSave} disabled={update.isPending}>
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
