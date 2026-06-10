/**
 * Tests for the entitlement-aware Sidebar (M2, subscription/feature-access
 * epic). Covers the eight epic-mandated menu items and the locked/unlocked
 * states wired through `useHasFeature`.
 *
 * We mock the React Query hook so we can flip "has bookings" without spinning
 * up a real query client. All other Sidebar dependencies (Clerk, stores,
 * handoffs query) are stubbed to safe defaults — this file is about the nav
 * gating, not the user/tenant chrome.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

type UserRole = 'super_admin' | 'admin' | 'supervisor' | 'agent';

// --- hoisted mocks ---------------------------------------------------------

const { hasFeatureMock, userRef } = vi.hoisted(() => ({
  hasFeatureMock: vi.fn<(_key: string) => boolean>(),
  userRef: { current: { firstName: 'X', lastName: 'Y', role: 'admin' as UserRole } },
}));

vi.mock('../queries/useEntitlementsQueries', () => ({
  useHasFeature: (key: string) => hasFeatureMock(key),
}));

vi.mock('../queries/useHandoffQueries', () => ({
  useHandoffsQuery: () => ({ pendingCount: 0 }),
}));

vi.mock('@clerk/clerk-react', () => ({
  useClerk: () => ({ signOut: vi.fn() }),
  useOrganization: () => ({ organization: { name: 'Acme', hasImage: false } }),
  useOrganizationList: () => ({ isLoaded: true, userMemberships: { data: [] }, setActive: vi.fn() }),
}));

vi.mock('@auth/useAppAuth', () => ({
  useAppAuth: () => ({ user: userRef.current }),
}));

vi.mock('../stores/tenantContextStore', () => ({
  useTenantContextStore: () => ({ activeTenant: null }),
}));

vi.mock('../stores/uiStore', () => ({
  useUiStore: () => ({ openTenantPalette: vi.fn() }),
}));

vi.mock('../hooks/useTenantSwitch', () => ({
  useTenantSwitch: () => ({ exitTenant: vi.fn() }),
}));

import { Sidebar } from './Sidebar';

function renderSidebar() {
  return render(
    <MemoryRouter>
      <Sidebar />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  hasFeatureMock.mockReset();
  userRef.current = { firstName: 'X', lastName: 'Y', role: 'admin' };
});

describe('Sidebar — menu structure', () => {
  it('renders all 8 epic-mandated menu items', () => {
    // Default: every feature flag returns true — Bookings is unlocked.
    hasFeatureMock.mockReturnValue(true);
    renderSidebar();

    // Six items navigate via NavLink role=link; "Settings" matches a button
    // for org-switching too, so use the link role to disambiguate.
    expect(screen.getByRole('link', { name: /inbox/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /ai bot & content/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /social media/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /lead capture/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /^bookings/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /success meter/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /^settings/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /help & faq/i })).toBeInTheDocument();
  });
});

describe('Sidebar — Essential tenant (no bookings entitlement)', () => {
  it('renders the Bookings entry with a Pro PlanBadge and lock icon, still navigable', () => {
    // Only 'bookings' is missing; everything else is enabled.
    hasFeatureMock.mockImplementation((key) => key !== 'bookings');
    renderSidebar();

    const bookingsLink = screen.getByRole('link', { name: /bookings/i });
    expect(bookingsLink).toBeInTheDocument();
    // Stays a NavLink (still navigable) and points at /bookings.
    expect(bookingsLink).toHaveAttribute('href', '/bookings');

    // The "Pro" PlanBadge renders inside the bookings entry.
    expect(within(bookingsLink).getByText('Pro')).toBeInTheDocument();
    // The lock indicator (rendered via lucide-react <Lock>) carries the
    // `lucide-lock` class — sanity-check it exists inside this entry.
    expect(bookingsLink.querySelector('.lucide-lock')).not.toBeNull();
  });
});

describe('Sidebar — Pro tenant', () => {
  it('renders the Bookings entry WITHOUT lock icon or badge', () => {
    hasFeatureMock.mockReturnValue(true);
    renderSidebar();

    const bookingsLink = screen.getByRole('link', { name: /bookings/i });
    // No Pro badge inside the bookings entry (the badge only renders when locked).
    expect(within(bookingsLink).queryByText('Pro')).not.toBeInTheDocument();
    // No lock icon either.
    expect(bookingsLink.querySelector('.lucide-lock')).toBeNull();
  });
});

describe('Sidebar — fail-closed during loading', () => {
  it('shows the locked treatment when useHasFeature returns false (the loading default)', () => {
    // Per the SDK contract: `useHasFeature` returns false during loading.
    // The Sidebar must therefore render the locked indicator for gated items
    // until the query resolves — fail-closed behaviour.
    hasFeatureMock.mockReturnValue(false);
    renderSidebar();

    const bookingsLink = screen.getByRole('link', { name: /bookings/i });
    expect(within(bookingsLink).getByText('Pro')).toBeInTheDocument();
    expect(bookingsLink.querySelector('.lucide-lock')).not.toBeNull();
  });
});

describe('Sidebar — admin sub-menu visibility', () => {
  it('renders the admin sub-menu for super_admin', () => {
    userRef.current = { firstName: 'X', lastName: 'Y', role: 'super_admin' };
    hasFeatureMock.mockReturnValue(true);
    renderSidebar();

    // "Super Admin" appears twice (group header + user-role label). Assert at
    // least one match exists, and verify the admin links specifically.
    expect(screen.getAllByText(/super admin/i).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByRole('link', { name: /all tenants/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /all users/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /platform analytics/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /faq editor/i })).toBeInTheDocument();
  });

  it('does NOT render the admin sub-menu for a non-admin role', () => {
    userRef.current = { firstName: 'X', lastName: 'Y', role: 'agent' };
    hasFeatureMock.mockReturnValue(true);
    renderSidebar();

    // No admin links are present for a non-admin role. The "Super Admin"
    // group header would only render when admin items pass the role filter.
    expect(screen.queryByRole('link', { name: /all tenants/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /platform analytics/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /faq editor/i })).not.toBeInTheDocument();
  });
});
