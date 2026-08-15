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
import { ServiceAreaField } from '@/components/settings/ServiceAreaField';
import {
  useConnectGoogleCalendar,
  useGoogleCalendarStatus,
} from '@/queries/useGoogleCalendarQueries';
import {
  useConnectOutlookCalendar,
  useOutlookCalendarStatus,
} from '@/queries/useOutlookCalendarQueries';
import {
  useSchedulerConfig,
  useUpdateSchedulerConfig,
  type WeeklyHours,
  type Weekday,
  type ServiceAreaEntry,
} from '@/queries/useSchedulerQueries';
import type { StepProps } from './types';

/**
 * `api` is the key the scheduler API accepts; `i18n` is the translation key. They differ,
 * and conflating them is what made this step unsavable — it posted `monday` at an enum that
 * only takes `mon`, so every save 422'd and the wizard could never advance.
 */
const WEEK_DAYS: { api: Weekday; i18n: string }[] = [
  { api: 'mon', i18n: 'monday' },
  { api: 'tue', i18n: 'tuesday' },
  { api: 'wed', i18n: 'wednesday' },
  { api: 'thu', i18n: 'thursday' },
  { api: 'fri', i18n: 'friday' },
  { api: 'sat', i18n: 'saturday' },
  { api: 'sun', i18n: 'sunday' },
];
const DEFAULT_OPEN_DAYS: Weekday[] = ['mon', 'tue', 'wed', 'thu', 'fri'];

/** Slot intervals people actually book in. Minutes. */
const SLOT_CHOICES = [15, 30, 60] as const;

/**
 * Does the wizard's calendar requirement look satisfied?
 *
 * EITHER provider counts. The booking engine writes through a provider-agnostic port, so
 * which one is connected changes nothing downstream — but this step read the GOOGLE status
 * alone, and its Continue button gated on it, so a business running on Microsoft 365 could
 * not finish setup at all. Outlook has been a first-class provider on the settings page for
 * as long as Google, and works end to end once connected.
 *
 * Exported as a pure rule so the decision can be tested without a render harness.
 */
export function calendarRequirementMet(
  google: { connected?: boolean } | null | undefined,
  outlook: { connected?: boolean } | null | undefined
): boolean {
  return google?.connected === true || outlook?.connected === true;
}

export function BookingsStep({ submit }: StepProps) {
  const { t } = useTranslation();
  const { data: calendar, isLoading: calendarLoading } = useGoogleCalendarStatus();
  const connect = useConnectGoogleCalendar();
  // Outlook is a first-class provider everywhere else in the product — the settings page
  // has offered it for as long as Google. Only this step demanded Google, so a business
  // running on Microsoft 365 could not finish setup at all: the Continue button gated on
  // the GOOGLE status and there was no second option to click.
  const { data: outlook, isLoading: outlookLoading } = useOutlookCalendarStatus();
  const connectOutlook = useConnectOutlookCalendar();
  const { data: scheduler } = useSchedulerConfig();
  const updateScheduler = useUpdateSchedulerConfig();

  const [openDays, setOpenDays] = React.useState<Weekday[]>(DEFAULT_OPEN_DAYS);
  const [opensAt, setOpensAt] = React.useState('09:00');
  const [closesAt, setClosesAt] = React.useState('17:00');
  const [slotMinutes, setSlotMinutes] = React.useState<number>(30);
  const [serviceArea, setServiceArea] = React.useState<ServiceAreaEntry[]>([]);
  const [seeded, setSeeded] = React.useState(false);

  React.useEffect(() => {
    // The area is seeded OUTSIDE the availability guard below, mirroring SchedulerSettings:
    // a bot can have a service area before it has any hours.
    if (!seeded && Array.isArray(scheduler?.serviceArea)) setServiceArea(scheduler.serviceArea);
    if (seeded || !scheduler?.availability) return;
    const weekly = scheduler.availability.weeklyHours ?? {};
    const days = WEEK_DAYS.filter((d) => (weekly[d.api]?.length ?? 0) > 0).map((d) => d.api);
    if (days.length) {
      setOpenDays(days);
      const first = weekly[days[0]]?.[0];
      if (first?.start) setOpensAt(first.start);
      if (first?.end) setClosesAt(first.end);
    }
    if (scheduler.availability.slotGranularityMin) {
      setSlotMinutes(scheduler.availability.slotGranularityMin);
    }
    setSeeded(true);
  }, [seeded, scheduler]);

  const toggleDay = (day: Weekday) =>
    setOpenDays((days) => (days.includes(day) ? days.filter((d) => d !== day) : [...days, day]));

  const save = async () => {
    const weeklyHours: WeeklyHours = {};

    for (const { api } of WEEK_DAYS) {
      weeklyHours[api] = openDays.includes(api) ? [{ start: opensAt, end: closesAt }] : [];
    }
    try {
      await updateScheduler.mutateAsync({
        provider: 'internal',
        availability: {
          availabilityMode: 'business_hours',
          weeklyHours,
          dateOverrides: [],
          slotGranularityMin: slotMinutes,
        },
        // Always sent, including empty — [] is a real value meaning "no area", which is the
        // correct answer for a salon and must not be confused with "not asked".
        serviceArea,
      });
      submit.mutate({ step: 'bookings' });
    } catch {
      // The hook raises its own toast. Swallowing the rejection here keeps a failed
      // save from becoming an unhandled rejection, and stops the step advancing on one.
    }
  };

  // EITHER provider satisfies the step. The engine writes through a provider-agnostic port,
  // so which one is connected changes nothing downstream.
  const connected = calendarRequirementMet(calendar, outlook);
  // Name whichever is actually connected — showing a Google address to an Outlook business
  // would read as the wrong account being linked.
  const connectedAccount =
    calendar?.connected === true ? calendar?.accountEmail : outlook?.accountEmail;
  const calendarLoadingAny = calendarLoading || outlookLoading;
  const busy =
    updateScheduler.isPending || submit.isPending || connect.isPending || connectOutlook.isPending;

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
        {calendarLoadingAny ? (
          <Loader2 className="h-4 w-4 animate-spin text-text-muted" />
        ) : connected ? (
          <p className="flex items-center gap-1.5 text-sm text-status-online">
            <CheckCircle2 className="h-4 w-4" />
            {t('setup.steps.bookings.calendarConnected', { account: connectedAccount ?? '' })}
          </p>
        ) : (
          <div className="space-y-2">
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" onClick={() => connect.mutate()} disabled={busy}>
                {connect.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                {t('setup.steps.bookings.connectCalendar')}
              </Button>
              <Button variant="outline" onClick={() => connectOutlook.mutate()} disabled={busy}>
                {connectOutlook.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Connect Outlook Calendar
              </Button>
            </div>
            <p className="text-xs text-text-muted">{t('setup.steps.bookings.calendarHint')}</p>
          </div>
        )}
      </div>

      <div className="space-y-3">
        <Label>{t('setup.steps.bookings.availabilityLabel')}</Label>
        <div className="flex flex-wrap gap-1.5">
          {WEEK_DAYS.map(({ api, i18n }) => (
            <button
              key={api}
              type="button"
              onClick={() => toggleDay(api)}
              aria-pressed={openDays.includes(api)}
              className={cn(
                'rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors',
                openDays.includes(api)
                  ? 'border-primary-500 bg-primary-500/10 text-text-primary'
                  : 'border-edge bg-surface-2 text-text-muted hover:border-primary-500/50',
              )}
            >
              {t(`setup.steps.chatbot.days.${i18n}`)}
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

      {/*
        Where the business travels. Asked HERE because otherwise it is asked nowhere: every
        mobile trade finished setup with no area and then never found the setting, so the
        gate that protects them from driving to Liège for a 40-minute job never armed.
        Optional by design — a salon has no service area, and [] is the honest answer.
      */}
      <ServiceAreaField
        value={serviceArea}
        onChange={setServiceArea}
        hasAddressService={(scheduler?.services ?? []).some(
          (svc) => svc.isActive && svc.customerAddressRequired,
        )}
      />

      <div className="flex justify-end">
        <Button size="lg" onClick={save} disabled={busy || !connected || openDays.length === 0}>
          {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          {t('setup.continue')}
        </Button>
      </div>
    </div>
  );
}
