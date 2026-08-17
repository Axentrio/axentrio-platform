/**
 * The chatbot setup step's install block.
 *
 * The snippet must come from GET /bots/:id/embed (server-built host). This test
 * pins that the configure path shows it, and that a failed embed fetch never
 * blocks Continue.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
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

function mockApis({ embedError = false } = {}) {
  apiGet.mockImplementation((url: string) => {
    if (url.startsWith('/tenants/me/ai-settings')) {
      return Promise.resolve({
        brandVoice: { name: 'Sofie', tone: 'friendly' },
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
  return render(
    <QueryClientProvider client={client}>
      <ChatbotStep submit={submit} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  apiGet.mockReset();
  apiPatch.mockReset().mockResolvedValue({});
});

describe('ChatbotStep — widget install', () => {
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
