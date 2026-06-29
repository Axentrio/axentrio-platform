import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { BookingReadinessCard } from './BookingReadinessCard';
import { BookingSetupBanner } from './BookingSetupBanner';
import type { ReadinessResult } from '@/queries/useReadinessQueries';

function renderCard(booking: ReadinessResult | undefined) {
  return render(
    <MemoryRouter>
      <BookingReadinessCard booking={booking} />
    </MemoryRouter>,
  );
}

const NOT_READY: ReadinessResult = {
  capability: 'booking',
  state: 'not_ready',
  missingSteps: [
    { id: 'add_service', label: 'Add a bookable service', cta: { route: '/bookings/setup', label: 'Add a bookable service' } },
    { id: 'set_hours', label: 'Set availability hours', cta: { route: '/bookings/setup', label: 'Set availability hours' } },
  ],
  attention: undefined,
  detail: { willAutoConfirm: false },
};

const LIVE_WITH_ATTENTION: ReadinessResult = {
  capability: 'booking',
  state: 'live',
  missingSteps: [],
  attention: [
    {
      code: 'calendar_not_connected',
      label: 'Connect a calendar to auto-confirm bookings',
      cta: { route: '/bookings/setup', label: 'Connect a calendar' },
    },
  ],
  detail: { willAutoConfirm: false },
};

const LIVE_CLEAN: ReadinessResult = {
  capability: 'booking',
  state: 'live',
  missingSteps: [],
  attention: undefined,
  detail: { willAutoConfirm: true },
};

describe('BookingReadinessCard', () => {
  it('renders the ordered missingSteps with their CTA deep-links when not_ready', () => {
    renderCard(NOT_READY);
    expect(screen.getByText(/Booking readiness/i)).toBeInTheDocument();
    // The backend repeats the label as both the step text and the CTA label
    // (booking.readiness.ts), so the step appears twice (text + button).
    expect(screen.getAllByText('Add a bookable service').length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText('Set availability hours').length).toBeGreaterThanOrEqual(2);
    // Each missing step renders its CTA as a deep-link; /bookings/setup → /bookings.
    const links = screen.getAllByRole('link');
    expect(links).toHaveLength(2);
    links.forEach((a) => expect(a).toHaveAttribute('href', '/bookings'));
    // "Not live yet" badge.
    expect(screen.getByText(/Not live yet/i)).toBeInTheDocument();
  });

  it('renders attention rows (and the live badge) when live but degraded', () => {
    renderCard(LIVE_WITH_ATTENTION);
    expect(screen.getByText('Connect a calendar to auto-confirm bookings')).toBeInTheDocument();
    expect(screen.getByText(/^Live$/i)).toBeInTheDocument();
    // The attention CTA deep-links too.
    expect(screen.getByRole('link', { name: /Connect a calendar/i })).toHaveAttribute('href', '/bookings');
  });

  it('returns null when booking is live with no attention', () => {
    const { container } = renderCard(LIVE_CLEAN);
    expect(container.firstChild).toBeNull();
  });

  it('returns null when booking does not apply (undefined)', () => {
    const { container } = renderCard(undefined);
    expect(container.firstChild).toBeNull();
  });
});

describe('BookingSetupBanner', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('shows when booking applies and is not live', () => {
    render(<BookingSetupBanner botId="anchor-1" booking={NOT_READY} />);
    expect(screen.getByText(/Booking isn't live yet/i)).toBeInTheDocument();
  });

  it('hides when booking is live', () => {
    const { container } = render(<BookingSetupBanner botId="anchor-1" booking={LIVE_WITH_ATTENTION} />);
    expect(container.firstChild).toBeNull();
  });

  it('hides when booking does not apply (undefined)', () => {
    const { container } = render(<BookingSetupBanner botId="anchor-1" booking={undefined} />);
    expect(container.firstChild).toBeNull();
  });

  it('dismissal is keyed per bot', async () => {
    const user = userEvent.setup();
    const { unmount } = render(<BookingSetupBanner botId="bot-A" booking={NOT_READY} />);
    await user.click(screen.getByRole('button', { name: /Dismiss/i }));
    expect(screen.queryByText(/Booking isn't live yet/i)).not.toBeInTheDocument();
    expect(localStorage.getItem('booking_setup_dismissed:bot-A')).toBe('true');
    unmount();

    // Re-render for bot-A → still dismissed (persisted key).
    const a = render(<BookingSetupBanner botId="bot-A" booking={NOT_READY} />);
    expect(a.container.firstChild).toBeNull();
    a.unmount();

    // A DIFFERENT bot is unaffected → banner shows.
    render(<BookingSetupBanner botId="bot-B" booking={NOT_READY} />);
    expect(screen.getByText(/Booking isn't live yet/i)).toBeInTheDocument();
  });
});
