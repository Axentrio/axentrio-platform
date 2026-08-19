import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import AdminLegalInvoices from './AdminLegalInvoices';

const retryOne = vi.fn();
const retryWaiting = vi.fn();

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock('../../queries/useAdminQueries', () => ({
  useAdminLegalInvoices: () => ({
    data: {
      attentionCount: 1,
      total: 1,
      invoices: [
        {
          id: 'li_1',
          tenantId: 'ten_1',
          tenantName: 'Example BV',
          documentKind: 'invoice',
          stripeInvoiceId: 'in_1',
          stripeRefundId: null,
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
  useRetryWaitingLegalInvoices: () => ({ mutate: retryWaiting, isPending: false }),
  useRetryLegalInvoice: () => ({ mutate: retryOne, isPending: false }),
}));

describe('AdminLegalInvoices', () => {
  it('shows a retryable Legal Invoice and retries it', () => {
    retryOne.mockClear();
    retryWaiting.mockClear();
    render(
      <MemoryRouter>
        <AdminLegalInvoices />
      </MemoryRouter>,
    );
    expect(screen.getByText('Example BV')).toBeInTheDocument();
    expect(screen.getByText('billit_http_error')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'admin.legalInvoices.retry' }));
    expect(retryOne).toHaveBeenCalledWith('li_1');
    fireEvent.click(screen.getByRole('button', { name: 'admin.legalInvoices.retryWaiting' }));
    expect(retryWaiting).toHaveBeenCalled();
  });

  it('marks the Legal Invoice from the mail link', () => {
    render(
      <MemoryRouter initialEntries={['/admin/legal-invoices?invoice=li_1']}>
        <AdminLegalInvoices />
      </MemoryRouter>,
    );
    expect(document.getElementById('legal-invoice-li_1')).toHaveAttribute('data-focused', 'true');
  });
});
