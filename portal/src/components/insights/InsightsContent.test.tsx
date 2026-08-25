import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const { insightsRef, experimentsRef, sentimentRef, demandRef, digestRef, hasFeatureRef, resolveMutate, archiveMutate, dismissMutate, setEmailMutate, answerMutateAsync } = vi.hoisted(() => ({
  insightsRef: { current: null as Record<string, unknown> | null },
  experimentsRef: { current: { experiments: [] } as Record<string, unknown> },
  sentimentRef: { current: { windowDays: 30, timeseries: [] } as Record<string, unknown> },
  demandRef: { current: undefined as Record<string, unknown> | undefined },
  digestRef: { current: { digest: null, emailEnabled: true } as Record<string, unknown> },
  hasFeatureRef: { current: {} as Record<string, boolean> },
  resolveMutate: vi.fn(),
  archiveMutate: vi.fn(),
  dismissMutate: vi.fn(),
  setEmailMutate: vi.fn(),
  answerMutateAsync: vi.fn(),
}));

vi.mock('../../queries/useInsightsQueries', () => ({
  useInsights: () => ({ data: insightsRef.current, isLoading: false }),
  useGapEvidence: () => ({ data: undefined, isLoading: false }),
  useResolveGap: () => ({ mutate: resolveMutate, isPending: false }),
  useArchiveGap: () => ({ mutate: archiveMutate, isPending: false }),
  useAnswerGap: () => ({ mutateAsync: answerMutateAsync, isPending: false }),
  useExperiments: () => ({ data: experimentsRef.current, isLoading: false }),
  useSentimentTrend: () => ({ data: sentimentRef.current, isLoading: false }),
  useLeadDemand: () => ({ data: demandRef.current, isLoading: false }),
  useDismissExperiment: () => ({ mutate: dismissMutate, isPending: false }),
  useDigest: () => ({ data: digestRef.current, isLoading: false }),
  useSetDigestEmail: () => ({ mutate: setEmailMutate, isPending: false }),
}));

vi.mock('../../queries/useEntitlementsQueries', () => ({
  useHasFeature: (key: string) => hasFeatureRef.current[key] ?? true,
}));

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { InsightsContent } from './InsightsContent';

function gap(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'g1',
    topic: 'warranty policy',
    status: 'open',
    severity: 'red',
    priorityScore: 42,
    recommendation: null,
    occurrences: 6,
    distinctVisitors: 5,
    firstDetectedAt: '2026-06-10T00:00:00Z',
    lastSeenAt: '2026-06-11T00:00:00Z',
    resolvedAt: null,
    archivedAt: null,
    answerDocumentId: null,
    answeredAt: null,
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
  sentimentRef.current = { windowDays: 30, timeseries: [] };
  digestRef.current = { digest: null, emailEnabled: true };
  resolveMutate.mockReset();
  archiveMutate.mockReset();
  dismissMutate.mockReset();
  setEmailMutate.mockReset();
  answerMutateAsync.mockReset();
  answerMutateAsync.mockResolvedValue({ id: 'g1', answerDocumentId: 'd1', answeredAt: '2026-06-12T00:00:00Z' });
});

function digest(over: Partial<Record<string, unknown>> = {}) {
  return {
    weekStart: '2026-06-08',
    summaryMd: 'A calm week — bookings ticked up while conversations held steady.',
    metrics: {
      conversations: { current: 42, previous: 40 },
      bookings: { current: 8, previous: 5 },
      leads: { current: 3, previous: 3 },
      gapsOpened: 2,
      gapsWon: 1,
    },
    ...over,
  };
}

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
    expect(screen.getByText(/priority 42/i)).toBeInTheDocument();
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

  it('shows optimization suggestions for open Pro+ Gaps only', () => {
    const suggestion = 'Publish clear warranty terms in the knowledge base.';
    hasFeatureRef.current = { gapEvidence: true };
    insightsRef.current = data([gap({ recommendation: suggestion })]);
    const { rerender } = render(<InsightsContent />);
    expect(screen.getByText(suggestion)).toBeInTheDocument();

    hasFeatureRef.current = { gapEvidence: false };
    rerender(<InsightsContent />);
    expect(screen.queryByText(suggestion)).not.toBeInTheDocument();
  });

  it('renders freshness and the completeness warning under 0.9', () => {
    insightsRef.current = data([gap()], { completeness: 0.7 });
    render(<InsightsContent />);
    expect(screen.getByText(/last analysed/i)).toBeInTheDocument();
    expect(screen.getByText(/insights incomplete/i)).toBeInTheDocument();
  });

  it('renders the first-run pending copy for manual tiers', () => {
    hasFeatureRef.current = { aiBusinessInsights: false };
    insightsRef.current = data([], { lastRefreshedAt: null, completeness: null });
    render(<InsightsContent />);
    expect(screen.getByText(/press analyse to update/i)).toBeInTheDocument();
    expect(screen.getByText(/no open gaps/i)).toBeInTheDocument();
  });

  it('renders the automatic cadence copy for Enterprise tiers', () => {
    hasFeatureRef.current = { aiBusinessInsights: true };
    insightsRef.current = data([], { lastRefreshedAt: null, completeness: null });
    render(<InsightsContent />);
    expect(screen.getByText(/runs automatically throughout the day/i)).toBeInTheDocument();
    expect(screen.queryByText(/press analyse to update/i)).not.toBeInTheDocument();
  });

  it('offers "Answer this" on an unanswered gap', () => {
    render(<InsightsContent />);
    expect(screen.getByRole('button', { name: /answer this/i })).toBeInTheDocument();
  });

  it('replaces the button with the answered line once a document answers the gap', () => {
    insightsRef.current = data([
      gap({ answerDocumentId: 'd1', answeredAt: '2026-06-12T00:00:00Z' }),
    ]);
    render(<InsightsContent />);
    expect(screen.queryByRole('button', { name: /answer this/i })).not.toBeInTheDocument();
    expect(screen.getByText(/answer added/i)).toBeInTheDocument();
  });

  it('offers "Answer this" again when the document was deleted but answeredAt remains', () => {
    // The FK is ON DELETE SET NULL and the timestamp survives, so answeredAt alone
    // must never hide the button - the topic really is unanswered again.
    insightsRef.current = data([gap({ answerDocumentId: null, answeredAt: '2026-06-12T00:00:00Z' })]);
    render(<InsightsContent />);
    expect(screen.getByRole('button', { name: /answer this/i })).toBeInTheDocument();
    expect(screen.queryByText(/answer added/i)).not.toBeInTheDocument();
  });

  it('publishes the typed answer for the gap', async () => {
    const answer = 'We replace a faulty unit within 30 days of purchase.';
    const user = userEvent.setup();
    render(<InsightsContent />);
    await user.click(screen.getByRole('button', { name: /answer this/i }));
    await user.type(screen.getByLabelText(/your answer/i), answer);
    await user.click(screen.getByRole('button', { name: /^publish$/i }));
    expect(answerMutateAsync).toHaveBeenCalledWith({ gapId: 'g1', answer });
  });

  it('keeps Publish disabled until the answer is long enough', async () => {
    const user = userEvent.setup();
    render(<InsightsContent />);
    await user.click(screen.getByRole('button', { name: /answer this/i }));
    await user.type(screen.getByLabelText(/your answer/i), 'hello');
    expect(screen.getByRole('button', { name: /^publish$/i })).toBeDisabled();
    expect(answerMutateAsync).not.toHaveBeenCalled();
  });
});

describe('InsightsContent — sentiment trends (Pro+)', () => {
  it('hides sentiment trends without gapEvidence', () => {
    hasFeatureRef.current = { gapEvidence: false };
    render(<InsightsContent />);
    expect(screen.queryByText(/customer sentiment/i)).not.toBeInTheDocument();
  });

  it('renders the 30-day sentiment trend for Pro+', () => {
    hasFeatureRef.current = { gapEvidence: true };
    sentimentRef.current = {
      windowDays: 30,
      timeseries: [{ date: '2026-08-18', positive: 3, neutral: 1, negative: 2 }],
    };
    render(<InsightsContent />);
    expect(screen.getByText(/customer sentiment/i)).toBeInTheDocument();
    expect(screen.getByText(/last 30 days/i)).toBeInTheDocument();
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

describe('InsightsContent — weekly improvement snapshot (Pro+)', () => {
  it('hides the snapshot without gapEvidence (Essential)', () => {
    hasFeatureRef.current = { gapEvidence: false };
    render(<InsightsContent />);
    expect(screen.queryByText(/your weekly summary/i)).not.toBeInTheDocument();
  });

  it('shows the pending copy before the first Monday for Pro', () => {
    hasFeatureRef.current = { gapEvidence: true, aiBusinessInsights: false };
    digestRef.current = { digest: null, emailEnabled: true };
    render(<InsightsContent />);
    expect(screen.getByText(/your weekly summary/i)).toBeInTheDocument();
    expect(screen.getByText(/first weekly summary will appear/i)).toBeInTheDocument();
  });

  it('renders the narrative and metric deltas for Enterprise unchanged', () => {
    hasFeatureRef.current = { gapEvidence: true, aiBusinessInsights: true };
    digestRef.current = { digest: digest(), emailEnabled: true };
    render(<InsightsContent />);
    expect(screen.getByText(/bookings ticked up/i)).toBeInTheDocument();
    expect(screen.getByText('42')).toBeInTheDocument(); // conversations
    expect(screen.getByText('8')).toBeInTheDocument(); // bookings
    expect(screen.getByText(/week of 2026-06-08/i)).toBeInTheDocument();
  });

  it('toggles the weekly email preference', async () => {
    const user = userEvent.setup();
    hasFeatureRef.current = { gapEvidence: true };
    digestRef.current = { digest: digest(), emailEnabled: true };
    render(<InsightsContent />);
    await user.click(screen.getByRole('switch'));
    expect(setEmailMutate).toHaveBeenCalledWith(false);
  });
});

describe('LeadDemandSection — descriptive, never a finding', () => {
  const demand = {
    window: { from: '', to: '', days: 30 },
    totalLeads: 40,
    classifiedLeads: 24,
    topServices: [{ label: 'Drain unblocking', leads: 18, share: 0.75 }],
    topTags: [],
    taggedLeads: 0,
    byUrgency: { emergency: 0, urgent: 0, routine: 0, unknown: 40 },
    suppressed: false,
    suppressionReason: null,
  };

  beforeEach(() => {
    insightsRef.current = data([]);
  });

  it('is hidden without aiBusinessInsights', () => {
    hasFeatureRef.current = { aiBusinessInsights: false };
    demandRef.current = demand;
    render(<InsightsContent />);
    expect(screen.queryByText(/what customers are asking for/i)).not.toBeInTheDocument();
  });

  it('always prints the denominator next to a share', () => {
    // "75%" alone overstates confidence; "of the 24 of 40 we could match" does not.
    hasFeatureRef.current = { aiBusinessInsights: true };
    demandRef.current = demand;
    render(<InsightsContent />);
    expect(screen.getByText('Drain unblocking')).toBeInTheDocument();
    expect(screen.getByText(/24 of 40/)).toBeInTheDocument();
  });

  it('says "not enough data" instead of showing a share when suppressed', () => {
    hasFeatureRef.current = { aiBusinessInsights: true };
    demandRef.current = {
      ...demand,
      suppressed: true,
      suppressionReason: 'Not enough leads yet (3 in the last 30 days; need 5).',
      topServices: [],
    };
    render(<InsightsContent />);
    expect(screen.getByText(/not enough leads yet/i)).toBeInTheDocument();
    expect(screen.queryByText(/%/)).not.toBeInTheDocument();
  });

  it('labels extracted tags as AI-derived and keeps them separate from services', () => {
    hasFeatureRef.current = { aiBusinessInsights: true };
    demandRef.current = {
      ...demand,
      topTags: [{ label: 'blocked drain', leads: 6, share: 1 }],
      taggedLeads: 6,
    };
    render(<InsightsContent />);
    expect(screen.getByText(/AI-derived/i)).toBeInTheDocument();
    // Its own denominator, not blended into the factual service figures.
    expect(screen.getByText(/6 conversations we were able to analyse/i)).toBeInTheDocument();
  });
});
