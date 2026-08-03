/**
 * The manual-analysis control.
 *
 * What matters here is the REFUSAL copy. A disabled button that doesn't say why leaves
 * the operator able to see a feature and unable to reach it, and this control is
 * disabled most of the time by design — a 72-hour cooldown means Essential sees it
 * greyed on all but one day in three.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

const status = vi.hoisted(() => ({ value: null as unknown }));
const runMock = vi.hoisted(() => ({ fn: vi.fn(), pending: false }));

vi.mock('@/queries/useInsightsQueries', () => ({
  useAnalysisStatus: () => ({ data: status.value, isLoading: false }),
  useRunAnalysis: () => ({ mutateAsync: runMock.fn, isPending: runMock.pending }),
}));

import { AnalysisTrigger } from './AnalysisTrigger';

const base = {
  eligible: false,
  reason: null,
  newChats: 0,
  minNewChats: 15,
  nextAllowedAt: null,
  lastRefreshedAt: null,
  policy: { tier: 'essential', automatic: false, minNewChats: 15, cooldownHours: 72 },
};

beforeEach(() => {
  runMock.fn = vi.fn();
  runMock.pending = false;
});

describe('AnalysisTrigger', () => {
  it('offers the run when the tier bar is met', () => {
    status.value = { ...base, eligible: true, reason: null, newChats: 20 };
    render(<AnalysisTrigger />);
    expect(screen.getByRole('button', { name: /analyse now/i })).toBeEnabled();
  });

  it('says how far off the minimum is, not just "unavailable"', () => {
    status.value = { ...base, reason: 'not_enough_chats', newChats: 12 };
    render(<AnalysisTrigger />);
    expect(screen.getByRole('button', { name: /analyse now/i })).toBeDisabled();
    expect(screen.getByText(/12 of 15/i)).toBeInTheDocument();
  });

  it('says when the cooldown lifts, in hours the operator can act on', () => {
    status.value = {
      ...base,
      reason: 'cooling_down',
      newChats: 90,
      nextAllowedAt: new Date(Date.now() + 4 * 3_600_000).toISOString(),
    };
    render(<AnalysisTrigger />);
    expect(screen.getByText(/again in 4 hours/i)).toBeInTheDocument();
  });

  it('gives Enterprise a statement instead of a button they cannot use', () => {
    // A control that duplicates work already underway is worse than no control.
    status.value = {
      ...base,
      reason: 'automatic',
      policy: { tier: 'enterprise', automatic: true, minNewChats: 0, cooldownHours: 0 },
    };
    render(<AnalysisTrigger />);
    expect(screen.queryByRole('button', { name: /analyse now/i })).not.toBeInTheDocument();
    expect(screen.getByText(/continuously/i)).toBeInTheDocument();
  });

  it('renders nothing at all for a tenant without insights', () => {
    // Nothing here they could unlock by waiting, so a greyed control is pure noise.
    status.value = { ...base, reason: 'not_entitled', policy: { ...base.policy, tier: 'none' } };
    const { container } = render(<AnalysisTrigger />);
    expect(container).toBeEmptyDOMElement();
  });
});
