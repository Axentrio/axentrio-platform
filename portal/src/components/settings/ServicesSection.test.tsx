/**
 * P4b — the "Start from a preset" affordance in ServicesSection's empty state:
 * the button shows only when the catalog is empty, the dialog lists presets, and
 * Apply fires the apply endpoint.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const { apiGet, apiPost } = vi.hoisted(() => ({ apiGet: vi.fn(), apiPost: vi.fn() }));

vi.mock('../../services/apiClient', () => ({
  api: { get: apiGet, post: apiPost, put: vi.fn(), patch: vi.fn(), delete: vi.fn() },
  extractApiErrorMessage: () => undefined,
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

import { ServicesSection } from './ServicesSection';

function renderUI() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ServicesSection />
    </QueryClientProvider>,
  );
}

const PRESETS = {
  presets: [
    { key: 'barber', label: 'Barber', description: 'Haircuts.', serviceCount: 3 },
    { key: 'tutor', label: 'Tutor', description: 'Lessons.', serviceCount: 3 },
  ],
};

describe('ServicesSection — preset affordance (P4b)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('shows "Start from a preset" only when the catalog is empty', async () => {
    apiGet.mockImplementation((url: string) =>
      url.includes('/services') ? Promise.resolve({ services: [] }) : Promise.resolve(PRESETS),
    );
    renderUI();
    expect(await screen.findByRole('button', { name: /start from a preset/i })).toBeInTheDocument();
  });

  it('hides the preset button once services exist', async () => {
    apiGet.mockImplementation((url: string) =>
      url.includes('/services')
        ? Promise.resolve({ services: [{ id: 's1', name: 'Cut', bookingMode: 'auto', durationMin: 30, priceDisplayType: 'none', isActive: true, sortOrder: 0, onlineBookable: true, durationMode: 'fixed', bufferBeforeMin: 0, bufferAfterMin: 0, minNoticeMin: 0, maxHorizonDays: 60, locationType: 'custom' }] })
        : Promise.resolve(PRESETS),
    );
    renderUI();
    await screen.findByText('Cut');
    expect(screen.queryByRole('button', { name: /start from a preset/i })).not.toBeInTheDocument();
  });

  it('opens the dialog, lists presets, and Apply hits the apply endpoint', async () => {
    apiGet.mockImplementation((url: string) =>
      url.includes('/services') ? Promise.resolve({ services: [] }) : Promise.resolve(PRESETS),
    );
    apiPost.mockResolvedValue({ services: [] });
    renderUI();

    fireEvent.click(await screen.findByRole('button', { name: /start from a preset/i }));
    expect(await screen.findByText('Barber')).toBeInTheDocument();
    expect(screen.getByText('Tutor')).toBeInTheDocument();

    fireEvent.click(screen.getAllByRole('button', { name: /^apply$/i })[0]);
    await waitFor(() => expect(apiPost).toHaveBeenCalledWith('/scheduler/presets/barber/apply', {}));
  });
});
