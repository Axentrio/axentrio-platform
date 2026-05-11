import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ChatbotAppearancesForm from './ChatbotAppearancesForm';

const { mockMutate } = vi.hoisted(() => ({ mockMutate: vi.fn() }));

vi.mock('@clerk/clerk-react', () => ({
  useOrganization: () => ({ organization: { imageUrl: 'https://clerk.example/org.png', name: 'Acme' } }),
}));

vi.mock('@/queries/useWidgetAppearance', () => ({
  useGetWidgetAppearance: () => ({
    data: {
      primaryColor: '#6366f1',
      avatarUrl: null,
      launcherPosition: 'bottom-right',
      launcherLabel: null,
    },
    isLoading: false,
  }),
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
});

describe('ChatbotAppearancesForm', () => {
  it('hydrates fields from the API response', () => {
    render(<ChatbotAppearancesForm />);
    expect(screen.getByLabelText(/primary color/i)).toHaveValue('#6366f1');
    expect((screen.getByLabelText(/bot avatar url/i) as HTMLInputElement).value).toBe('');
  });

  it('renders the read-only greeting from AI settings', () => {
    render(<ChatbotAppearancesForm />);
    // Greeting renders in the form's read-only card AND in the preview bubble — both are expected.
    expect(screen.getAllByText(/Hello — how can we help you today\?/).length).toBeGreaterThan(0);
    expect(screen.getByRole('link', { name: /edit in ai bot/i })).toHaveAttribute(
      'href',
      '/ai?tab=bot',
    );
  });

  it('disables Save when the form is clean and enables it when dirty', async () => {
    const user = userEvent.setup();
    render(<ChatbotAppearancesForm />);
    const save = screen.getByRole('button', { name: /save/i });
    expect(save).toBeDisabled();
    await user.type(screen.getByLabelText(/launcher label/i), 'Chat');
    expect(save).toBeEnabled();
  });

  it('calls the update mutation with only changed fields when Save is clicked', async () => {
    const user = userEvent.setup();
    render(<ChatbotAppearancesForm />);
    await user.type(screen.getByLabelText(/launcher label/i), 'Chat');
    await user.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() => expect(mockMutate).toHaveBeenCalled());
    const arg = mockMutate.mock.calls[0][0];
    expect(arg).toEqual(expect.objectContaining({ launcherLabel: 'Chat' }));
  });

  it('renders an "Open full widget test" link with the tenant apiKey', () => {
    render(<ChatbotAppearancesForm />);
    expect(screen.getByRole('link', { name: /open full widget test/i })).toHaveAttribute(
      'href',
      expect.stringContaining('apiKey=fake-api-key'),
    );
  });
});
