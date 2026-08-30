import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import {
  TimeSelect,
  parseTimeSelectHhmm,
  timeSelectHours,
  timeSelectMinutes,
} from './time-select';

describe('parseTimeSelectHhmm', () => {
  it('accepts 24:00 as the end-of-day marker and rejects other 24:xx', () => {
    expect(parseTimeSelectHhmm('24:00')).toEqual({ hour: 24, minute: 0 });
    expect(parseTimeSelectHhmm('24:15')).toBeNull();
    expect(parseTimeSelectHhmm('23:59')).toEqual({ hour: 23, minute: 59 });
    expect(parseTimeSelectHhmm('00:00')).toEqual({ hour: 0, minute: 0 });
  });
});

describe('timeSelectHours', () => {
  it('lists 24 only when end-of-day is allowed; 12-hour zones stay 1–12', () => {
    expect(timeSelectHours(false)).not.toContain(24);
    expect(timeSelectHours(false, false)).toEqual(Array.from({ length: 24 }, (_, h) => h));
    expect(timeSelectHours(false, true)).toContain(24);
    expect(timeSelectHours(false, true).at(-1)).toBe(24);
    expect(timeSelectHours(true)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(timeSelectHours(true, true)).not.toContain(24);
  });
});

describe('timeSelectMinutes', () => {
  it('lists every minute when step is 1', () => {
    const minutes = timeSelectMinutes(1);
    expect(minutes).toHaveLength(60);
    expect(minutes[0]).toBe(0);
    expect(minutes[7]).toBe(7);
    expect(minutes[59]).toBe(59);
  });

  it('keeps a 15-minute grid and still lists a stored off-grid minute', () => {
    expect(timeSelectMinutes(15, '09:00')).toEqual([0, 15, 30, 45]);
    expect(timeSelectMinutes(15, '09:07')).toEqual([0, 7, 15, 30, 45]);
  });

  it('only offers minute 00 when the value is 24:00', () => {
    expect(timeSelectMinutes(15, '24:00')).toEqual([0]);
    expect(timeSelectMinutes(1, '24:00')).toEqual([0]);
  });
});

describe('TimeSelect clock labels', () => {
  it('shows 24-hour hour and minute for Europe/Brussels', () => {
    render(
      <TimeSelect
        value="14:30"
        timezone="Europe/Brussels"
        onChange={() => {}}
        aria-label="Opens at"
      />,
    );
    expect(screen.getByRole('combobox', { name: 'Opens at hours' })).toHaveTextContent('14');
    expect(screen.getByRole('combobox', { name: 'Opens at minutes' })).toHaveTextContent('30');
    expect(screen.queryByRole('combobox', { name: 'Opens at AM/PM' })).toBeNull();
  });

  it('shows AM/PM parts for America/New_York', () => {
    render(
      <TimeSelect
        value="14:30"
        timezone="America/New_York"
        onChange={() => {}}
        aria-label="Opens at"
      />,
    );
    expect(screen.getByRole('combobox', { name: 'Opens at hours' })).toHaveTextContent('2');
    expect(screen.getByRole('combobox', { name: 'Opens at minutes' })).toHaveTextContent('30');
    expect(screen.getByRole('combobox', { name: 'Opens at AM/PM' })).toHaveTextContent('PM');
  });

  it('shows an off-grid opening-hour minute', () => {
    render(
      <TimeSelect
        value="14:07"
        stepMinutes={1}
        timezone="Europe/Brussels"
        onChange={() => {}}
        aria-label="Opens at"
      />,
    );
    expect(screen.getByRole('combobox', { name: 'Opens at hours' })).toHaveTextContent('14');
    expect(screen.getByRole('combobox', { name: 'Opens at minutes' })).toHaveTextContent('07');
  });

  it('shows stored 24:00 as 24:00 in Europe, not a blank placeholder', () => {
    render(
      <TimeSelect
        value="24:00"
        allowEndOfDay
        timezone="Europe/Brussels"
        onChange={() => {}}
        aria-label="Closes at"
      />,
    );
    const hours = screen.getByRole('combobox', { name: 'Closes at hours' });
    const minutes = screen.getByRole('combobox', { name: 'Closes at minutes' });
    expect(hours).toHaveTextContent('24');
    expect(minutes).toHaveTextContent('00');
    expect(hours).not.toHaveTextContent('--');
    expect(minutes).not.toHaveTextContent('--');
    expect(screen.queryByRole('combobox', { name: 'Closes at AM/PM' })).toBeNull();
  });

  it('labels stored 24:00 as 12:00 AM (end of day) in 12-hour zones, not 00:00', () => {
    render(
      <TimeSelect
        value="24:00"
        allowEndOfDay
        timezone="America/New_York"
        onChange={() => {}}
        aria-label="Closes at"
      />,
    );
    expect(screen.getByRole('combobox', { name: 'Closes at hours' })).toHaveTextContent('12');
    expect(screen.getByRole('combobox', { name: 'Closes at hours' })).not.toHaveTextContent('24');
    expect(screen.getByRole('combobox', { name: 'Closes at minutes' })).toHaveTextContent('00');
    expect(screen.getByRole('combobox', { name: 'Closes at AM/PM' })).toHaveTextContent(
      'AM (end of day)',
    );
  });

  it('keeps 12:00 AM (00:00) distinct from end of day', () => {
    render(
      <TimeSelect
        value="00:00"
        timezone="America/New_York"
        onChange={() => {}}
        aria-label="Opens at"
      />,
    );
    expect(screen.getByRole('combobox', { name: 'Opens at hours' })).toHaveTextContent('12');
    expect(screen.getByRole('combobox', { name: 'Opens at minutes' })).toHaveTextContent('00');
    expect(screen.getByRole('combobox', { name: 'Opens at AM/PM' })).toHaveTextContent('AM');
    expect(screen.getByRole('combobox', { name: 'Opens at AM/PM' })).not.toHaveTextContent(
      'end of day',
    );
  });

  it('does not offer 24:00 on a start picker', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    render(
      <TimeSelect
        value="09:00"
        allowEndOfDay={false}
        timezone="Europe/Brussels"
        onChange={() => {}}
        aria-label="Opens at"
      />,
    );

    await user.click(screen.getByRole('combobox', { name: 'Opens at hours' }));
    expect(screen.queryByRole('option', { name: '24' })).toBeNull();
  });

  it('does not offer 24:00 on a start picker even when the stored value is 24:00', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    render(
      <TimeSelect
        value="24:00"
        allowEndOfDay={false}
        timezone="Europe/Brussels"
        onChange={() => {}}
        aria-label="Opens at"
      />,
    );

    expect(screen.getByRole('combobox', { name: 'Opens at hours' })).toHaveTextContent('24');
    await user.click(screen.getByRole('combobox', { name: 'Opens at hours' }));
    expect(screen.queryByRole('option', { name: '24' })).toBeNull();
  });

  it('does not offer AM (end of day) on a 12-hour start picker', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    render(
      <TimeSelect
        value="09:00"
        allowEndOfDay={false}
        timezone="America/New_York"
        onChange={() => {}}
        aria-label="Opens at"
      />,
    );

    await user.click(screen.getByRole('combobox', { name: 'Opens at AM/PM' }));
    expect(screen.queryByRole('option', { name: 'AM (end of day)' })).toBeNull();
  });

  it('does not offer AM (end of day) on a 12-hour start picker even when stored as 24:00', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    render(
      <TimeSelect
        value="24:00"
        allowEndOfDay={false}
        timezone="America/New_York"
        onChange={() => {}}
        aria-label="Opens at"
      />,
    );

    await user.click(screen.getByRole('combobox', { name: 'Opens at AM/PM' }));
    expect(screen.queryByRole('option', { name: 'AM (end of day)' })).toBeNull();
  });

  it('writes 24:00 when the 24-hour end-of-day hour is chosen', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    render(
      <TimeSelect
        value="23:00"
        allowEndOfDay
        timezone="Europe/Brussels"
        onChange={onChange}
        aria-label="Closes at"
      />,
    );

    await user.click(screen.getByRole('combobox', { name: 'Closes at hours' }));
    await user.click(await screen.findByRole('option', { name: '24' }));

    expect(onChange).toHaveBeenCalledWith('24:00');
  });

  it('writes 24:00 when AM (end of day) is chosen, not 00:00', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    render(
      <TimeSelect
        value="23:00"
        allowEndOfDay
        timezone="America/New_York"
        onChange={onChange}
        aria-label="Closes at"
      />,
    );

    await user.click(screen.getByRole('combobox', { name: 'Closes at AM/PM' }));
    await user.click(await screen.findByRole('option', { name: 'AM (end of day)' }));

    expect(onChange).toHaveBeenCalledWith('24:00');
    expect(onChange).not.toHaveBeenCalledWith('00:00');
  });
});
