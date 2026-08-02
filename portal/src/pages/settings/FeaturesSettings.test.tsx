/**
 * Settings → Features.
 *
 * The load-bearing case here is `proactiveLeadCapture`. The entitlement key still
 * exists server-side (plans, wire contract, OPT_IN_FEATURES) but nothing reads it
 * since the chip-offer implementation was removed, so the page must neither show a
 * switch for it nor write it back — a switch that changes nothing is worse than a
 * missing one, and re-persisting `true` would resurrect a flag with no consumer.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import FeaturesSettings from './FeaturesSettings';

type BoolMap = Record<string, boolean>;

const { entitlementsRef, mutate } = vi.hoisted(() => ({
  entitlementsRef: {
    current: {} as { entitledFeatures: BoolMap; featureToggles: BoolMap; features: BoolMap },
  },
  mutate: vi.fn(),
}));

vi.mock('@/queries/useEntitlementsQueries', () => ({
  useEntitlements: () => ({ data: { current: entitlementsRef.current }, isLoading: false }),
  useUpdateFeatureToggles: () => ({ mutate, isPending: false }),
}));

vi.mock('@auth/useAppAuth', () => ({
  useAppAuth: () => ({ isRole: () => true }),
}));

const TOGGLEABLE = [
  'channelWhatsapp',
  'channelMessenger',
  'channelInstagram',
  'channelTelegram',
  'leadCapture',
  'proactiveLeadCapture',
  'bookings',
  'gapInsights',
];

const allTrue = (): BoolMap => Object.fromEntries(TOGGLEABLE.map((k) => [k, true]));

function renderUI() {
  return render(
    <MemoryRouter>
      <FeaturesSettings />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  mutate.mockReset();
  // Pro-like tenant, everything entitled and on — including a STALE stored
  // `proactiveLeadCapture: true` from before the feature was removed.
  entitlementsRef.current = {
    entitledFeatures: allTrue(),
    featureToggles: { proactiveLeadCapture: true },
    features: allTrue(),
  };
});

describe('FeaturesSettings', () => {
  it('renders a switch for every feature it surfaces', () => {
    renderUI();
    // 4 channels + the "All channels" master + leads + bookings + Success Meter.
    expect(screen.getAllByRole('switch')).toHaveLength(8);
    expect(screen.getByText('Capture and store leads from conversations.')).toBeInTheDocument();
  });

  it('does not offer a proactive-lead-capture switch, even to an entitled tenant', () => {
    renderUI();
    expect(screen.queryByText('Ask for missing details')).not.toBeInTheDocument();
  });

  it('drops the stale proactiveLeadCapture preference on the next save', async () => {
    const user = userEvent.setup();
    renderUI();

    // Any switch will do: the PUT replaces the whole map, so every save rebuilds
    // it from the surfaced keys regardless of which one the admin touched.
    await user.click(screen.getAllByRole('switch')[0]);

    expect(mutate).toHaveBeenCalledTimes(1);
    const written = mutate.mock.calls[0][0] as BoolMap;
    expect(Object.keys(written)).not.toContain('proactiveLeadCapture');
    expect(Object.keys(written).sort()).toEqual(
      TOGGLEABLE.filter((k) => k !== 'proactiveLeadCapture').sort(),
    );
  });

  it('never writes a feature the plan does not include', async () => {
    const user = userEvent.setup();
    entitlementsRef.current.entitledFeatures.bookings = false;
    renderUI();

    await user.click(screen.getAllByRole('switch')[0]);

    expect(Object.keys(mutate.mock.calls[0][0] as BoolMap)).not.toContain('bookings');
  });
});
