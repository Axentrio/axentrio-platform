import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AiBotForm from './AiBotForm';

const { mockMutate } = vi.hoisted(() => ({ mockMutate: vi.fn() }));

vi.mock('@/auth/useAppAuth', () => ({
  useAppAuth: () => ({
    isRole: () => true,
    tenantId: 'test-tenant',
  }),
}));

vi.mock('@/queries/useKnowledgeQueries', () => ({
  useGetAiSettings: () => ({
    data: {
      enabled: true,
      brandVoice: {
        name: 'TestBot',
        tone: 'friendly',
        customInstructions: '',
        templateId: null,
      },
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
  useUpdateAiSettings: () => ({
    mutate: mockMutate,
    isPending: false,
  }),
}));

const SYSTEM_PROMPT_PLACEHOLDER = /Write your bot's instructions here/;

const renderForm = (onGoToKnowledgeBase = vi.fn()) => {
  const user = userEvent.setup();
  const result = render(<AiBotForm onGoToKnowledgeBase={onGoToKnowledgeBase} />);
  return { user, onGoToKnowledgeBase, ...result };
};

const getInstructionsTextarea = () =>
  screen.getByPlaceholderText(SYSTEM_PROMPT_PLACEHOLDER) as HTMLTextAreaElement;

const getStarterCombobox = () => screen.getByRole('combobox', { name: /starter prompt/i });

describe('AiBotForm — dirty-state flows', () => {
  beforeEach(() => {
    mockMutate.mockReset();
  });

  it('cancels a template switch and preserves edits + current selection', async () => {
    const { user } = renderForm();

    const ta = getInstructionsTextarea();
    await user.click(ta);
    await user.keyboard('hand-edited instructions');
    expect(ta.value).toBe('hand-edited instructions');

    await user.click(getStarterCombobox());
    await user.click(await screen.findByRole('option', { name: 'Customer Support Assistant' }));

    // AlertDialog appears asking before we replace.
    await user.click(await screen.findByRole('button', { name: 'Keep editing' }));

    await waitFor(() => {
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    });
    expect(getInstructionsTextarea().value).toBe('hand-edited instructions');
    expect(getStarterCombobox()).toHaveTextContent('Blank');
  });

  it('confirms a template switch and replaces instructions + updates selection', async () => {
    const { user } = renderForm();

    const ta = getInstructionsTextarea();
    await user.click(ta);
    await user.keyboard('throwaway');

    await user.click(getStarterCombobox());
    await user.click(await screen.findByRole('option', { name: 'Customer Support Assistant' }));

    await user.click(await screen.findByRole('button', { name: 'Replace' }));

    await waitFor(() => {
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    });
    const after = getInstructionsTextarea();
    expect(after.value).not.toBe('throwaway');
    expect(after.value).toMatch(/customer support assistant/i);
    expect(getStarterCombobox()).toHaveTextContent('Customer Support Assistant');
  });

  it('cancels Go to Knowledge Base and preserves edits + stays on the form', async () => {
    const { user, onGoToKnowledgeBase } = renderForm();

    const ta = getInstructionsTextarea();
    await user.click(ta);
    await user.keyboard('unsaved change');

    await user.click(screen.getByRole('button', { name: /go to knowledge base/i }));
    await user.click(await screen.findByRole('button', { name: 'Stay here' }));

    await waitFor(() => {
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    });
    expect(onGoToKnowledgeBase).not.toHaveBeenCalled();
    expect(getInstructionsTextarea().value).toBe('unsaved change');
  });

  it('confirms Go to Knowledge Base and calls the navigation callback', async () => {
    const { user, onGoToKnowledgeBase } = renderForm();

    const ta = getInstructionsTextarea();
    await user.click(ta);
    await user.keyboard('unsaved change');

    await user.click(screen.getByRole('button', { name: /go to knowledge base/i }));
    await user.click(await screen.findByRole('button', { name: 'Leave anyway' }));

    await waitFor(() => {
      expect(onGoToKnowledgeBase).toHaveBeenCalledTimes(1);
    });
  });

  it('clears dirty state after a successful save', async () => {
    const { user, onGoToKnowledgeBase } = renderForm();

    const ta = getInstructionsTextarea();
    await user.click(ta);
    await user.keyboard('about to save');

    // Capture and immediately invoke onSuccess so savedSnapshot tracks the
    // current values, mirroring the real mutation success path.
    mockMutate.mockImplementationOnce((_vars: unknown, options?: { onSuccess?: () => void }) => {
      options?.onSuccess?.();
    });

    await user.click(screen.getByRole('button', { name: /save changes/i }));
    await waitFor(() => {
      expect(mockMutate).toHaveBeenCalledTimes(1);
    });

    // After save the form is no longer dirty — clicking Go to KB should
    // navigate immediately without opening the leave dialog.
    await user.click(screen.getByRole('button', { name: /go to knowledge base/i }));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(onGoToKnowledgeBase).toHaveBeenCalledTimes(1);
  });
});
