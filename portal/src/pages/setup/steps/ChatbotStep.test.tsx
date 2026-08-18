/**
 * The chatbot setup step's install block.
 *
 * The snippet must come from GET /bots/:id/embed (server-built host). This test
 * pins that the configure path shows it, and that a failed embed fetch never
 * blocks Continue.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const { apiGet, apiPatch } = vi.hoisted(() => ({
  apiGet: vi.fn(),
  apiPatch: vi.fn(),
}));

vi.mock('@/services/apiClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/apiClient')>()),
  api: { get: apiGet, post: vi.fn(), put: vi.fn(), patch: apiPatch, delete: vi.fn() },
}));

import { ChatbotStep } from './ChatbotStep';
import type { SetupStatus } from '@/queries/useOnboardingQueries';
import type { StepProps } from './types';

const SNIPPET = '<script src="https://api.axentrio.test/widget.js" data-key="bk_anchor"></script>';

const ANCHOR_BOT = {
  id: 'bot-anchor',
  name: 'Main bot',
  status: 'active' as const,
  isDefault: true,
  publicKey: 'bk_anchor',
  aiEnabled: true,
  assistantName: 'Sofie',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

function mockApis({
  embedError = false,
  businessName,
}: { embedError?: boolean; businessName?: string } = {}) {
  apiGet.mockImplementation((url: string) => {
    if (url.startsWith('/tenants/me/ai-settings')) {
      return Promise.resolve({
        brandVoice: { name: 'Sofie', businessName, tone: 'friendly' },
        supportEmail: 'info@acme.be',
      });
    }
    if (url === '/bots') {
      return Promise.resolve({ bots: [ANCHOR_BOT], used: 1, limit: null });
    }
    if (url === '/bots/bot-anchor/embed') {
      return embedError
        ? Promise.reject(new Error('embed failed'))
        : Promise.resolve({ snippet: SNIPPET, publicKey: 'bk_anchor' });
    }
    return Promise.reject(new Error(`unexpected GET ${url}`));
  });
}

function renderStep() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const submit = {
    mutate: vi.fn(),
    isPending: false,
  } as unknown as StepProps['submit'];
  const status: SetupStatus = {
    state: {
      version: 1,
      startedAt: '2026-01-01T00:00:00.000Z',
      completedAt: null,
      language: 'en',
      company: { vatNumber: 'BE0123456789', name: 'Acme BV' },
      steps: { company: 'done' },
    },
    nextStep: 'chatbot',
    complete: false,
  };
  const view = render(
    <QueryClientProvider client={client}>
      <ChatbotStep status={status} submit={submit} />
    </QueryClientProvider>,
  );
  return { ...view, client };
}

beforeEach(() => {
  apiGet.mockReset();
  apiPatch.mockReset().mockResolvedValue({});
});

describe('ChatbotStep — widget install', () => {
  it('seeds the company name and submits it in brand voice', async () => {
    mockApis();
    const { client } = renderStep();
    const invalidateQueries = vi.spyOn(client, 'invalidateQueries');

    const companyName = await screen.findByRole('textbox', { name: /company name/i });
    await waitFor(() =>
      expect(screen.getByRole('textbox', { name: /assistant name/i })).toHaveValue('Sofie'),
    );
    expect(companyName).toHaveValue('Acme BV');
    fireEvent.change(companyName, { target: { value: '  Acme Services  ' } });
    fireEvent.click(screen.getByRole('button', { name: /continue/i }));

    await waitFor(() =>
      expect(apiPatch).toHaveBeenCalledWith('/tenants/me/ai-settings', {
        enabled: true,
        supportEmail: 'info@acme.be',
        brandVoice: { name: 'Sofie', businessName: 'Acme Services', tone: 'friendly' },
      }),
    );
    await waitFor(() =>
      expect(
        invalidateQueries.mock.calls.filter(([filters]) =>
          filters?.queryKey?.every((key, index) => key === ['tenants', 'me'][index]),
        ),
      ).toHaveLength(2),
    );
  });

  it('keeps a saved trading name when the step is revisited', async () => {
    mockApis({ businessName: 'Acme Repairs' });
    renderStep();

    const companyName = await screen.findByRole('textbox', { name: /company name/i });
    await waitFor(() => expect(companyName).toHaveValue('Acme Repairs'));
    fireEvent.click(screen.getByRole('button', { name: /continue/i }));

    await waitFor(() =>
      expect(apiPatch).toHaveBeenCalledWith('/tenants/me/ai-settings', {
        enabled: true,
        supportEmail: 'info@acme.be',
        brandVoice: { name: 'Sofie', businessName: 'Acme Repairs', tone: 'friendly' },
      }),
    );
  });

  it('omits a blank trading name so it inherits the tenant name', async () => {
    mockApis();
    renderStep();

    const companyName = await screen.findByRole('textbox', { name: /company name/i });
    await waitFor(() =>
      expect(screen.getByRole('textbox', { name: /assistant name/i })).toHaveValue('Sofie'),
    );
    fireEvent.change(companyName, {
      target: { value: '   ' },
    });
    fireEvent.click(screen.getByRole('button', { name: /continue/i }));

    await waitFor(() => expect(apiPatch).toHaveBeenCalledWith('/tenants/me/ai-settings', expect.anything()));
    expect(apiPatch.mock.calls[0][1].brandVoice).not.toHaveProperty('businessName');
  });

  it('shows the install title and copy button when the embed snippet is ready', async () => {
    mockApis();
    renderStep();

    expect(await screen.findByText(/install the chat widget/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /copy snippet/i })).toBeInTheDocument();
  });

  it('still lets the customer continue when the embed snippet fails to load', async () => {
    mockApis({ embedError: true });
    renderStep();

    const continueButton = await screen.findByRole('button', { name: /continue/i });
    await waitFor(() => expect(continueButton).toBeEnabled());
    expect(screen.queryByRole('button', { name: /copy snippet/i })).not.toBeInTheDocument();
  });
});
