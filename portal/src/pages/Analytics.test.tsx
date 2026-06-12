import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const { outcomesRef, dashboardRef, hasFeatureRef } = vi.hoisted(() => ({
  outcomesRef: { current: null as Record<string, unknown> | null },
  dashboardRef: { current: null as Record<string, unknown> | null },
  hasFeatureRef: { current: {} as Record<string, boolean> },
}));

vi.mock('../queries/useAnalyticsQueries', () => ({
  useAnalyticsTimeseries: () => ({ data: { timeseries: [] }, isLoading: false }),
  useAnalyticsChatMetrics: () => ({
    data: { metrics: { total: 10, closed: 8, open: 2, humanResolved: 2, avgDurationSeconds: 60 } },
    isLoading: false,
  }),
  useAnalyticsOutcomes: () => ({ data: outcomesRef.current, isLoading: false }),
  useAnalyticsOutcomesTimeseries: () => ({ data: { timeseries: [] }, isLoading: false }),
}));

vi.mock('../queries/useDashboardQueries', () => ({
  useDashboardMetrics: () => ({ data: { dashboard: dashboardRef.current } }),
}));

vi.mock('../queries/useEntitlementsQueries', () => ({
  useHasFeature: (key: string) => hasFeatureRef.current[key] ?? true,
}));

vi.mock('@auth/useAppAuth', () => ({
  useAppAuth: () => ({ user: { role: 'admin' } }),
}));

vi.mock('@/components/dashboard/OnboardingBanner', () => ({
  OnboardingBanner: () => null,
}));

import Analytics from './Analytics';

function outcomes(cur: Record<string, number>, prev: Record<string, number>) {
  const block = (v: Record<string, number>) => ({
    conversations: { total: v.conversations ?? 0, byChannel: { widget: v.conversations ?? 0 } },
    bookings: { total: v.bookings ?? 0, byChannel: {} },
    leads: { total: v.leads ?? 0, bySource: {} },
    afterHours: v.afterHours != null ? { count: v.afterHours, classifiable: 10 } : null,
  });
  return {
    range: { from: '2026-06-05', to: '2026-06-12' },
    previousRange: { from: '2026-05-29', to: '2026-06-05' },
    current: block(cur),
    previous: block(prev),
  };
}

function renderUI() {
  return render(
    <MemoryRouter>
      <Analytics />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  hasFeatureRef.current = {};
  dashboardRef.current = { sessions: {}, agents: {}, avgResponseTimeSeconds: 0, csatScore: null };
  outcomesRef.current = outcomes(
    { conversations: 120, bookings: 5, leads: 7, afterHours: 80 },
    { conversations: 100, bookings: 5, leads: 0 },
  );
});

describe('Analytics — outcome cards', () => {
  it('renders conversations/bookings/leads with vs-previous-period deltas', () => {
    renderUI();
    expect(screen.getByText('Conversations')).toBeInTheDocument();
    expect(screen.getByText('120')).toBeInTheDocument();
    expect(screen.getByText('+20% vs previous period')).toBeInTheDocument(); // 100 → 120
    expect(screen.getByText('Bookings')).toBeInTheDocument();
    expect(screen.getByText('+0% vs previous period')).toBeInTheDocument(); // 5 → 5
    expect(screen.getByText('Leads captured')).toBeInTheDocument();
    expect(screen.getByText('new vs previous period')).toBeInTheDocument(); // 0 → 7
  });

  it('hides the bookings card without the bookings feature (Essential has no module)', () => {
    hasFeatureRef.current = { bookings: false };
    renderUI();
    expect(screen.queryByText('Bookings')).not.toBeInTheDocument();
    expect(screen.getByText('Conversations')).toBeInTheDocument();
  });

  it('shows the after-hours card when the tenant has business hours to classify against', () => {
    renderUI();
    expect(screen.getByText('After-hours conversations')).toBeInTheDocument();
    expect(screen.getByText('80')).toBeInTheDocument();
  });

  it('hides the after-hours card when afterHours is null (no scheduler rules)', () => {
    outcomesRef.current = outcomes({ conversations: 1 }, { conversations: 1 }); // afterHours: null
    renderUI();
    expect(screen.queryByText('After-hours conversations')).not.toBeInTheDocument();
  });

  it('keeps response-time and CSAT cards hidden until their data sources are populated', () => {
    renderUI();
    expect(screen.queryByText('Avg Response Time')).not.toBeInTheDocument();
    expect(screen.queryByText('CSAT Score')).not.toBeInTheDocument();
  });

  it('restores the response-time and CSAT cards once real values exist', () => {
    dashboardRef.current = { sessions: {}, agents: {}, avgResponseTimeSeconds: 12, csatScore: 4.5 };
    renderUI();
    expect(screen.getByText('Avg Response Time')).toBeInTheDocument();
    expect(screen.getByText('4.5/5')).toBeInTheDocument();
  });

  it('renders the outcome charts, not the removed fabricated ones', () => {
    renderUI();
    expect(screen.getByText('Outcomes over time')).toBeInTheDocument();
    expect(screen.getByText('Conversations by channel')).toBeInTheDocument();
    // The fabricated response-time-by-day and CSAT-distribution charts stay dead.
    expect(screen.queryByText(/response time trend/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/csat distribution/i)).not.toBeInTheDocument();
  });
});
