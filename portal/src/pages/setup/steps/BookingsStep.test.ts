/**
 * The wizard's calendar requirement.
 *
 * This step demanded GOOGLE: `connected` came from the Google status alone and the Continue
 * button gated on it, with no second option to click. A business running on Microsoft 365
 * therefore could not finish setup at all — a blocked signup, not a missing convenience —
 * even though Outlook is a first-class provider everywhere else in the product and works
 * end to end once connected.
 *
 * The provider rule stays pure; the stale-hours regression renders with the query hooks
 * mocked so it can prove a background tenant refetch wins over cached data.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';

const tenantQuery = vi.hoisted(() => ({
  data: undefined as unknown,
  isLoading: false,
  isFetching: false,
}));

vi.mock('@/queries/useTenantQueries', () => ({
  useTenantSettings: () => tenantQuery,
}));

vi.mock('@/queries/useSchedulerQueries', () => ({
  useSchedulerConfig: () => ({ data: undefined, isLoading: false }),
  useUpdateSchedulerConfig: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

vi.mock('@/queries/useGoogleCalendarQueries', () => ({
  useGoogleCalendarStatus: () => ({
    data: { connected: true, accountEmail: 'owner@acme.be' },
    isLoading: false,
  }),
  useConnectGoogleCalendar: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock('@/queries/useOutlookCalendarQueries', () => ({
  useOutlookCalendarStatus: () => ({ data: { connected: false }, isLoading: false }),
  useConnectOutlookCalendar: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock('@/components/settings/ServiceAreaField', () => ({
  ServiceAreaField: () => null,
}));

import { BookingsStep, bookingHoursSeed, calendarRequirementMet } from './BookingsStep';
import type { StepProps } from './types';

const ON = { connected: true };
const OFF = { connected: false };

describe('BookingsStep — calendar requirement', () => {
  it('is met by OUTLOOK alone — the case that was impossible', () => {
    expect(calendarRequirementMet(OFF, ON)).toBe(true);
  });

  it('is still met by GOOGLE alone, exactly as before', () => {
    expect(calendarRequirementMet(ON, OFF)).toBe(true);
  });

  it('is met by both', () => {
    expect(calendarRequirementMet(ON, ON)).toBe(true);
  });

  it('is NOT met when neither is connected', () => {
    // Connecting something is the one thing this step genuinely requires: a booking with
    // nowhere to land is worse than no booking.
    expect(calendarRequirementMet(OFF, OFF)).toBe(false);
  });

  it('treats a still-loading or absent status as not connected', () => {
    // Fail closed while the status is unknown — briefly enabling Continue and then
    // disabling it under the owner's cursor is worse than a moment's wait.
    expect(calendarRequirementMet(undefined, undefined)).toBe(false);
    expect(calendarRequirementMet(null, null)).toBe(false);
  });

  it('requires a real boolean true, not merely something truthy', () => {
    expect(calendarRequirementMet({ connected: 'yes' as never }, OFF)).toBe(false);
  });
});

describe('BookingsStep — first-pass hours', () => {
  beforeEach(() => {
    tenantQuery.data = undefined;
    tenantQuery.isLoading = false;
    tenantQuery.isFetching = false;
  });

  it('seeds availability from enabled chatbot business hours', () => {
    expect(
      bookingHoursSeed({
        enabled: true,
        schedule: [
          { day: 'monday', open: '08:30', close: '18:00', closed: false },
          { day: 'tuesday', open: '08:30', close: '18:00', closed: false },
          { day: 'wednesday', open: '08:30', close: '18:00', closed: true },
        ],
      }),
    ).toEqual({
      openDays: ['mon', 'tue'],
      opensAt: '08:30',
      closesAt: '18:00',
    });
  });

  it('keeps the current weekday defaults when chatbot hours are absent', () => {
    expect(bookingHoursSeed()).toEqual({
      openDays: ['mon', 'tue', 'wed', 'thu', 'fri'],
      opensAt: '09:00',
      closesAt: '17:00',
    });
  });

  it('waits for a tenant refetch before seeding cached chatbot hours', async () => {
    tenantQuery.data = {
      settings: {
        businessHours: {
          enabled: true,
          schedule: [{ day: 'monday', open: '07:00', close: '12:00', closed: false }],
        },
      },
    };
    tenantQuery.isFetching = true;
    const submit = { mutate: vi.fn(), isPending: false } as unknown as StepProps['submit'];
    const view = render(React.createElement(BookingsStep, { submit }));
    const timeInputs = view.container.querySelectorAll<HTMLInputElement>('input[type="time"]');

    expect(timeInputs[0]).toHaveValue('09:00');
    expect(timeInputs[1]).toHaveValue('17:00');

    tenantQuery.data = {
      settings: {
        businessHours: {
          enabled: true,
          schedule: [{ day: 'monday', open: '08:30', close: '18:00', closed: false }],
        },
      },
    };
    tenantQuery.isFetching = false;
    view.rerender(React.createElement(BookingsStep, { submit }));

    await waitFor(() => {
      expect(timeInputs[0]).toHaveValue('08:30');
      expect(timeInputs[1]).toHaveValue('18:00');
    });
  });
});
