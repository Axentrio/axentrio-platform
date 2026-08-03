/**
 * Step 7 — appointments.
 *
 * Unlike the other optional steps this one CONFIGURES, because a booking assistant with
 * no calendar and no hours is not a half-set-up feature — it is one that will confidently
 * offer a customer a slot it cannot honour.
 *
 * Connecting the calendar sends the browser to Google and back. That is safe here
 * precisely because the wizard is a gate: whatever URL Google returns to, the gate shows
 * setup again, and this step re-reads the connection and finds it made. No hole has to be
 * cut for the round trip.
 *
 * Availability is asked as days plus one pair of times, matching the assistant step. The
 * per-day and date-override detail lives in Bookings, where there is room for it.
 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import { CalendarCheck, CheckCircle2, Loader2 } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import {
  useConnectGoogleCalendar,
  useGoogleCalendarStatus,
} from '@/queries/useGoogleCalendarQueries';
import {
  useSchedulerConfig,
  useUpdateSchedulerConfig,
  type WeeklyHours,
} from '@/queries/useSchedulerQueries';
import type { StepProps } from './types';

const WEEK_DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'] as const;
const DEFAULT_OPEN_DAYS: string[] = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'];

/** Slot intervals people actually book in. Minutes. */
const SLOT_CHOICES = [15, 30, 60] as const;

export function BookingsStep({ submit }: StepProps) {
  const { t } = useTranslation();
  const { data: calendar, isLoading: calendarLoading } = useGoogleCalendarStatus();
  const connect = useConnectGoogleCalendar();
  const { data: scheduler } = useSchedulerConfig();
  const updateScheduler = useUpdateSchedulerConfig();

  const [openDays, setOpenDays] = React.useState<string[]>(DEFAULT_OPEN_DAYS);
  const [opensAt, setOpensAt] = React.useState('09:00');
  const [closesAt, setClosesAt] = React.useState('17:00');
  const [slotMinutes, setSlotMinutes] = React.useState<number>(30);
  const [seeded, setSeeded] = React.useState(false);

  React.useEffect(() => {
    if (seeded || !scheduler?.availability) return;
    const weekly = scheduler.availability.weeklyHours ?? {};
    const days = WEEK_DAYS.filter((d) => (weekly[d]?.length ?? 0) > 0);
    if (days.length) {
      setOpenDays([...days]);
      const first = weekly[days[0]][0];
      if (first?.start) setOpensAt(first.start);
      if (first?.end) setClosesAt(first.end);
    }
    if (scheduler.availability.slotGranularityMin) {
      setSlotMinutes(scheduler.availability.slotGranularityMin);
    }
    setSeeded(true);
  }, [seeded, scheduler]);

  const toggleDay = (day: string) =>
    setOpenDays((days) => (days.includes(day) ? days.filter((d) => d !== day) : [...days, day]));

  const save = async () => {
    const weeklyHours: WeeklyHours = {};
    for (const day of WEEK_DAYS) {
      weeklyHours[day] = openDays.includes(day) ? [{ start: opensAt, end: closesAt }] : [];
    }
    await updateScheduler.mutateAsync({
      provider: 'internal',
      availability: {
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
        availabilityMode: 'business_hours',
        weeklyHours,
        dateOverrides: [],
        slotGranularityMin: slotMinutes,
      },
    });
    submit.mutate({ step: 'bookings' });
  };

  const connected = calendar?.connected === true;
  const busy = updateScheduler.isPending || submit.isPending || connect.isPending;

  return (
    <div className="space-y-6">
      <div className="flex items-start gap-4">
        <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-surface-2">
          <CalendarCheck className="h-5 w-5 text-primary-400" />
        </div>
        <div className="space-y-1.5">
          <h2 className="text-xl font-semibold text-text-primary">
            {t('setup.steps.bookings.title')}
          </h2>
          <p className="text-sm text-text-secondary">{t('setup.steps.bookings.body')}</p>
        </div>
      </div>

      {/* Connect first: everything below is meaningless without somewhere to write to. */}
      <div className="space-y-2 rounded-xl border border-edge bg-surface-2 p-4">
        <Label>{t('setup.steps.bookings.calendarLabel')}</Label>
        {calendarLoading ? (
          <Loader2 className="h-4 w-4 animate-spin text-text-muted" />
        ) : connected ? (
          <p className="flex items-center gap-1.5 text-sm text-status-online">
            <CheckCircle2 className="h-4 w-4" />
            {t('setup.steps.bookings.calendarConnected', {
              account: calendar?.accountEmail ?? '',
            })}
          </p>
        ) : (
          <div className="space-y-2">
            <Button variant="outline" onClick={() => connect.mutate()} disabled={busy}>
              {connect.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {t('setup.steps.bookings.connectCalendar')}
            </Button>
            <p className="text-xs text-text-muted">{t('setup.steps.bookings.calendarHint')}</p>
          </div>
        )}
      </div>

      <div className="space-y-3">
        <Label>{t('setup.steps.bookings.availabilityLabel')}</Label>
        <div className="flex flex-wrap gap-1.5">
          {WEEK_DAYS.map((day) => (
            <button
              key={day}
              type="button"
              onClick={() => toggleDay(day)}
              aria-pressed={openDays.includes(day)}
              className={cn(
                'rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors',
                openDays.includes(day)
                  ? 'border-primary-500 bg-primary-500/10 text-text-primary'
                  : 'border-edge bg-surface-2 text-text-muted hover:border-primary-500/50',
              )}
            >
              {t(`setup.steps.chatbot.days.${day}`)}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <Input
            aria-label={t('setup.steps.chatbot.opensAt')}
            type="time"
            value={opensAt}
            onChange={(e) => setOpensAt(e.target.value)}
            className="w-32"
          />
          <span className="text-sm text-text-muted">{t('setup.steps.chatbot.to')}</span>
          <Input
            aria-label={t('setup.steps.chatbot.closesAt')}
            type="time"
            value={closesAt}
            onChange={(e) => setClosesAt(e.target.value)}
            className="w-32"
          />
        </div>
      </div>

      <div className="space-y-2">
        <Label>{t('setup.steps.bookings.slotLabel')}</Label>
        <div className="grid gap-2 sm:grid-cols-3">
          {SLOT_CHOICES.map((minutes) => (
            <button
              key={minutes}
              type="button"
              onClick={() => setSlotMinutes(minutes)}
              className={cn(
                'rounded-lg border px-3 py-2.5 text-sm font-medium transition-colors',
                slotMinutes === minutes
                  ? 'border-primary-500 bg-primary-500/10 text-text-primary'
                  : 'border-edge bg-surface-2 text-text-secondary hover:border-primary-500/50',
              )}
            >
              {t('setup.steps.bookings.slotMinutes', { minutes })}
            </button>
          ))}
        </div>
        <p className="text-xs text-text-muted">{t('setup.steps.bookings.servicesHint')}</p>
      </div>

      <div className="flex justify-end">
        <Button size="lg" onClick={save} disabled={busy || !connected || openDays.length === 0}>
          {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          {t('setup.continue')}
        </Button>
      </div>
    </div>
  );
}
