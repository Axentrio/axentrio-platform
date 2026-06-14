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
      binding: { templateId: null, templateVersion: 'latest' },
      resolved: { resolvedVersion: null, body: '', pinnedButUnavailable: false, templateUnavailable: false },
      publishedVersions: [],
      missingModules: [],
    },
  }),
  useBindBotTemplate: () => ({ mutate: mockBind, isPending: false }),
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

  it('binds a template via the picker (separate from the auto-saved form)', async () => {
    const { user } = renderForm();
    await user.click(screen.getByRole('combobox', { name: /^template$/i }));
    await user.click(await screen.findByRole('option', { name: 'Plumber Booking' }));
    expect(mockBind).toHaveBeenCalledWith({ templateId: 'tmpl-1', templateVersion: 'latest' });
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

    const maxLen = screen.getByRole('spinbutton') as HTMLInputElement;
    await user.clear(maxLen);
    await user.type(maxLen, '0');

    await user.click(screen.getByRole('button', { name: /go to knowledge base/i }));
    await user.click(await screen.findByRole('button', { name: 'Stay here' }));

    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    expect(onGoToKnowledgeBase).not.toHaveBeenCalled();
    expect(mockMutate).not.toHaveBeenCalled();
  });
});
