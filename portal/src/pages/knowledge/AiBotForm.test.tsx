import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import AiBotForm from './AiBotForm';

const {
  mockMutate,
  mockBind,
  mockUpdateBot,
  readinessState,
  botDetailState,
  accountInformationState,
  accountInformationQueryState,
} = vi.hoisted(() => ({
  mockMutate: vi.fn(),
  mockBind: vi.fn(),
  mockUpdateBot: vi.fn(),
  // Entitled-but-undelivered skills returned by GET /bots/readiness — set per test.
  readinessState: { unselectedEntitledSkills: [] as { feature: string; skillId: string; skillName: string }[] },
  botDetailState: {
    businessHours: null as {
      enabled: boolean;
      timezone?: string;
      schedule: { day: string; open: string; close: string; closed: boolean }[];
      dateOverrides?: Array<{ date: string; endDate?: string; closed?: boolean; windows?: Array<{ start: string; end: string }> }>;
    } | null,
    quotedAddress: { enabled: false } as {
      enabled: boolean;
      street?: string | null;
      streetNumber?: string | null;
      boxNumber?: string | null;
      postalCode?: string | null;
      city?: string | null;
      country?: string | null;
    } | undefined,
  },
  accountInformationState: {
    invoiceAddress: {
      street: 'Account Street',
      streetNumber: '10',
      boxNumber: '3',
      postalCode: '1000',
      city: 'Brussels',
      country: 'BE',
    },
  },
  accountInformationQueryState: { isFetched: true },
}));

vi.mock('@/auth/useAppAuth', () => ({
  useAppAuth: () => ({
    isRole: () => true,
    tenantId: 'test-tenant',
  }),
}));

// AiBotForm reads the org/business name from Clerk for the per-bot business-name
// placeholder. Stub it so the form renders outside a <ClerkProvider>.
vi.mock('@clerk/clerk-react', () => ({
  useOrganization: () => ({ organization: { name: 'Test Org' } }),
}));

vi.mock('@/queries/useBotsQueries', () => ({
  useBotAiSettings: () => ({
    data: {
      enabled: true,
      brandVoice: { name: 'TestBot', tone: 'friendly' },
      guardrails: {
        topicsToAvoid: [],
        escalationKeywords: [],
        confidenceThreshold: 0.7,
        maxResponseLength: 500,
        greetingMessage: '',
        fallbackMessage: '',
        offHoursMessage: '',
      },
    },
    isLoading: false,
    error: null,
  }),
  useUpdateBotAiSettings: () => ({ mutate: mockMutate, isPending: false }),
  useBotTemplates: () => ({
    data: {
      available: [
        { id: 'tmpl-1', key: 'plumber', displayName: 'Plumber Booking', category: null, description: null, availableToAllTenants: true, latestPublishedVersion: 1 },
      ],
      mode: 'or',
      bindings: [],
      binding: { templateId: null, templateVersion: 'latest' },
      resolved: { resolvedVersion: null, body: '', pinnedButUnavailable: false, templateUnavailable: false },
      publishedVersions: [],
      missingModules: [],
    },
  }),
  useBindBotTemplate: () => ({ mutate: mockBind, isPending: false }),
  useSkillReadiness: () => ({ data: [] }),
  useBotDetail: () => ({ data: botDetailState }),
  useUpdateBot: () => ({ mutateAsync: mockUpdateBot, isPending: false }),
}));

vi.mock('@/queries/useReadinessQueries', () => ({
  useBotReadiness: () => ({ data: { botId: 'test-bot', capabilities: [], overall: {}, ...readinessState } }),
}));

vi.mock('@/queries/useTenantQueries', () => ({
  useAccountInformation: () => ({
    data: accountInformationState,
    isFetched: accountInformationQueryState.isFetched,
  }),
}));

const renderForm = (onGoToKnowledgeBase = vi.fn()) => {
  const user = userEvent.setup();
  // Some children use React Query hooks, so wrap in a client.
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = () => (
    <QueryClientProvider client={queryClient}>
      <AiBotForm botId="test-bot" onGoToKnowledgeBase={onGoToKnowledgeBase} />
    </QueryClientProvider>
  );
  const result = render(view());
  return { user, onGoToKnowledgeBase, rerenderForm: () => result.rerender(view()), ...result };
};

// Business Name is an auto-saved AI-settings field (the form's auto-save path),
// used here to exercise blur-save behaviour now that the free-text instructions
// field has been removed from the form.
const getBusinessNameInput = () =>
  screen.getByPlaceholderText('Test Org') as HTMLInputElement;

describe('AiBotForm', () => {
  beforeEach(() => {
    mockMutate.mockReset();
    mockBind.mockReset();
    mockUpdateBot.mockReset().mockResolvedValue(undefined);
    botDetailState.businessHours = null;
    botDetailState.quotedAddress = { enabled: false };
    accountInformationState.invoiceAddress.country = 'BE';
    accountInformationQueryState.isFetched = true;
    readinessState.unselectedEntitledSkills = [];
  });

  // Regression: a Pro tenant's bot bound a template selecting only `booking`, so
  // the runtime tool-gate stripped capture_lead and their paid-for Leads feature
  // was silently dead. The speciality section must say so.
  it('warns on the speciality section when an entitled feature has no bound skill', async () => {
    readinessState.unselectedEntitledSkills = [
      { feature: 'leadCapture', skillId: 'lead_capture', skillName: 'Lead capture' },
    ];
    renderForm();
    const warning = await screen.findByTestId('skill-coverage-warning');
    expect(warning).toHaveTextContent(/Your plan includes Leads/i);
    expect(warning).toHaveTextContent(/Lead capture skill/i);
  });

  it('shows no coverage warning when every entitled skill is bound', () => {
    renderForm();
    expect(screen.queryByTestId('skill-coverage-warning')).not.toBeInTheDocument();
  });

  it('adds a template via the Select (separate from the auto-saved form)', async () => {
    const { user } = renderForm();
    await user.click(screen.getByRole('combobox', { name: /add a speciality/i }));
    await user.click(await screen.findByRole('option', { name: /Plumber Booking/i }));
    expect(mockBind).toHaveBeenCalledWith({ bindings: [{ templateId: 'tmpl-1', version: 'latest' }], mode: 'or' });
  });

  it('auto-saves an edited field on blur; Go to Knowledge Base navigates without a dialog', async () => {
    const { user, onGoToKnowledgeBase } = renderForm();
    mockMutate.mockImplementation((_vars: unknown, options?: { onSuccess?: () => void }) => {
      options?.onSuccess?.();
    });

    const input = getBusinessNameInput();
    await user.click(input);
    await user.keyboard('Acme Plumbing');
    await user.tab();

    await waitFor(() => expect(mockMutate).toHaveBeenCalled());

    await user.click(screen.getByRole('button', { name: /go to knowledge base/i }));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(onGoToKnowledgeBase).toHaveBeenCalledTimes(1);
  });

  it('saves the default language next to voice tone', async () => {
    const { user } = renderForm();
    mockMutate.mockImplementation((_vars: unknown, options?: { onSuccess?: () => void }) => options?.onSuccess?.());

    expect(screen.getByLabelText('Language')).toBeInTheDocument();
    await user.click(screen.getByLabelText('Language'));
    await user.click(await screen.findByRole('option', { name: 'Nederlands' }));

    await waitFor(() => expect(mockMutate).toHaveBeenCalled());
    const payload = mockMutate.mock.calls[0][0] as { language: string };
    expect(payload.language).toBe('nl');
  });

  it('does not persist a templateId in the ai-settings payload (T18)', async () => {
    const { user } = renderForm();
    mockMutate.mockImplementation((_vars: unknown, options?: { onSuccess?: () => void }) => options?.onSuccess?.());
    const input = getBusinessNameInput();
    await user.click(input);
    await user.keyboard('hi');
    await user.tab();
    await waitFor(() => expect(mockMutate).toHaveBeenCalled());
    const payload = mockMutate.mock.calls[0][0] as { brandVoice: Record<string, unknown> };
    expect(payload.brandVoice).not.toHaveProperty('templateId');
  });

  it('hides the server timezone and omits it from business-hours writes', async () => {
    botDetailState.businessHours = {
      enabled: true,
      timezone: 'Europe/Brussels',
      schedule: [{ day: 'monday', open: '09:00', close: '17:00', closed: false }],
    };
    const { user } = renderForm();

    await user.click(screen.getByRole('button', { name: /operational/i }));
    expect(await screen.findByRole('switch', { name: 'monday open' })).toBeInTheDocument();
    expect(screen.queryByText('Europe/Brussels')).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText('America/New_York')).not.toBeInTheDocument();

    await user.click(screen.getByRole('switch', { name: 'monday open' }));
    await user.click(screen.getByRole('button', { name: /save business hours/i }));

    await waitFor(() => expect(mockUpdateBot).toHaveBeenCalled());
    const payload = mockUpdateBot.mock.calls[0][0] as { businessHours: Record<string, unknown> };
    expect(payload.businessHours).not.toHaveProperty('timezone');
  });

  it('saves a closed date on the business-hours payload', async () => {
    botDetailState.businessHours = {
      enabled: true,
      timezone: 'Europe/Brussels',
      schedule: [{ day: 'monday', open: '09:00', close: '17:00', closed: false }],
      dateOverrides: [{ date: '2026-12-25', closed: true }],
    };
    const { user } = renderForm();

    await user.click(screen.getByRole('button', { name: /operational/i }));
    expect(await screen.findByRole('checkbox', { name: /closed/i })).toBeChecked();
    // Flip a weekly day so Save is dirty, then persist — the stored closed date
    // must ride along rather than being dropped.
    await user.click(screen.getByRole('switch', { name: 'monday open' }));
    await user.click(screen.getByRole('button', { name: /save business hours/i }));

    await waitFor(() => expect(mockUpdateBot).toHaveBeenCalled());
    const payload = mockUpdateBot.mock.calls[0][0] as {
      businessHours: { dateOverrides?: Array<{ closed?: boolean; date?: string }> };
    };
    expect(payload.businessHours.dateOverrides).toEqual([{ date: '2026-12-25', closed: true }]);
  });

  it('defaults an unsaved quoted address on and prefills the account address', async () => {
    botDetailState.quotedAddress = undefined;
    const { user } = renderForm();
    await user.click(screen.getByRole('button', { name: /operational/i }));

    expect(await screen.findByRole('switch', { name: /address the bot quotes/i })).toBeChecked();
    expect(screen.getByPlaceholderText('Street')).toHaveValue('Account Street');
    expect(screen.getByPlaceholderText('Street number')).toHaveValue('10');
    expect(screen.getByPlaceholderText('Box number')).toHaveValue('3');
    expect(screen.getByPlaceholderText('Postal code')).toHaveValue('1000');
    expect(screen.getByPlaceholderText('City')).toHaveValue('Brussels');
    expect(screen.getByPlaceholderText('Country code')).toHaveValue('BE');
  });

  it('keeps the quoted-address switch disabled until hydration completes', async () => {
    accountInformationQueryState.isFetched = false;
    const { user, rerenderForm } = renderForm();
    await user.click(screen.getByRole('button', { name: /operational/i }));

    const loadingSwitch = await screen.findByRole('switch', { name: /address the bot quotes/i });
    expect(loadingSwitch).toBeDisabled();
    await user.click(loadingSwitch);
    expect(loadingSwitch).not.toBeChecked();

    accountInformationQueryState.isFetched = true;
    rerenderForm();
    await waitFor(() =>
      expect(screen.getByRole('switch', { name: /address the bot quotes/i })).toBeEnabled(),
    );
  });

  it('restores a non-Belgian account country when the quoted address is turned on', async () => {
    accountInformationState.invoiceAddress.country = 'FR';
    const { user } = renderForm();
    await user.click(screen.getByRole('button', { name: /operational/i }));
    await user.click(await screen.findByRole('switch', { name: /address the bot quotes/i }));

    expect(screen.getByPlaceholderText('Country code')).toHaveValue('FR');
  });

  it('prefills the account address when the quoted address is turned on', async () => {
    const { user } = renderForm();
    await user.click(screen.getByRole('button', { name: /operational/i }));
    await user.click(await screen.findByRole('switch', { name: /address the bot quotes/i }));
    const street = screen.getByPlaceholderText('Street');
    const streetNumber = screen.getByPlaceholderText('Street number');
    const boxNumber = screen.getByPlaceholderText('Box number');
    await user.clear(street);
    await user.type(street, 'Grote Markt');
    await user.clear(streetNumber);
    await user.type(streetNumber, '1');
    await user.clear(boxNumber);
    await user.type(boxNumber, '2');
    const country = screen.getByPlaceholderText('Country code');
    await user.clear(country);
    await user.type(country, 'belgië');
    await user.click(screen.getByRole('button', { name: /save bot address/i }));
    await waitFor(() => expect(mockUpdateBot).toHaveBeenCalled());
    expect(mockUpdateBot.mock.calls[0][0]).toMatchObject({
      quotedAddress: {
        enabled: true,
        street: 'Grote Markt',
        streetNumber: '1',
        boxNumber: '2',
        country: 'BE',
      },
    });
    expect(country).toHaveValue('BE');
  });

  it('saves disabled quoted-address settings as no address', async () => {
    botDetailState.quotedAddress = { enabled: true, street: 'Saved Street' };
    const { user } = renderForm();
    await user.click(screen.getByRole('button', { name: /operational/i }));
    await user.click(await screen.findByRole('switch', { name: /address the bot quotes/i }));
    await user.click(screen.getByRole('button', { name: /save bot address/i }));

    await waitFor(() => expect(mockUpdateBot).toHaveBeenCalled());
    expect(mockUpdateBot.mock.calls[0][0]).toMatchObject({
      quotedAddress: { enabled: false, street: 'Saved Street' },
    });
  });

  it('shows the leave dialog only when fields are invalid + dirty, and "Stay here" keeps the user on the form', async () => {
    const { user, onGoToKnowledgeBase } = renderForm();

    const email = screen.getByPlaceholderText('support@yourcompany.com') as HTMLInputElement;
    await user.clear(email);
    await user.type(email, 'not-an-email');

    await user.click(screen.getByRole('button', { name: /go to knowledge base/i }));
    await user.click(await screen.findByRole('button', { name: 'Stay here' }));

    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    expect(onGoToKnowledgeBase).not.toHaveBeenCalled();
    expect(mockMutate).not.toHaveBeenCalled();
  });
});
