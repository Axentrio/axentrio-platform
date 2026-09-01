/**
 * SV — the customer reschedule/cancel selects an owner never opens.
 *
 * The whole point of the ticket is the value nobody chooses, so the assertion has to be on
 * what the dialog SHOWS, not on the form constant: an owner who adds a service and saves it
 * blind must give the AI approval rights, never an automatic move or cancellation.
 *
 * The edit case is the counterweight. A service already stored as `auto` must keep reading
 * "Allowed automatically", because the new standard applies to new services only.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Service } from '@/queries/useSchedulerQueries';

const { servicesState, mutation } = vi.hoisted(() => ({
  servicesState: { services: [] as unknown[] },
  mutation: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }),
}));

vi.mock('@/queries/useSchedulerQueries', () => ({
  useServices: () => ({ data: { services: servicesState.services }, isLoading: false, isSuccess: true }),
  useCreateService: mutation,
  useUpdateService: mutation,
  useDeleteService: mutation,
  useReorderServices: mutation,
  usePresets: () => ({ data: { presets: [] }, isLoading: false }),
  useApplyPreset: mutation,
}));

vi.mock('@/queries/useEntitlementsQueries', () => ({ useIsEntitled: () => true }));

import { ServicesSection } from './ServicesSection';

const STORED: Service = {
  id: 'svc-1',
  name: 'Boiler repair',
  bookingMode: 'auto',
  onlineBookable: true,
  durationMode: 'fixed',
  durationMin: 60,
  bufferBeforeMin: null,
  bufferAfterMin: null,
  minNoticeMin: null,
  maxHorizonDays: null,
  priceDisplayType: 'none',
  locationType: 'custom',
  sortOrder: 0,
  isActive: true,
};

/** The two policy selects, in dialog order: rescheduling then cancellation. */
function policySelects(): HTMLElement[] {
  const panel = screen.getByText('Customer reschedule and cancellation').closest('div');
  if (!panel) throw new Error('policy block not rendered');
  return within(panel as HTMLElement).getAllByRole('combobox');
}

describe('ServicesSection · customer change policy default', () => {
  beforeEach(() => {
    servicesState.services = [STORED];
  });

  it('opens a new service on Request approval for both actions', async () => {
    const user = userEvent.setup();
    render(<ServicesSection />);
    await user.click(screen.getByRole('button', { name: /add service/i }));

    const [reschedule, cancel] = policySelects();
    expect(reschedule).toHaveTextContent('Request approval');
    expect(cancel).toHaveTextContent('Request approval');
  });

  it('keeps a stored auto on the edit dialog, so existing services are untouched', async () => {
    servicesState.services = [{ ...STORED, rescheduleMode: 'auto', cancelMode: 'auto' }];
    const user = userEvent.setup();
    render(<ServicesSection />);
    await user.click(screen.getByRole('button', { name: /edit boiler repair/i }));

    const [reschedule, cancel] = policySelects();
    expect(reschedule).toHaveTextContent('Allowed automatically');
    expect(cancel).toHaveTextContent('Allowed automatically');
  });

  it('chips the exception, not the standard', () => {
    servicesState.services = [
      { ...STORED, rescheduleMode: 'request', cancelMode: 'request' },
      { ...STORED, id: 'svc-2', name: 'Emergency call', rescheduleMode: 'auto', cancelMode: 'not_allowed' },
    ];
    render(<ServicesSection />);
    expect(screen.queryByText('reschedule: request')).toBeNull();
    expect(screen.queryByText('cancel: request')).toBeNull();
    expect(screen.getByText('reschedule: auto')).toBeInTheDocument();
    expect(screen.getByText('cancel: not_allowed')).toBeInTheDocument();
  });
});
