import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const { insightsRef, experimentsRef, hasFeatureRef, resolveMutate, archiveMutate, dismissMutate } = vi.hoisted(() => ({
  insightsRef: { current: null as Record<string, unknown> | null },
  experimentsRef: { current: { experiments: [] } as Record<string, unknown> },
  hasFeatureRef: { current: {} as Record<string, boolean> },
  resolveMutate: vi.fn(),
  archiveMutate: vi.fn(),
  dismissMutate: vi.fn(),
}));

vi.mock('../../queries/useInsightsQueries', () => ({
  useInsights: () => ({ data: insightsRef.current, isLoading: false }),
  useGapEvidence: () => ({ data: undefined, isLoading: false }),
  useResolveGap: () => ({ mutate: resolveMutate, isPending: false }),
  useArchiveGap: () => ({ mutate: archiveMutate, isPending: false }),
  useExperiments: () => ({ data: experimentsRef.current, isLoading: false }),
  useDismissExperiment: () => ({ mutate: dismissMutate, isPending: false }),
}));

vi.mock('../../queries/useEntitlementsQueries', () => ({
  useHasFeature: (key: string) => hasFeatureRef.current[key] ?? true,
}));

import { InsightsContent } from './InsightsContent';

function gap(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'g1',
    topic: 'warranty policy',
    status: 'open',
    severity: 'red',
    occurrences: 6,
    distinctVisitors: 5,
    firstDetectedAt: '2026-06-10T00:00:00Z',
    lastSeenAt: '2026-06-11T00:00:00Z',
    resolvedAt: null,
    archivedAt: null,
    recommendation: null,
    ...over,
  };
}

function data(gaps: Array<Record<string, unknown>>, meta: Partial<Record<string, unknown>> = {}) {
  return {
    gaps,
    meta: {
      lastRefreshedAt: '2026-06-12T02:00:00Z',
      completeness: 1,
      retentionDays: 365,
      evidenceEnabled: true,
      ...meta,
    },
  };
}

beforeEach(() => {
  hasFeatureRef.current = {};
  insightsRef.current = data([gap()]);
  experimentsRef.current = { experiments: [] };
  resolveMutate.mockReset();
  archiveMutate.mockReset();
  dismissMutate.mockReset();
});

function experiment(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'e1',
    kind: 'sentiment',
    severity: 'orange',
    title: 'Customers frequently mention "slow response" — 5 sessions in 30 days',
    detail: null,
    payload: {},
    firstSeenAt: '2026-06-10T00:00:00Z',
    lastSeenAt: '2026-06-14T00:00:00Z',
    ...over,
  };
}

describe('InsightsContent — gap surface', () => {
  it('renders an open gap card with topic, stats, and lifecycle actions', () => {
    render(<InsightsContent />);
    expect(screen.getByText('warranty policy')).toBeInTheDocument();
    expect(screen.getByText(/5 customers asked without getting an answer \(6 conversations\)/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /i fixed this/i })).toBeInTheDocument();
  });

  it('fires the resolve mutation from "I fixed this"', async () => {
    const user = userEvent.setup();
    render(<InsightsContent />);
    await user.click(screen.getByRole('button', { name: /i fixed this/i }));
    expect(resolveMutate).toHaveBeenCalledWith('g1');
  });

  it('splits Open and Wins by lifecycle state', () => {
    insightsRef.current = data([
      gap(),
      gap({ id: 'g2', topic: 'pricing', status: 'resolved_data', severity: 'green', resolvedAt: '2026-06-11' }),
    ]);
    render(<InsightsContent />);
    expect(screen.getByRole('tab', { name: /open \(1\)/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /wins \(1\)/i })).toBeInTheDocument();
  });

  it('shows the evidence drill-down affordance for gapEvidence tenants', () => {
    render(<InsightsContent />);
    expect(screen.getByText(/view the conversations/i)).toBeInTheDocument();
  });

  it('shows the tier-neutral locked affordance without gapEvidence', () => {
    hasFeatureRef.current = { gapEvidence: false };
    insightsRef.current = data([gap()], { evidenceEnabled: false });
    render(<InsightsContent />);
    expect(screen.queryByText(/view the conversations/i)).not.toBeInTheDocument();
    expect(screen.getByText(/upgrade to see the conversations/i)).toBeInTheDocument();
  });

  it('renders freshness and the completeness warning under 0.9', () => {
    insightsRef.current = data([gap()], { completeness: 0.7 });
    render(<InsightsContent />);
    expect(screen.getByText(/last analysed/i)).toBeInTheDocument();
    expect(screen.getByText(/insights incomplete/i)).toBeInTheDocument();
  });

  it('renders the first-run pending copy before any refresh', () => {
    insightsRef.current = data([], { lastRefreshedAt: null, completeness: null });
    render(<InsightsContent />);
    expect(screen.getByText(/first analysis runs tonight/i)).toBeInTheDocument();
    expect(screen.getByText(/no open gaps/i)).toBeInTheDocument();
  });
});

describe('InsightsContent — experiments (Enterprise, P3)', () => {
  it('hides the Experiments section without aiBusinessInsights', () => {
    hasFeatureRef.current = { aiBusinessInsights: false };
    render(<InsightsContent />);
    expect(screen.queryByText(/^experiments$/i)).not.toBeInTheDocument();
  });

  it('renders experiment cards for Enterprise tenants', () => {
    hasFeatureRef.current = { aiBusinessInsights: true };
    experimentsRef.current = { experiments: [experiment()] };
    render(<InsightsContent />);
    expect(screen.getByText(/^experiments$/i)).toBeInTheDocument();
    expect(screen.getByText(/Customers frequently mention "slow response"/)).toBeInTheDocument();
  });

  it('dismisses an experiment', async () => {
    const user = userEvent.setup();
    hasFeatureRef.current = { aiBusinessInsights: true };
    experimentsRef.current = { experiments: [experiment()] };
    render(<InsightsContent />);
    await user.click(screen.getByRole('button', { name: /dismiss/i }));
    expect(dismissMutate).toHaveBeenCalledWith('e1');
  });
});
