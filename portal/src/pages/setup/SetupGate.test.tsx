/**
 * The setup gate.
 *
 * This is the component that can lock a paying customer out of a product they are
 * already using, so its failure modes get more attention than its happy path:
 * a broken status call, a grandfathered workspace, a super admin working inside
 * someone else's tenant, and a team member who cannot answer the wizard anyway.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const { apiGet } = vi.hoisted(() => ({ apiGet: vi.fn() }));
vi.mock('@/services/apiClient', () => ({
  api: { get: apiGet, post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));

const { authState } = vi.hoisted(() => ({ authState: { role: 'admin' as string } }));
vi.mock('@auth/useAppAuth', () => ({
  useAppAuth: () => ({ user: { role: authState.role } }),
}));

const { tenantState } = vi.hoisted(() => ({
  tenantState: { activeTenant: null as { tenantId: string; tenantName: string } | null },
}));
vi.mock('@/stores/tenantContextStore', () => ({
  useTenantContextStore: (sel?: (s: { activeTenant: typeof tenantState.activeTenant }) => unknown) => {
    const state = { activeTenant: tenantState.activeTenant };
    return sel ? sel(state) : state;
  },
}));

// The wizard itself is exercised separately; here it is only a marker for "gate closed".
vi.mock('./SetupWizard', () => ({ default: () => <div>WIZARD</div> }));

import { SetupGate } from './SetupGate';

function renderGate() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <SetupGate>
        <div>PRODUCT</div>
      </SetupGate>
    </QueryClientProvider>,
  );
}

const incomplete = { state: { steps: {} }, nextStep: 'language', complete: false };
const complete = { state: { steps: {} }, nextStep: null, complete: true };

beforeEach(() => {
  apiGet.mockReset();
  authState.role = 'admin';
  tenantState.activeTenant = null;
});

describe('SetupGate', () => {
  it('shows the wizard to an admin whose setup is unfinished', async () => {
    apiGet.mockResolvedValue(incomplete);
    renderGate();
    expect(await screen.findByText('WIZARD')).toBeInTheDocument();
  });

  it('lets a finished workspace straight through', async () => {
    apiGet.mockResolvedValue(complete);
    renderGate();
    expect(await screen.findByText('PRODUCT')).toBeInTheDocument();
  });

  it('opens when the status call fails', async () => {
    // A customer locked out of the product they pay for is a far worse failure than
    // one who skipped a wizard, so only a definite "not finished" closes the gate.
    apiGet.mockRejectedValue(new Error('500'));
    renderGate();
    expect(await screen.findByText('PRODUCT')).toBeInTheDocument();
  });

  it('lets a super admin through a finished workspace', async () => {
    authState.role = 'super_admin';
    apiGet.mockResolvedValue(complete);
    renderGate();
    expect(await screen.findByText('PRODUCT')).toBeInTheDocument();
    expect(screen.queryByText('WIZARD')).not.toBeInTheDocument();
  });

  it('shows the wizard when a super admin is in an unfinished workspace', async () => {
    authState.role = 'super_admin';
    apiGet.mockResolvedValue(incomplete);
    renderGate();
    expect(await screen.findByText('WIZARD')).toBeInTheDocument();
  });

  it('tells a non-admin who has to finish, instead of handing them a wizard', async () => {
    // Only admins can write setup. Showing an agent a form that will refuse every
    // submission is a dead end.
    authState.role = 'agent';
    apiGet.mockResolvedValue(incomplete);
    renderGate();
    expect(await screen.findByText(/administrator/i)).toBeInTheDocument();
    expect(screen.queryByText('WIZARD')).not.toBeInTheDocument();
    expect(screen.queryByText('PRODUCT')).not.toBeInTheDocument();
  });
});
