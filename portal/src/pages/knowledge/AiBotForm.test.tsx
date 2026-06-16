import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import AiBotForm from './AiBotForm';

const { mockMutate, mockBind } = vi.hoisted(() => ({ mockMutate: vi.fn(), mockBind: vi.fn() }));

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
      brandVoice: { name: 'TestBot', tone: 'friendly', customInstructions: '' },
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
  useBotDetail: () => ({ data: { businessHours: null } }),
  useUpdateBot: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

const ADDL_INSTRUCTIONS_PLACEHOLDER = /weekend promotion/;

const renderForm = (onGoToKnowledgeBase = vi.fn()) => {
  const user = userEvent.setup();
  // BotInstructionsHelpDrawer calls useFaq() (React Query), so wrap in a client.
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const result = render(
    <QueryClientProvider client={queryClient}>
      <AiBotForm botId="test-bot" onGoToKnowledgeBase={onGoToKnowledgeBase} />
    </QueryClientProvider>,
  );
  return { user, onGoToKnowledgeBase, ...result };
};

const getInstructionsTextarea = () =>
  screen.getByPlaceholderText(ADDL_INSTRUCTIONS_PLACEHOLDER) as HTMLTextAreaElement;

describe('AiBotForm', () => {
  beforeEach(() => {
    mockMutate.mockReset();
    mockBind.mockReset();
  });

  it('adds a template via the Select (separate from the auto-saved form)', async () => {
    const { user } = renderForm();
    await user.click(screen.getByRole('combobox', { name: /add a speciality/i }));
    await user.click(await screen.findByRole('option', { name: /Plumber Booking/i }));
    expect(mockBind).toHaveBeenCalledWith({ bindings: [{ templateId: 'tmpl-1', version: 'latest' }], mode: 'or' });
  });

  it('auto-saves additional instructions on blur; Go to Knowledge Base navigates without a dialog', async () => {
    const { user, onGoToKnowledgeBase } = renderForm();
    mockMutate.mockImplementation((_vars: unknown, options?: { onSuccess?: () => void }) => {
      options?.onSuccess?.();
    });

    const ta = getInstructionsTextarea();
    await user.click(ta);
    await user.keyboard('about to save');
    await user.tab();

    await waitFor(() => expect(mockMutate).toHaveBeenCalled());

    await user.click(screen.getByRole('button', { name: /go to knowledge base/i }));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(onGoToKnowledgeBase).toHaveBeenCalledTimes(1);
  });

  it('does not persist a templateId in the ai-settings payload (T18)', async () => {
    const { user } = renderForm();
    mockMutate.mockImplementation((_vars: unknown, options?: { onSuccess?: () => void }) => options?.onSuccess?.());
    const ta = getInstructionsTextarea();
    await user.click(ta);
    await user.keyboard('hi');
    await user.tab();
    await waitFor(() => expect(mockMutate).toHaveBeenCalled());
    const payload = mockMutate.mock.calls[0][0] as { brandVoice: Record<string, unknown> };
    expect(payload.brandVoice).not.toHaveProperty('templateId');
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
