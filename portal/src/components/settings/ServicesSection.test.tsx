/**
 * P4b — the "Start from a preset" affordance in ServicesSection's empty state:
 * the button shows only when the catalog is empty, the dialog lists presets, and
 * Apply fires the apply endpoint.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const { apiGet, apiPost, apiPut } = vi.hoisted(() => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  apiPut: vi.fn(),
}));

vi.mock('../../services/apiClient', () => ({
  api: { get: apiGet, post: apiPost, put: apiPut, patch: vi.fn(), delete: vi.fn() },
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

/**
 * `onlineBookable` was in the API schema with `default(true)` but nowhere in the portal
 * form — not in the state, not in the payload, not on screen. So the default always won and
 * every service the portal created was self-bookable, with no way to say otherwise. It
 * matters because the prompt catalog and `resolveService` both filter on it: a service the
 * owner wanted quoted by phone first could not be expressed at all.
 */
describe('ServicesSection — online bookable', () => {
  beforeEach(() => vi.clearAllMocks());

  const openNew = async () => {
    apiGet.mockImplementation((url: string) =>
      url.includes('/services') ? Promise.resolve({ services: [] }) : Promise.resolve({ presets: [] }),
    );
    renderUI();
    fireEvent.click(await screen.findByRole('button', { name: /add service/i }));
    return await screen.findByLabelText(/customers can book this online/i);
  };

  const submit = async () => {
    fireEvent.change(screen.getByPlaceholderText(/haircut/i), { target: { value: 'Bespoke quote' } });
    const dialog = screen.getByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: /add service/i }));
    await waitFor(() => expect(apiPost).toHaveBeenCalled());
    return apiPost.mock.calls[0][1] as Record<string, unknown>;
  };

  it('defaults a new service to bookable', async () => {
    const box = await openNew();
    expect(box).toBeChecked();
    expect(await submit()).toMatchObject({ onlineBookable: true });
  });

  it('sends false once the owner turns it off', async () => {
    const box = await openNew();
    fireEvent.click(box);
    expect(await submit()).toMatchObject({ onlineBookable: false });
  });

  const listWith = (over: Record<string, unknown>) => {
    apiGet.mockImplementation((url: string) =>
      url.includes('/services')
        ? Promise.resolve({
            services: [{
              id: 's1', name: 'Quote first', bookingMode: 'auto', durationMin: 30,
              priceDisplayType: 'none', isActive: true, sortOrder: 0, onlineBookable: true,
              durationMode: 'fixed', bufferBeforeMin: 0, bufferAfterMin: 0, minNoticeMin: 0,
              maxHorizonDays: 60, locationType: 'custom', ...over,
            }],
          })
        : Promise.resolve({ presets: [] }),
    );
    renderUI();
  };

  it('marks a service that customers cannot book online', async () => {
    // Without this the switch had no visible effect at all: an owner unticks it, saves, and
    // the row looks exactly as it did before.
    listWith({ onlineBookable: false });
    expect(await screen.findByText(/not bookable online/i)).toBeInTheDocument();
  });

  it('drops the auto-book badge for it — "auto-book" would be untrue', async () => {
    listWith({ onlineBookable: false });
    await screen.findByText(/not bookable online/i);
    expect(screen.queryByText('auto-book')).not.toBeInTheDocument();
  });

  it('leaves a normal service’s badge alone', async () => {
    listWith({});
    expect(await screen.findByText('auto-book')).toBeInTheDocument();
    expect(screen.queryByText(/not bookable online/i)).not.toBeInTheDocument();
  });

  it('does not stack two muted markers on an inactive service', async () => {
    listWith({ isActive: false, onlineBookable: false });
    expect(await screen.findByText(/\(inactive\)/i)).toBeInTheDocument();
    expect(screen.queryByText(/not bookable online/i)).not.toBeInTheDocument();
  });

  it('hydrates an existing non-bookable service as off', async () => {
    // Editing a service must not silently switch it back on.
    apiGet.mockImplementation((url: string) =>
      url.includes('/services')
        ? Promise.resolve({
            services: [{
              id: 's1', name: 'Quote first', bookingMode: 'auto', durationMin: 30,
              priceDisplayType: 'none', isActive: true, sortOrder: 0, onlineBookable: false,
              durationMode: 'fixed', bufferBeforeMin: 0, bufferAfterMin: 0, minNoticeMin: 0,
              maxHorizonDays: 60, locationType: 'custom',
            }],
          })
        : Promise.resolve({ presets: [] }),
    );
    renderUI();
    fireEvent.click(await screen.findByRole('button', { name: /edit quote first/i }));
    expect(await screen.findByLabelText(/customers can book this online/i)).not.toBeChecked();
  });
});

/**
 * Intake question authoring.
 *
 * Owners had label/type/required/options and nothing else, so they smuggled instructions
 * into the label text ("What floor? (only ask if it's a flat)") — which the customer then
 * read verbatim. These four fields give that intent somewhere honest to live, and the
 * ordering is done by MOVING the array element rather than storing a sort index, because
 * array position already is the order everywhere downstream.
 */
describe('ServicesSection — intake question authoring', () => {
  beforeEach(() => vi.clearAllMocks());

  const openWithQuestion = async () => {
    apiGet.mockImplementation((url: string) =>
      url.includes('/services') ? Promise.resolve({ services: [] }) : Promise.resolve({ presets: [] }),
    );
    renderUI();
    fireEvent.click(await screen.findByRole('button', { name: /add service/i }));
    fireEvent.change(screen.getByPlaceholderText(/haircut/i), { target: { value: 'Repair' } });
    fireEvent.click(screen.getByRole('button', { name: /add question/i }));
    return screen.getByRole('dialog');
  };

  const save = async (dialog: HTMLElement) => {
    fireEvent.click(within(dialog).getByRole('button', { name: /add service/i }));
    await waitFor(() => expect(apiPost).toHaveBeenCalled());
    return (apiPost.mock.calls[0][1] as { intakeQuestions?: Array<Record<string, unknown>> }).intakeQuestions!;
  };

  it('sends the owner’s steer and example answer', async () => {
    const dialog = await openWithQuestion();
    fireEvent.change(within(dialog).getByPlaceholderText(/question \(e\.g/i), { target: { value: 'Which floor?' } });
    fireEvent.change(within(dialog).getByPlaceholderText(/how to ask/i), { target: { value: 'Only if it is a flat' } });
    fireEvent.change(within(dialog).getByPlaceholderText(/example answer/i), { target: { value: 'Second' } });
    const qs = await save(dialog);
    expect(qs[0]).toMatchObject({
      label: 'Which floor?',
      aiInstruction: 'Only if it is a flat',
      exampleAnswer: 'Second',
    });
  });

  it('defaults a new question to asked and shown on the calendar', async () => {
    // Absent means true for both, so a new question must not carry either key — writing
    // them would add noise to every row for no change in meaning.
    const dialog = await openWithQuestion();
    fireEvent.change(within(dialog).getByPlaceholderText(/question \(e\.g/i), { target: { value: 'Which floor?' } });
    const qs = await save(dialog);
    expect(qs[0].active).toBeUndefined();
    expect(qs[0].includeInCalendar).toBeUndefined();
  });

  it('sends an explicit false once either is switched off', async () => {
    const dialog = await openWithQuestion();
    fireEvent.change(within(dialog).getByPlaceholderText(/question \(e\.g/i), { target: { value: 'Which floor?' } });
    fireEvent.click(within(dialog).getByLabelText(/ask this/i));
    fireEvent.click(within(dialog).getByLabelText(/show on my calendar/i));
    const qs = await save(dialog);
    expect(qs[0]).toMatchObject({ active: false, includeInCalendar: false });
  });

  it('reorders by moving the array element, with no sort index', async () => {
    const dialog = await openWithQuestion();
    fireEvent.change(within(dialog).getByPlaceholderText(/question \(e\.g/i), { target: { value: 'First' } });
    fireEvent.click(within(dialog).getByRole('button', { name: /add question/i }));
    const labels = within(dialog).getAllByPlaceholderText(/question \(e\.g/i);
    fireEvent.change(labels[1], { target: { value: 'Second' } });

    fireEvent.click(within(dialog).getByRole('button', { name: /move question 2 up/i }));
    const qs = await save(dialog);
    expect(qs.map((q) => q.label)).toEqual(['Second', 'First']);
    // Position IS the order — a sortOrder field would be a second source of truth.
    expect(qs[0]).not.toHaveProperty('sortOrder');
  });

  it('cannot move the first question up or the last one down', async () => {
    const dialog = await openWithQuestion();
    expect(within(dialog).getByRole('button', { name: /move question 1 up/i })).toBeDisabled();
    expect(within(dialog).getByRole('button', { name: /move question 1 down/i })).toBeDisabled();
  });
});

/**
 * Catalog order.
 *
 * Every service is created at sortOrder 0, and three of the queries that order by it had no
 * tiebreak — so the order the assistant read services out in was whatever Postgres returned,
 * free to differ between runs, while the portal showed a stable one. The owner arranged
 * their catalog and the customer heard something else.
 */
describe('ServicesSection — catalog order', () => {
  beforeEach(() => vi.clearAllMocks());

  const three = () => {
    apiGet.mockImplementation((url: string) =>
      url.includes('/services')
        ? Promise.resolve({
            services: ['Cut', 'Colour', 'Beard'].map((name, i) => ({
              id: `s${i + 1}`, name, bookingMode: 'auto', durationMin: 30,
              priceDisplayType: 'none', isActive: true, sortOrder: i, onlineBookable: true,
              durationMode: 'fixed', bufferBeforeMin: 0, bufferAfterMin: 0, minNoticeMin: 0,
              maxHorizonDays: 60, locationType: 'custom',
            })),
          })
        : Promise.resolve({ presets: [] }),
    );
    renderUI();
  };

  it('sends the WHOLE resulting order, not a move instruction', async () => {
    // The server assigns positions from the array, so the client never invents sortOrder
    // numbers and what is stored cannot disagree with what the owner just saw.
    three();
    fireEvent.click(await screen.findByRole('button', { name: /move colour up/i }));
    await waitFor(() => expect(apiPut).toHaveBeenCalled());
    expect(apiPut.mock.calls[0][0]).toContain('/services/reorder');
    expect(apiPut.mock.calls[0][1]).toEqual({ serviceIds: ['s2', 's1', 's3'] });
  });

  it('moves a service down', async () => {
    three();
    fireEvent.click(await screen.findByRole('button', { name: /move cut down/i }));
    await waitFor(() => expect(apiPut).toHaveBeenCalled());
    expect(apiPut.mock.calls[0][1]).toEqual({ serviceIds: ['s2', 's1', 's3'] });
  });

  it('cannot move the first one up or the last one down', async () => {
    three();
    expect(await screen.findByRole('button', { name: /move cut up/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /move beard down/i })).toBeDisabled();
  });
});
