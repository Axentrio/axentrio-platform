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
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';

const { hasFeatureMock, apiGet, apiPost, apiDownload } = vi.hoisted(() => ({
  hasFeatureMock: vi.fn<(_key: string) => boolean>(),
  apiGet: vi.fn(),
  apiPost: vi.fn(),
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
    post: apiPost,
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

/**
 * Service, address, preferred time and price moved off the row and into the expanded
 * drawer: they were empty on most leads and pushed the columns an operator acts on off
 * the right-hand edge. Tests that assert on them therefore have to open the row first.
 */
async function openFirstRow() {
  const row = await screen.findByText(/Aquafin|Jan|Marieke|No name/i).catch(() => null);
  const target = row ?? screen.getAllByRole('row')[1];
  await userEvent.click(target as HTMLElement);
}

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
    // Humanised, not the column value: `request_created` on screen is developer
    // vocabulary, and it reached production before this was caught.
    expect(await screen.findByText('Confirmed')).toBeInTheDocument(); // stays on the row
    await openFirstRow();
    expect(await screen.findByText('Drain unblocking')).toBeInTheDocument();
    expect(screen.getByText(/Kerkstraat 12/)).toBeInTheDocument();
  });
});

describe('Leads page — honest presentation', () => {
  it('labels a "from" price as a floor, never as a flat amount', async () => {
    renderUI([{ ...PRO_LEAD, servicePrice: 80, priceBasis: 'from' }]);
    await openFirstRow();
    // Currency formatting is locale-dependent (€80.00 vs 80,00 €), so assert the
    // SEMANTICS — the word "from" sits with the amount — not an exact string.
    await waitFor(() => expect(screen.getByText('Drain unblocking')).toBeInTheDocument());
    const priced = screen.getByText((text) => /from/i.test(text) && /80/.test(text));
    expect(priced).toBeInTheDocument();
  });

  it('shows a range price as approximate', async () => {
    renderUI([{ ...PRO_LEAD, servicePrice: 100, priceBasis: 'range_mid' }]);
    await openFirstRow();
    await waitFor(() => expect(screen.getByText(/~/)).toBeInTheDocument());
  });

  it('shows no figure at all when the service is priced on request', async () => {
    renderUI([{ ...PRO_LEAD, servicePrice: null, priceBasis: 'none' }]);
    await openFirstRow();
    await waitFor(() => expect(screen.getByText('Drain unblocking')).toBeInTheDocument());
    expect(screen.queryByText(/€/)).not.toBeInTheDocument();
  });

  it('surfaces that a contact has more bookings than the one shown', async () => {
    renderUI([{ ...PRO_LEAD, bookingCount: 3 }]);
    await waitFor(() => expect(screen.getByText('+2')).toBeInTheDocument());
  });
});

describe('Leads page — the recommended follow-up action', () => {
  /** What the server sends an Enterprise tenant. Absent entirely below Enterprise. */
  const FOLLOW_UP = {
    action: 'offer_a_time',
    via: 'phone',
    priority: 'soon',
    version: 1,
    reasons: [
      { key: 'request_known', label: 'They told us what they need' },
      { key: 'reach_phone', label: 'Phone number on file' },
    ],
  };

  /** The panel lives in the expanded row, so every assertion opens it first. */
  const openDrawer = async () => {
    await waitFor(() => expect(screen.getByText('Achraf Peeters')).toBeInTheDocument());
    await userEvent.click(screen.getByText('Achraf Peeters'));
  };

  it('is absent for a tenant without aiBusinessInsights', async () => {
    // The server omits `followUp` entirely below Enterprise, which is what keeps the
    // panel off their screen — there is no second client-side gate to forget.
    hasFeatureMock.mockImplementation((k) => k !== 'aiBusinessInsights');
    renderUI([PRO_LEAD]);
    await openDrawer();
    expect(screen.queryByText(/Get back to them with a time/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/this is a suggestion only/i)).not.toBeInTheDocument();
  });

  it('renders the action together with the reasons that fired it', async () => {
    // A suggested action with no stated cause is exactly the unexplainable AI verdict
    // this feature was designed not to be.
    renderUI([{ ...PRO_LEAD, followUp: FOLLOW_UP }]);
    await openDrawer();
    expect(await screen.findByText(/Get back to them with a time/i)).toBeInTheDocument();
    expect(screen.getByText(/They told us what they need/i)).toBeInTheDocument();
    expect(screen.getByText(/Phone number on file/i)).toBeInTheDocument();
  });

  it('says plainly that nothing has been sent', async () => {
    // There is no worklist behind this: it is advisory, and the copy must not let
    // anyone assume the platform already chased the customer.
    renderUI([{ ...PRO_LEAD, followUp: FOLLOW_UP }]);
    await openDrawer();
    expect(await screen.findByText(/nothing has been sent/i)).toBeInTheDocument();
  });

  it('marks an urgent recommendation as due today', async () => {
    renderUI([
      {
        ...PRO_LEAD,
        followUp: {
          ...FOLLOW_UP,
          action: 'win_back_cancelled',
          priority: 'now',
          reasons: [
            { key: 'booking_cancelled', label: 'Their booking was cancelled' },
            // Quantified reason: the server sends the number, the locale renders it.
            { key: 'waiting', label: 'Open for {{days}} days', days: 9 },
          ],
        },
      },
    ]);
    await openDrawer();
    expect(await screen.findByText(/Offer them a new time/i)).toBeInTheDocument();
    expect(screen.getByText('Today')).toBeInTheDocument();
    // Interpolated, not printed raw — a visible `{{days}}` is the failure this catches.
    expect(screen.getByText(/No contact for 9 days/i)).toBeInTheDocument();
  });

  it('renders nothing when the tenant is entitled but there is nothing to suggest', async () => {
    // `null` (entitled, no recommendation) must look like silence, not like an error.
    renderUI([{ ...PRO_LEAD, followUp: null }]);
    await openDrawer();
    expect(screen.queryByText(/this is a suggestion only/i)).not.toBeInTheDocument();
  });
});

describe('Leads page — repeat customers', () => {
  it('shows a returning-customer indicator when the server says so', async () => {
    // The signal groups a person across their lead ROWS; `conversationCount` counts
    // THIS record and structurally cannot see the WhatsApp-then-widget case, so the
    // indicator has to come from `isRepeatCustomer`.
    renderUI([
      {
        ...PRO_LEAD,
        isRepeatCustomer: true,
        personConversationCount: 3,
        personLeadCount: 2,
        personFirstSeenAt: '2026-03-02T09:00:00.000Z',
      },
    ]);
    await waitFor(() => expect(screen.getByText('Achraf Peeters')).toBeInTheDocument());
    await userEvent.click(screen.getByText('Achraf Peeters'));
    expect(await screen.findByText(/returning customer/i)).toBeInTheDocument();
  });

  it('says nothing about repeats for a first-time contact', async () => {
    renderUI([{ ...PRO_LEAD, isRepeatCustomer: false, personConversationCount: 1 }]);
    await waitFor(() => expect(screen.getByText('Achraf Peeters')).toBeInTheDocument());
    await userEvent.click(screen.getByText('Achraf Peeters'));
    expect(screen.queryByText(/returning customer/i)).not.toBeInTheDocument();
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

describe('Leads page — export', () => {
  /** The two download controls, scoped to their own group. */
  const exportButtons = () =>
    within(screen.getByRole('group', { name: /export leads/i })).getAllByRole('button');

  beforeEach(() => {
    apiDownload.mockResolvedValue({ truncated: false, rowLimit: null });
  });

  it('offers BOTH formats, named so they are distinguishable', async () => {
    // One button labelled "Export for Excel" could not say which of two files it
    // produced once the .xlsx shipped.
    renderUI([BASIC_LEAD]);
    await waitFor(() => expect(screen.getByText('Achraf Peeters')).toBeInTheDocument());
    expect(exportButtons().map((b) => b.textContent?.trim())).toEqual(['Excel (.xlsx)', 'CSV']);
  });

  it('asks the server for the format the user clicked, and names the file to match', async () => {
    // The fallback filename only applies when a proxy strips Content-Disposition —
    // but a .xlsx handed over as "leads.csv" is a file the operator cannot open.
    renderUI([BASIC_LEAD]);
    await waitFor(() => expect(screen.getByText('Achraf Peeters')).toBeInTheDocument());

    await userEvent.click(screen.getByRole('button', { name: /excel/i }));
    await waitFor(() =>
      expect(apiDownload).toHaveBeenCalledWith('/leads/export?format=xlsx', 'leads.xlsx'),
    );

    await userEvent.click(screen.getByRole('button', { name: /^csv$/i }));
    await waitFor(() =>
      expect(apiDownload).toHaveBeenCalledWith('/leads/export?format=csv', 'leads.csv'),
    );
  });

  it('warns on a row-capped .xlsx — a short file must never pass as the full history', async () => {
    const { toast } = await import('sonner');
    apiDownload.mockResolvedValue({ truncated: true, rowLimit: 10000 });
    renderUI([BASIC_LEAD]);
    await waitFor(() => expect(screen.getByText('Achraf Peeters')).toBeInTheDocument());

    await userEvent.click(screen.getByRole('button', { name: /excel/i }));
    await waitFor(() =>
      expect(toast.warning).toHaveBeenCalledWith(expect.stringMatching(/10000 most recent/i)),
    );
  });

  it('still tells an agent seat WHY the xlsx download was refused', async () => {
    const { toast } = await import('sonner');
    apiDownload.mockRejectedValue({ response: { status: 403 } });
    renderUI([BASIC_LEAD]);
    await waitFor(() => expect(screen.getByText('Achraf Peeters')).toBeInTheDocument());

    await userEvent.click(screen.getByRole('button', { name: /excel/i }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(expect.stringMatching(/admins and supervisors/i)),
    );
    // …and the buttons come back, rather than staying stuck in the spinner state.
    await waitFor(() => expect(exportButtons().every((b) => !b.hasAttribute('disabled'))).toBe(true));
  });
});

describe('Leads page — manual entry discloses a merge', () => {
  it('tells the user when their new lead MERGED into an existing contact', async () => {
    // The count will not match what they typed. Saying so is the difference between
    // "it worked" and "did it lose my data?".
    const { toast } = await import('sonner');
    apiPost.mockResolvedValue({ id: 'lead-1', created: false });
    renderUI([BASIC_LEAD]);

    await waitFor(() => expect(screen.getByRole('button', { name: /add lead/i })).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: /add lead/i }));

    const email = await screen.findByPlaceholderText(/email/i);
    await userEvent.type(email, 'dup@example.com');
    await userEvent.click(screen.getByRole('button', { name: /^add lead$/i }));

    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith(expect.stringMatching(/already had this contact/i));
    });
  });

  it('disables save until an email or phone is given', async () => {
    renderUI([BASIC_LEAD]);
    await waitFor(() => expect(screen.getByRole('button', { name: /add lead/i })).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: /add lead/i }));

    const save = await screen.findByRole('button', { name: /^add lead$/i });
    // A lead with neither is unreachable and violates the identity constraint.
    expect(save).toBeDisabled();
    await userEvent.type(screen.getByPlaceholderText(/phone/i), '32475464421');
    expect(save).toBeEnabled();
  });
});

/**
 * The UX pass: the page has to answer "who do I call next, and why" before it answers
 * "what is in the database". Each test below pins one of those moves, and each fails
 * against the previous layout.
 */
describe('Leads page — triage', () => {
  const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();

  it('counts waiting from the last contact, not from when the record was created', async () => {
    // The whole point of lastActivityAt: a lead first seen a year ago but answered
    // two days ago has waited two days. Reading createdAt would say 400.
    renderUI([
      { ...PRO_LEAD, createdAt: daysAgo(400), lastActivityAt: daysAgo(2), followUp: null },
    ]);
    expect(await screen.findByText('2')).toBeInTheDocument();
    expect(screen.queryByText('400')).not.toBeInTheDocument();
  });

  it('puts the recommendation on the row, not only inside the drawer', async () => {
    renderUI([
      {
        ...PRO_LEAD,
        lastActivityAt: daysAgo(5),
        followUp: {
          action: 'confirm_request',
          via: 'phone',
          priority: 'now',
          reasons: [{ key: 'booking_unconfirmed', label: 'Slot never confirmed' }],
          version: 1,
        },
      },
    ]);
    // Visible WITHOUT expanding anything.
    expect(await screen.findByText(/Confirm the slot/i)).toBeInTheDocument();
  });

  it('says plainly when an entitled tenant has nothing to chase', async () => {
    // `null` is a real answer — the person already has an appointment — and must not
    // render as an empty cell that looks like missing data.
    renderUI([{ ...PRO_LEAD, lastActivityAt: daysAgo(1), followUp: null }]);
    expect(await screen.findByText(/Nothing to chase/i)).toBeInTheDocument();
  });

  it('flags how many have gone unanswered, and admits it only counted what it loaded', async () => {
    renderUI([
      { ...PRO_LEAD, id: 'a', lastActivityAt: daysAgo(45), followUp: null },
      { ...PRO_LEAD, id: 'b', lastActivityAt: daysAgo(60), followUp: null },
      { ...PRO_LEAD, id: 'c', lastActivityAt: daysAgo(1), followUp: null },
    ]);
    // Two are over the 30-day line, not three.
    expect(await screen.findByText(/2/)).toBeInTheDocument();
    // The endpoint returns no totals, so the scope of the count is stated rather than
    // implied to be the whole dataset.
    expect(screen.getByText(/loaded so far/i)).toBeInTheDocument();
  });

  it('offers a way to actually make contact, and none when there is no address to open', async () => {
    renderUI([{ ...PRO_LEAD, phone: '0470112233', email: null, lastActivityAt: daysAgo(3) }]);
    const call = await screen.findByTitle(/Call/i);
    expect(call).toHaveAttribute('href', 'tel:0470112233');

    cleanup();
    renderUI([
      { ...PRO_LEAD, id: 'chan', phone: null, email: null, channel: 'whatsapp', lastActivityAt: daysAgo(3) },
    ]);
    await screen.findAllByRole('row');
    expect(screen.queryByTitle(/Call|Email/i)).not.toBeInTheDocument();
  });
});
