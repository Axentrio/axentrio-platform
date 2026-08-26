import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';

const { apiGet, apiPost } = vi.hoisted(() => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
}));

vi.mock('../services/apiClient', () => ({
  api: {
    get: apiGet,
    post: apiPost,
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
}));

vi.mock('@clerk/clerk-react', () => ({
  useAuth: () => ({ getToken: async () => 'token' }),
}));

import {
  useClearCopilotConversation,
  useCopilotConversation,
  type CopilotConversationResponse,
} from './useCopilotQueries';

function makeWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

const TRANSCRIPT: CopilotConversationResponse = {
  conversationId: 'c1',
  nextCursor: null,
  messages: [
    {
      id: 'm1',
      turn: 0,
      role: 'user',
      content: 'wat zijn mijn openingsuren?',
      createdAt: '2026-08-25T10:00:00.000Z',
    },
    {
      id: 'm2',
      turn: 1,
      role: 'assistant',
      content: 'Mon 09:00–17:00',
      toolsCalled: [{ name: 'getOpeningHours', outcome: 'success' }],
      outcome: 'success',
      tokensIn: 10,
      tokensOut: 20,
      latencyMs: 100,
      createdAt: '2026-08-25T10:00:01.000Z',
    },
  ],
};

beforeEach(() => {
  apiGet.mockReset();
  apiPost.mockReset();
});

describe('useCopilotConversation', () => {
  it('keeps the unwrapped transcript the api client already returned', async () => {
    apiGet.mockResolvedValueOnce(TRANSCRIPT);

    const { result } = renderHook(() => useCopilotConversation(), {
      wrapper: makeWrapper(),
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(apiGet).toHaveBeenCalledWith('/copilot/conversation');
    expect(result.current.data).toEqual(TRANSCRIPT);
    expect(result.current.data?.messages).toHaveLength(2);
  });
});

describe('useClearCopilotConversation', () => {
  it('treats the unwrapped clear payload as success', async () => {
    apiPost.mockResolvedValueOnce({ cleared: true });

    const { result } = renderHook(() => useClearCopilotConversation(), {
      wrapper: makeWrapper(),
    });

    result.current.mutate();

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(apiPost).toHaveBeenCalledWith('/copilot/conversation/clear');
    expect(result.current.data).toEqual({ cleared: true });
  });
});
