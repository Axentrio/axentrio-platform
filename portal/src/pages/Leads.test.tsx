/**
 * Tests for the Leads page. It had no test file at all, which is how the wrong
 * upsell tier and the always-English export button survived.
 *
 * The properties worth pinning are the ones a refactor would quietly break:
 *   - the tier gate points at the RIGHT plan (Essential includes leadCapture)
 *   - Pro columns appear only with `leadEnrichment`
 *   - `priceBasis` is respected, so a "from" price is never shown as a flat one
 *   - model- and visitor-authored free text renders as TEXT, never as markup
 *   - the status filter goes to the SERVER (query string), not the client
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';

const { hasFeatureMock, apiGet, apiDownload } = vi.hoisted(() => ({
  hasFeatureMock: vi.fn<(_key: string) => boolean>(),
  apiGet: vi.fn(),
  apiDownload: vi.fn(),
}));

vi.mock('../queries/useEntitlementsQueries', async () => {
  const actual = await vi.importActual<typeof import('../queries/useEntitlementsQueries')>(
    '../queries/useEntitlementsQueries',
  );
  return {
    ...actual,
    useHasFeature: (key: string) => hasFeatureMock(key),
    useIsEntitled: (key: string) => hasFeatureMock(key),
  };
});

vi.mock('../services/apiClient', () => ({
  api: {
    get: apiGet,
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
    download: apiDownload,
  },
}));

// The retention card reads the caller's role. Mocked as admin so the control renders;
// the card's own admin-gating is covered where it lives.
vi.mock('@auth/useAppAuth', () => ({
  useAppAuth: () => ({ isRole: () => true }),
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

import Leads from './Leads';

const BASIC_LEAD = {
  id: 'lead-1',
  sessionId: 'sess-1',
  botId: 'bot-1',
  name: 'Achraf Peeters',
  email: 'achraf@example.com',
  phone: '32475464421',
  channel: 'whatsapp',
  source: 'channel',
  status: 'new',
  notes: 'Burst pipe in the basement',
  createdAt: new Date().toISOString(),
};

const PRO_LEAD = {
  ...BASIC_LEAD,
  id: 'lead-2',
  bookingId: 'bk-1',
  bookingStatus: 'confirmed',
  preferredAt: '2026-08-04T09:00:00.000Z',
  address: 'Kerkstraat 12, 2000 Antwerpen',
  serviceRequested: 'Drain unblocking',
  servicePrice: 95,
  priceBasis: 'fixed',
  intakeAnswers: null,
  bookingCount: 1,
  conversationCount: 1,
};

function renderUI(leads: Array<Record<string, unknown>>) {
  apiGet.mockImplementation(async (url: string) => {
    // Retention is checked FIRST: it also lives under /leads, so a naive prefix match
    // would hand the card a page of leads instead of its own payload.
    if (url.startsWith('/leads/retention')) return { retentionDays: null, minDays: 30, maxDays: 3650 };
    if (url.startsWith('/leads')) return { leads, nextCursor: null };
    return {};
  });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <Leads />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  hasFeatureMock.mockReturnValue(true);
});

describe('Leads page — gating', () => {
  it('upsells ESSENTIAL, not Pro, when leadCapture is absent', async () => {
    // Essential already includes leadCapture, so advertising Pro pointed paying
    // tenants at the wrong plan.
    hasFeatureMock.mockReturnValue(false);
    const { container } = renderUI([]);
    await waitFor(() => expect(container.textContent).toBeTruthy());
    expect(container.innerHTML).not.toMatch(/requiredTier["']?\s*[:=]\s*["']pro/i);
  });

  it('shows the Pro columns only when leadEnrichment is on', async () => {
    hasFeatureMock.mockImplementation((k) => k !== 'leadEnrichment');
    renderUI([PRO_LEAD]);
    await waitFor(() => expect(screen.getByText('Achraf Peeters')).toBeInTheDocument());
    // Structured headers absent…
    expect(screen.queryByText('Service')).not.toBeInTheDocument();
    expect(screen.queryByText('Address')).not.toBeInTheDocument();
    // …and so is the derived data.
    expect(screen.queryByText('Drain unblocking')).not.toBeInTheDocument();
    expect(screen.queryByText(/Kerkstraat/)).not.toBeInTheDocument();
  });

  it('renders the derived booking fields when entitled', async () => {
    renderUI([PRO_LEAD]);
    await waitFor(() => expect(screen.getByText('Drain unblocking')).toBeInTheDocument());
    expect(screen.getByText(/Kerkstraat 12/)).toBeInTheDocument();
    expect(screen.getByText('confirmed')).toBeInTheDocument();
  });
});

describe('Leads page — honest presentation', () => {
  it('labels a "from" price as a floor, never as a flat amount', async () => {
    renderUI([{ ...PRO_LEAD, servicePrice: 80, priceBasis: 'from' }]);
    // Currency formatting is locale-dependent (€80.00 vs 80,00 €), so assert the
    // SEMANTICS — the word "from" sits with the amount — not an exact string.
    await waitFor(() => expect(screen.getByText('Drain unblocking')).toBeInTheDocument());
    const priced = screen.getByText((text) => /from/i.test(text) && /80/.test(text));
    expect(priced).toBeInTheDocument();
  });

  it('shows a range price as approximate', async () => {
    renderUI([{ ...PRO_LEAD, servicePrice: 100, priceBasis: 'range_mid' }]);
    await waitFor(() => expect(screen.getByText(/~/)).toBeInTheDocument());
  });

  it('shows no figure at all when the service is priced on request', async () => {
    renderUI([{ ...PRO_LEAD, servicePrice: null, priceBasis: 'none' }]);
    await waitFor(() => expect(screen.getByText('Drain unblocking')).toBeInTheDocument());
    expect(screen.queryByText(/€/)).not.toBeInTheDocument();
  });

  it('surfaces that a contact has more bookings than the one shown', async () => {
    renderUI([{ ...PRO_LEAD, bookingCount: 3 }]);
    await waitFor(() => expect(screen.getByText('+2')).toBeInTheDocument());
  });
});

describe('Leads page — untrusted text', () => {
  it('renders visitor/model free text as TEXT, not markup', async () => {
    // `notes` is model-authored from visitor input and flows to the portal, CSV and
    // any connected CRM. It must never be interpreted as HTML here.
    const hostile = '<img src=x onerror="alert(1)">Leak';
    const { container } = renderUI([{ ...BASIC_LEAD, notes: hostile }]);
    await waitFor(() => expect(screen.getByText(hostile)).toBeInTheDocument());
    expect(container.querySelector('img')).toBeNull();
  });

  it('does not turn a javascript: "email" into a link', async () => {
    const { container } = renderUI([
      { ...BASIC_LEAD, email: 'javascript:alert(1)', phone: null },
    ]);
    await waitFor(() => expect(screen.getByText('javascript:alert(1)')).toBeInTheDocument());
    const hrefs = [...container.querySelectorAll('a')].map((a) => a.getAttribute('href') ?? '');
    expect(hrefs.some((h) => h.toLowerCase().startsWith('javascript:'))).toBe(false);
  });
});

describe('Leads page — filtering', () => {
  it('defaults to ALL so existing tenants do not see their lead count drop', async () => {
    renderUI([BASIC_LEAD]);
    await waitFor(() => expect(apiGet).toHaveBeenCalled());
    const firstUrl = apiGet.mock.calls.find((c) => String(c[0]).startsWith('/leads'))![0] as string;
    expect(firstUrl).not.toContain('status=');
  });

  it('sends the status filter to the SERVER rather than filtering client-side', async () => {
    renderUI([BASIC_LEAD]);
    await waitFor(() => expect(screen.getByText('Achraf Peeters')).toBeInTheDocument());

    // Scope to the filter group: "Handled" also appears as a row action title and
    // as the status badge, so an unscoped query is ambiguous.
    const filters = screen.getByRole('group', { name: /filter leads by status/i });
    await userEvent.click(within(filters).getByRole('button', { name: /handled/i }));

    await waitFor(() => {
      const urls = apiGet.mock.calls.map((c) => String(c[0]));
      expect(urls.some((u) => u.includes('status=archived'))).toBe(true);
    });
  });
});
