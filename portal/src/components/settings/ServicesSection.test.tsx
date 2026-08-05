/**
 * P4b — the "Start from a preset" affordance in ServicesSection's empty state:
 * the button shows only when the catalog is empty, the dialog lists presets, and
 * Apply fires the apply endpoint.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
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

/**
 * `locationType` is stored, is read by the booking engine, the invite and the calendar
 * mirror — and had no control at all, so every service an owner created by hand was stuck on
 * `'custom'`. The consequences were invisible and expensive: an online consultation never got
 * a meeting link, and an at-premises job never showed the business address on the invite,
 * which made the venue feature look broken.
 */
describe('ServicesSection — where does it happen?', () => {
  beforeEach(() => vi.clearAllMocks());

  const openNew = async () => {
    apiGet.mockImplementation((url: string) =>
      url.includes('/services') ? Promise.resolve({ services: [] }) : Promise.resolve({ presets: [] }),
    );
    renderUI();
    fireEvent.click(await screen.findByRole('button', { name: /add service/i }));
    return (await screen.findByLabelText(/where does it happen/i)) as HTMLSelectElement;
  };

  it('offers every location type the engine understands', async () => {
    const select = await openNew();
    const values = [...select.options].map((o) => o.value).sort();
    // Exactly the LocationType union — a value here the API rejects, or one missing that it
    // accepts, is how the two drift apart.
    expect(values).toEqual(['custom', 'google_meet', 'in_person', 'phone']);
  });

  it('sends the chosen type when the service is saved', async () => {
    const select = await openNew();
    fireEvent.change(select, { target: { value: 'google_meet' } });
    // The name input has no htmlFor binding; its placeholder is the stable handle.
    fireEvent.change(screen.getByPlaceholderText(/haircut/i), { target: { value: 'Video consult' } });
    // The dialog's submit button reads "Add service" too — the same text as the trigger
    // that opened it — so this must be scoped or it matches two elements.
    const dialog = screen.getByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: /add service/i }));
    await waitFor(() => expect(apiPost).toHaveBeenCalled());
    expect(apiPost.mock.calls[0][1]).toMatchObject({ locationType: 'google_meet' });
  });

  it('explains what each choice actually does', async () => {
    // The two consequences an owner cannot otherwise discover: a video call mints a link,
    // and an at-premises job needs a venue address set elsewhere.
    const select = await openNew();
    fireEvent.change(select, { target: { value: 'google_meet' } });
    expect(await screen.findByText(/video link is generated/i)).toBeInTheDocument();
    fireEvent.change(select, { target: { value: 'in_person' } });
    expect(await screen.findByText(/your address goes on the invite/i)).toBeInTheDocument();
  });
});
