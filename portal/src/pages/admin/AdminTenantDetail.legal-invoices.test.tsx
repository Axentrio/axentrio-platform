import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import AdminTenantDetail from './AdminTenantDetail';

const retry = vi.fn();

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

vi.mock('../../components/admin/TenantEntitlementsPanel', () => ({
  TenantEntitlementsPanel: () => null,
}));

vi.mock('../../queries/useAdminQueries', () => ({
  useAdminTenantDetail: () => ({
    data: {
      id: 'ten_1',
      name: 'Example BV',
      slug: 'example-bv',
      tier: 'pro',
      status: 'active',
      apiKeyMasked: 'ak_****1234',
      createdAt: '2026-05-01T00:00:00.000Z',
      userCount: 1,
      sessionCount: 0,
      messageCount: 0,
      users: [],
      pendingInvites: [],
      recentAuditLogs: [],
      legalInvoices: [
        {
          id: 'li_1',
          documentKind: 'invoice',
          stripeInvoiceId: 'in_1',
          billitInvoiceNumber: null,
          paymentStatus: 'paid',
          invoiceStatus: 'failed',
          peppolStatus: 'pending',
          lastError: 'billit_http_error',
          retryable: true,
          amountInclCents: 9074,
          currency: 'EUR',
          createdAt: '2026-05-01T00:00:00.000Z',
        },
      ],
    },
    isLoading: false,
    isError: false,
  }),
  useAdminTenantAudit: () => ({ data: [] }),
  useOptimisticSuspendTenant: () => ({ mutate: vi.fn(), isPending: false }),
  useOptimisticActivateTenant: () => ({ mutate: vi.fn(), isPending: false }),
  useAdminInviteMember: () => ({ mutate: vi.fn(), isPending: false }),
  useAdminResendInvite: () => ({ mutate: vi.fn(), isPending: false }),
  useAdminCancelInvite: () => ({ mutate: vi.fn(), isPending: false }),
  useSetTenantTier: () => ({ mutate: vi.fn(), isPending: false }),
  useRetryLegalInvoice: () => ({ mutate: retry, isPending: false }),
}));

describe('AdminTenantDetail legal invoices', () => {
  it('shows the failed Legal Invoice and retries it', () => {
    retry.mockClear();
    render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter initialEntries={['/admin/tenants/ten_1']}>
          <Routes>
            <Route path="/admin/tenants/:id" element={<AdminTenantDetail />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(screen.getByText('in_1')).toBeInTheDocument();
    expect(screen.getByText('billit_http_error')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'admin.tenantDetail.legalInvoices.retry' }));
    expect(retry).toHaveBeenCalledWith('li_1');
  });
});
