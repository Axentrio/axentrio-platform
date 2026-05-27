/**
 * Tests for LockedPreview (M1, subscription/feature-access epic).
 *
 * - Renders title, oneLiner, bullets, and a PlanBadge for the requiredTier.
 * - Tier strip shows "Your plan / Required / Trial 14 days / After trial / Cancel anytime"
 *   when requiredTier='pro'.
 * - Tier strip omits price/trial copy for requiredTier='enterprise'.
 * - comingSoon=true hides the tier strip, swaps the CTA to NotifyMeButton,
 *   and the badge says "Coming soon".
 * - "Compare plans" link routes to /settings/billing.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import React from 'react';

const { apiGet } = vi.hoisted(() => ({ apiGet: vi.fn() }));

vi.mock('../../services/apiClient', () => ({
  api: {
    get: apiGet,
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

import { LockedPreview } from './LockedPreview';
import type { EntitlementsResponse } from '../../queries/useEntitlementsQueries';

function entitlements(): EntitlementsResponse {
  return {
    current: {
      planId: 'essential',
      limits: { agents: 3, sessions: 5, dailyLlmCalls: 1000 },
      features: {
        unifiedInbox: true,
        bookings: false,
        calendarIntegrations: false,
        leadCapture: true,
        platformAssistant: false,
        crm: false,
        hideWidgetAttribution: false,
        customWidgetAppearance: false,
        handoff: true,
        fileUpload: true,
      },
      support: 'email',
    },
    plans: [
      {
        id: 'essential',
        displayName: 'Essential',
        rank: 1,
        priceEurMonthly: 29.99,
        isSelfServeCheckoutable: true,
        limits: { agents: 3, sessions: 5, dailyLlmCalls: 1000 },
        features: {
          unifiedInbox: true,
          bookings: false,
          calendarIntegrations: false,
          leadCapture: true,
          platformAssistant: false,
          crm: false,
          hideWidgetAttribution: false,
          customWidgetAppearance: false,
          handoff: true,
          fileUpload: true,
        },
        support: 'email',
      },
      {
        id: 'pro',
        displayName: 'Pro',
        rank: 2,
        priceEurMonthly: 99.99,
        isSelfServeCheckoutable: true,
        limits: { agents: 10, sessions: 25, dailyLlmCalls: 10000 },
        features: {
          unifiedInbox: true,
          bookings: true,
          calendarIntegrations: true,
          leadCapture: true,
          platformAssistant: true,
          crm: true,
          hideWidgetAttribution: true,
          customWidgetAppearance: true,
          handoff: true,
          fileUpload: true,
        },
        support: 'priority',
      },
      {
        id: 'enterprise',
        displayName: 'Enterprise',
        rank: 3,
        priceEurMonthly: null,
        isSelfServeCheckoutable: false,
        limits: { agents: null, sessions: null, dailyLlmCalls: null },
        features: {
          unifiedInbox: true,
          bookings: true,
          calendarIntegrations: true,
          leadCapture: true,
          platformAssistant: true,
          crm: true,
          hideWidgetAttribution: true,
          customWidgetAppearance: true,
          handoff: true,
          fileUpload: true,
        },
        support: 'priority',
      },
    ],
    selfServePlans: ['essential', 'pro'],
  };
}

async function renderUI(props: React.ComponentProps<typeof LockedPreview>) {
  apiGet.mockResolvedValue(entitlements());
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const utils = render(
    <MemoryRouter>
      <QueryClientProvider client={queryClient}>
        <LockedPreview {...props} />
      </QueryClientProvider>
    </MemoryRouter>,
  );
  // Wait for entitlements query to resolve so the tier-strip displayNames /
  // price are populated. The displayName "Essential" only appears once data
  // is loaded (the placeholder is "—"); use that as the readiness signal.
  if (!props.comingSoon) {
    await screen.findByText('Essential');
  }
  return utils;
}

const baseProps = {
  feature: 'bookings' as const,
  title: 'AI Bookings',
  oneLiner: 'Schedule appointments through chat.',
  bullets: ['Bullet one', 'Bullet two', 'Bullet three'],
};

beforeEach(() => {
  apiGet.mockReset();
});

describe('LockedPreview — content', () => {
  it('renders title, oneLiner, and all bullets', async () => {
    await renderUI({ ...baseProps, requiredTier: 'pro' });

    expect(screen.getByRole('heading', { name: 'AI Bookings' })).toBeInTheDocument();
    expect(screen.getByText('Schedule appointments through chat.')).toBeInTheDocument();
    expect(screen.getByText('Bullet one')).toBeInTheDocument();
    expect(screen.getByText('Bullet two')).toBeInTheDocument();
    expect(screen.getByText('Bullet three')).toBeInTheDocument();
  });

  it("renders a PlanBadge for the requiredTier ('Pro')", async () => {
    await renderUI({ ...baseProps, requiredTier: 'pro' });
    // Multiple elements say "Pro" (badge + tier-strip plan name). Filter by
    // the PlanBadge's pill class to assert on the badge specifically.
    const pros = screen.getAllByText('Pro');
    expect(pros.some((el) => el.className.includes('rounded-full'))).toBe(true);
  });

  it("renders an Enterprise badge for requiredTier='enterprise'", async () => {
    await renderUI({ ...baseProps, requiredTier: 'enterprise' });
    const matches = screen.getAllByText('Enterprise');
    expect(matches.some((el) => el.className.includes('rounded-full'))).toBe(true);
  });
});

describe("LockedPreview — tier strip for requiredTier='pro'", () => {
  it('shows all of Your plan / Required / Trial / After trial / Cancel anytime', async () => {
    await renderUI({ ...baseProps, requiredTier: 'pro' });

    expect(screen.getByText('Your plan')).toBeInTheDocument();
    expect(screen.getByText('Required')).toBeInTheDocument();
    expect(screen.getByText('Trial')).toBeInTheDocument();
    expect(screen.getByText('14 days')).toBeInTheDocument();
    expect(screen.getByText('After trial')).toBeInTheDocument();
    expect(screen.getByText('€99.99/mo')).toBeInTheDocument();
    expect(screen.getByText(/Cancel anytime/i)).toBeInTheDocument();
  });
});

describe("LockedPreview — tier strip for requiredTier='enterprise'", () => {
  it('hides Pro-only copy: no 14-day trial, no €/mo pricing', async () => {
    await renderUI({ ...baseProps, requiredTier: 'enterprise' });

    // Header copy still present.
    expect(screen.getByText('Your plan')).toBeInTheDocument();
    expect(screen.getByText('Required')).toBeInTheDocument();
    // No Pro-only trial / pricing / cancel-anytime copy.
    expect(screen.queryByText('14 days')).not.toBeInTheDocument();
    expect(screen.queryByText(/€\d/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Cancel anytime/i)).not.toBeInTheDocument();
    // The Enterprise CTA is "Contact Sales".
    expect(screen.getByRole('link', { name: /contact sales/i })).toBeInTheDocument();
  });
});

describe('LockedPreview — comingSoon mode', () => {
  it('hides the tier strip, swaps the CTA, and badges as "Coming soon"', async () => {
    await renderUI({ ...baseProps, requiredTier: 'pro', comingSoon: true });

    // Tier strip is gone.
    expect(screen.queryByText('Your plan')).not.toBeInTheDocument();
    expect(screen.queryByText('Required')).not.toBeInTheDocument();
    expect(screen.queryByText('14 days')).not.toBeInTheDocument();

    // Badge now reads "Coming soon".
    expect(screen.getByText('Coming soon')).toBeInTheDocument();

    // Primary CTA is NotifyMeButton, not the UpgradeCTA "Start Pro trial".
    expect(screen.getByRole('button', { name: /notify me/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /start pro trial/i })).not.toBeInTheDocument();
  });
});

describe('LockedPreview — Compare plans secondary link', () => {
  it('routes to /settings/billing', async () => {
    await renderUI({ ...baseProps, requiredTier: 'pro' });
    const compare = screen.getByRole('link', { name: /compare plans/i });
    expect(compare).toHaveAttribute('href', '/settings/billing');
    // Sanity-check the parent contains it (placement under CTA block).
    expect(within(compare.closest('div') as HTMLElement).getByText(/compare plans/i)).toBeInTheDocument();
  });
});
