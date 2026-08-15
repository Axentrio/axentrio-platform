/**
 * Tests for the B-PR5b timed human-control UI primitives:
 *  - TakeoverMenu emits the picked policy ({ mode:'indefinite' } vs
 *    { mode:'timed', hours }) — the wire payload itself is the Inbox's job
 *    and is covered in Inbox.human-control.test.tsx.
 *  - formatRemaining: mm:ss under an hour, "Hh Mm" above, clamped at 0.
 *  - HumanControlBadge: live countdown, the warning state under 5 minutes,
 *    "resuming…" at 0 WITHOUT any client-side release, and no leaked interval
 *    (self-stop at 0, cleanup on unmount).
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { TakeoverMenu, HumanControlBadge } from './HumanControl';
import { formatRemaining, type TakeoverPolicy } from '@utils/humanControl';

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// formatRemaining
// ---------------------------------------------------------------------------

describe('formatRemaining', () => {
  it('formats mm:ss under an hour', () => {
    expect(formatRemaining(90_000)).toBe('1:30');
    expect(formatRemaining(5_000)).toBe('0:05');
    expect(formatRemaining(3_599_000)).toBe('59:59');
  });

  it('formats Hh Mm at an hour and above', () => {
    expect(formatRemaining(3_600_000)).toBe('1h 0m');
    expect(formatRemaining(2 * 3_600_000 + 30 * 60_000)).toBe('2h 30m');
    expect(formatRemaining(24 * 3_600_000)).toBe('24h 0m');
  });

  it('clamps at zero', () => {
    expect(formatRemaining(0)).toBe('0:00');
    expect(formatRemaining(-5_000)).toBe('0:00');
  });
});

// ---------------------------------------------------------------------------
// TakeoverMenu
// ---------------------------------------------------------------------------

describe('TakeoverMenu', () => {
  it('emits { mode:"timed", hours } for a duration pick', async () => {
    const onSelect = vi.fn<(p: TakeoverPolicy) => void>();
    const user = userEvent.setup();
    render(<TakeoverMenu onSelect={onSelect} trigger={<button type="button">Take Over</button>} />);

    await user.click(screen.getByRole('button', { name: 'Take Over' }));
    await user.click(await screen.findByText('For 4 hours'));

    expect(onSelect).toHaveBeenCalledExactlyOnceWith({ mode: 'timed', hours: 4 });
  });

  it('offers every duration plus the indefinite option', async () => {
    const onSelect = vi.fn<(p: TakeoverPolicy) => void>();
    const user = userEvent.setup();
    render(<TakeoverMenu onSelect={onSelect} trigger={<button type="button">Take Over</button>} />);

    await user.click(screen.getByRole('button', { name: 'Take Over' }));
    expect(await screen.findByText('Until I return it to AI')).toBeInTheDocument();
    expect(screen.getByText('For 1 hour')).toBeInTheDocument();
    for (const hours of [2, 4, 8, 12, 24]) {
      expect(screen.getByText(`For ${hours} hours`)).toBeInTheDocument();
    }
  });

  it('emits { mode:"indefinite" } for "Until I return it to AI"', async () => {
    const onSelect = vi.fn<(p: TakeoverPolicy) => void>();
    const user = userEvent.setup();
    render(<TakeoverMenu onSelect={onSelect} trigger={<button type="button">Take Over</button>} />);

    await user.click(screen.getByRole('button', { name: 'Take Over' }));
    await user.click(await screen.findByText('Until I return it to AI'));

    expect(onSelect).toHaveBeenCalledExactlyOnceWith({ mode: 'indefinite' });
  });
});

// ---------------------------------------------------------------------------
// HumanControlBadge
// ---------------------------------------------------------------------------

const NOW = new Date('2026-08-15T12:00:00.000Z');

function untilIn(ms: number): string {
  return new Date(NOW.getTime() + ms).toISOString();
}

describe('HumanControlBadge', () => {
  it('renders the plain "you have control" badge for an indefinite control', () => {
    render(<HumanControlBadge mode="indefinite" until={null} />);
    const badge = screen.getByTestId('human-control-badge');
    expect(badge).toHaveTextContent('AI paused - you have control');
    expect(badge).toHaveAttribute('data-state', 'indefinite');
  });

  it('falls back to the plain badge when the summary fields are unknown', () => {
    // A deep-linked detail GET does not carry the humanControl fields.
    render(<HumanControlBadge mode={undefined} until={undefined} />);
    expect(screen.getByTestId('human-control-badge')).toHaveAttribute('data-state', 'indefinite');
  });

  it('renders a live countdown that ticks each second', () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    render(<HumanControlBadge mode="timed" until={untilIn(30 * 60_000)} />);

    const badge = screen.getByTestId('human-control-badge');
    expect(badge).toHaveTextContent('AI paused - resumes in 30:00');
    expect(badge).toHaveAttribute('data-state', 'timed');

    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(badge).toHaveTextContent('AI paused - resumes in 29:59');
  });

  it('uses the Hh Mm format above an hour', () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    render(<HumanControlBadge mode="timed" until={untilIn(2 * 3_600_000 + 30 * 60_000)} />);
    expect(screen.getByTestId('human-control-badge')).toHaveTextContent('resumes in 2h 30m');
  });

  it('switches to the warning state under 5 minutes', () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    render(<HumanControlBadge mode="timed" until={untilIn(5 * 60_000 + 1_500)} />);

    const badge = screen.getByTestId('human-control-badge');
    expect(badge).toHaveAttribute('data-state', 'timed');

    act(() => {
      vi.advanceTimersByTime(2_000);
    });
    expect(badge).toHaveAttribute('data-state', 'warning');
    expect(badge).toHaveTextContent('resumes in 4:59');
  });

  it('shows "resuming…" at 0 and stops its own interval (the server owns the release)', () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const timersBefore = vi.getTimerCount();
    render(<HumanControlBadge mode="timed" until={untilIn(2_000)} />);

    act(() => {
      vi.advanceTimersByTime(3_000);
    });
    const badge = screen.getByTestId('human-control-badge');
    expect(badge).toHaveTextContent('AI resuming…');
    expect(badge).toHaveAttribute('data-state', 'resuming');
    // The interval cleared itself at 0 — nothing keeps ticking.
    expect(vi.getTimerCount()).toBe(timersBefore);
  });

  it('renders "resuming…" immediately for an already-past deadline without arming a timer', () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const timersBefore = vi.getTimerCount();
    render(<HumanControlBadge mode="timed" until={untilIn(-1_000)} />);
    expect(screen.getByTestId('human-control-badge')).toHaveAttribute('data-state', 'resuming');
    expect(vi.getTimerCount()).toBe(timersBefore);
  });

  it('clears the interval on unmount (no leak after unselect)', () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const timersBefore = vi.getTimerCount();
    const { unmount } = render(<HumanControlBadge mode="timed" until={untilIn(10 * 60_000)} />);
    expect(vi.getTimerCount()).toBe(timersBefore + 1);
    unmount();
    expect(vi.getTimerCount()).toBe(timersBefore);
  });

  it('never arms a timer for an unparseable deadline (NaN guard)', () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const timersBefore = vi.getTimerCount();
    render(<HumanControlBadge mode="timed" until="not-a-date" />);
    // Falls back to the plain badge — no "NaN:NaN", no interval that can
    // never self-stop (NaN <= 0 is false forever).
    expect(screen.getByTestId('human-control-badge')).toHaveAttribute('data-state', 'indefinite');
    expect(vi.getTimerCount()).toBe(timersBefore);
    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    expect(vi.getTimerCount()).toBe(timersBefore);
  });

  it('re-arms the countdown when the deadline changes (change duration)', () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const { rerender } = render(<HumanControlBadge mode="timed" until={untilIn(60_000)} />);
    expect(screen.getByTestId('human-control-badge')).toHaveTextContent('resumes in 1:00');

    rerender(<HumanControlBadge mode="timed" until={untilIn(8 * 3_600_000)} />);
    expect(screen.getByTestId('human-control-badge')).toHaveTextContent('resumes in 8h 0m');
  });
});
