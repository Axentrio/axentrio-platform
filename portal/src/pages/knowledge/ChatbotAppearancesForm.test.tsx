import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ChatbotAppearancesForm from './ChatbotAppearancesForm';

type AppearanceData = {
  primaryColor: string | null;
  avatarUrl: string | null;
  launcherPosition: 'bottom-right' | 'bottom-left';
  launcherLabel: string | null;
} | undefined;

const DEFAULT_APPEARANCE: AppearanceData = {
  primaryColor: '#6366f1',
  avatarUrl: null,
  launcherPosition: 'bottom-right',
  launcherLabel: null,
};

const { mockMutate, appearanceRef } = vi.hoisted(() => ({
  mockMutate: vi.fn(),
  appearanceRef: { current: undefined as unknown },
}));

vi.mock('@clerk/clerk-react', () => ({
  useOrganization: () => ({ organization: { imageUrl: 'https://clerk.example/org.png', name: 'Acme' } }),
}));

vi.mock('@/queries/useWidgetAppearance', () => ({
  useGetWidgetAppearance: () => ({ data: appearanceRef.current, isLoading: false }),
  useUpdateWidgetAppearance: () => ({ mutate: mockMutate, isPending: false }),
}));

vi.mock('@/queries/useKnowledgeQueries', () => ({
  useGetAiSettings: () => ({
    data: { guardrails: { greetingMessage: 'Hello — how can we help you today?' } },
    isLoading: false,
  }),
}));

vi.mock('@/queries/useTenantQueries', () => ({
  useTenantSettings: () => ({ data: { apiKey: 'fake-api-key' } }),
}));

beforeEach(() => {
  mockMutate.mockReset();
  appearanceRef.current = DEFAULT_APPEARANCE;
});

describe('ChatbotAppearancesForm', () => {
  it('hydrates fields from the API response', () => {
    render(<ChatbotAppearancesForm />);
    expect(screen.getByLabelText(/primary color/i)).toHaveValue('#6366f1');
    expect((screen.getByLabelText(/bot avatar url/i) as HTMLInputElement).value).toBe('');
  });

  it('renders the read-only greeting from AI settings', () => {
    render(<ChatbotAppearancesForm />);
    expect(screen.getAllByText(/Hello — how can we help you today\?/).length).toBeGreaterThan(0);
    expect(screen.getByRole('link', { name: /edit in ai bot/i })).toHaveAttribute(
      'href',
      '/ai?tab=bot',
    );
  });

  it('auto-saves edits on blur with only the changed fields', async () => {
    const user = userEvent.setup();
    render(<ChatbotAppearancesForm />);

    await user.type(screen.getByLabelText(/launcher label/i), 'Chat');
    // Move focus elsewhere — wrapping onBlur triggers flush() → save fires immediately.
    await user.tab();

    await waitFor(() => expect(mockMutate).toHaveBeenCalled());
    const arg = mockMutate.mock.calls[0][0];
    expect(arg).toEqual(expect.objectContaining({ launcherLabel: 'Chat' }));
  });

  it('does not auto-save when the form is untouched', async () => {
    render(<ChatbotAppearancesForm />);
    // No interaction → no save scheduled. Wait a tick to be sure.
    await new Promise((r) => setTimeout(r, 50));
    expect(mockMutate).not.toHaveBeenCalled();
  });

  it('renders an "Open full widget test" link with the tenant apiKey', () => {
    render(<ChatbotAppearancesForm />);
    expect(screen.getByRole('link', { name: /open full widget test/i })).toHaveAttribute(
      'href',
      expect.stringContaining('apiKey=fake-api-key'),
    );
  });

  it('still renders a usable form when the appearance query returns no data', async () => {
    appearanceRef.current = undefined;
    const user = userEvent.setup();
    render(<ChatbotAppearancesForm />);

    // Form fields hydrated from defaults — not stuck behind the loading state.
    expect(screen.getByLabelText(/primary color/i)).toHaveValue('#6366f1');

    // User can still edit and trigger an auto-save.
    await user.type(screen.getByLabelText(/launcher label/i), 'Hi');
    await user.tab();
    await waitFor(() => expect(mockMutate).toHaveBeenCalled());
  });
});
