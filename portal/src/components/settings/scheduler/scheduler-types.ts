import type React from 'react';
import type {
  WeeklyHours,
  Weekday,
  TimeWindow,
  ServiceAreaEntry,
  VenueAddress,
  BookingRules,
  AvailabilityMode,
} from '../../../queries/useSchedulerQueries';

export type { Weekday };

export const DAYS: { key: Weekday; label: string }[] = [
  { key: 'mon', label: 'Monday' },
  { key: 'tue', label: 'Tuesday' },
  { key: 'wed', label: 'Wednesday' },
  { key: 'thu', label: 'Thursday' },
  { key: 'fri', label: 'Friday' },
  { key: 'sat', label: 'Saturday' },
  { key: 'sun', label: 'Sunday' },
];

export const DEFAULT_WINDOW: TimeWindow = { start: '09:00', end: '17:00' };

export interface DayRow {
  enabled: boolean;
  /** One or more open windows. A lunch break is simply two of them. */
  windows: TimeWindow[];
}

export type DayState = Record<Weekday, DayRow>;

/** A single date override row (holiday closure or one-off custom hours). */
export interface OverrideRow {
  date: string;
  /** Inclusive last day of a multi-day closure. '' = a single day. */
  endDate: string;
  closed: boolean;
  windows: TimeWindow[];
}

export function overridesFromConfig(raw: unknown[] | undefined): OverrideRow[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((o) => {
    const ov = o as { date?: string; endDate?: string | null; closed?: boolean; windows?: TimeWindow[] };
    const windows = Array.isArray(ov.windows) && ov.windows.length ? ov.windows : [{ ...DEFAULT_WINDOW }];
    return { date: ov.date ?? '', endDate: ov.endDate ?? '', closed: !!ov.closed, windows };
  });
}

export function rowsFromWeeklyHours(weekly: WeeklyHours | undefined): DayState {
  const out = {} as DayState;
  for (const { key } of DAYS) {
    const wins = weekly?.[key];
    out[key] = wins?.length
      ? { enabled: true, windows: wins.map((w) => ({ ...w })) }
      : { enabled: false, windows: [{ ...DEFAULT_WINDOW }] };
  }
  return out;
}

export type SchedulerFormState = {
  availabilityMode: AvailabilityMode;
  slotGranularityMin: number;
  days: DayState;
  overrides: OverrideRow[];
  serviceArea: ServiceAreaEntry[];
  venue: VenueAddress;
  reviewingVenue: boolean;
  travelEnabled: boolean;
  travelStartFromBase: boolean;
  travelBaseDepart: number;
  travelGroupingPeriod: 'none' | 'half_day' | 'full_day';
  travelMaxTravelMin: string;
  bookingsPaused: boolean;
  /** Owner-authored text on every customer confirmation email. `''` means none. */
  confirmationExtraInfo: string;
  rules: BookingRules;
  showPreview: boolean;
  hydrated: boolean;
};

export function createSchedulerForm(): SchedulerFormState {
  return {
    availabilityMode: 'business_hours',
    slotGranularityMin: 30,
    days: rowsFromWeeklyHours(undefined),
    overrides: [],
    serviceArea: [],
    venue: { street: null, postalCode: null, city: null, country: null, placeId: null },
    reviewingVenue: false,
    travelEnabled: false,
    travelStartFromBase: false,
    travelBaseDepart: 0,
    travelGroupingPeriod: 'none',
    travelMaxTravelMin: '',
    bookingsPaused: false,
    confirmationExtraInfo: '',
    rules: {
      maxBookingsPerDay: null,
      maxBookedMinutesPerDay: null,
      minGapMin: null,
      defaultBufferBeforeMin: null,
      defaultBufferAfterMin: null,
      defaultMinNoticeMin: null,
      defaultMaxHorizonDays: null,
    },
    showPreview: false,
    hydrated: false,
  };
}

// A single field update that replicates useState exactly: a plain value replaces,
// a function updates from the previous value. Form fields never hold functions,
// so the typeof check can only ever mean "updater".
export type SchedulerFormAction = { type: 'setField'; field: keyof SchedulerFormState; value: unknown };

export function schedulerFormReducer(
  state: SchedulerFormState,
  action: SchedulerFormAction,
): SchedulerFormState {
  switch (action.type) {
    case 'setField': {
      const prev = state[action.field];
      const next =
        typeof action.value === 'function'
          ? (action.value as (p: unknown) => unknown)(prev)
          : action.value;
      return { ...state, [action.field]: next };
    }
    default:
      return state;
  }
}

/** A useState-shaped setter for one form field (a value or an updater function). */
export function makeFieldSetter<K extends keyof SchedulerFormState>(
  dispatch: React.Dispatch<SchedulerFormAction>,
  field: K,
): (value: SchedulerFormState[K] | ((prev: SchedulerFormState[K]) => SchedulerFormState[K])) => void {
  return (value) => dispatch({ type: 'setField', field, value });
}
