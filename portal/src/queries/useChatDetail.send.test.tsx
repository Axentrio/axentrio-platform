/**
 * Tests for the acknowledged composer (B-PR3b §2): useChatDetail.sendMessage /
 * retryMessage over POST /chats/:sessionId/messages.
 *
 * Covers: one optimistic→reconciled message (no duplicate) that claims the
 * conversation; a 409 keeps the draft (bubble removed, caller keeps text); a
 * network failure flips the bubble to FAILED and a retry re-sends the SAME
 * clientMessageId without double-inserting; the socket copy arriving first
 * does not produce a duplicate either.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import { AxiosError, AxiosHeaders } from 'axios';

const { apiGet, apiPost } = vi.hoisted(() => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
}));

vi.mock('../services/apiClient', async () => {
  const actual = await vi.importActual<typeof import('../services/apiClient')>(
    '../services/apiClient',
  );
  return {
    ...actual,
    api: {
      get: apiGet,
      post: apiPost,
      put: vi.fn(),
      patch: vi.fn(),
      delete: vi.fn(),
    },
  };
});

vi.mock('@websocket/SocketContext', () => ({
  useSocket: () => ({
    isConnected: true,
    isConnecting: false,
    connectionError: null,
    registerHandlers: vi.fn(() => 'handler-1'),
    unregisterHandlers: vi.fn(),
    joinChat: vi.fn(),
    leaveChat: vi.fn(),
    sendTyping: vi.fn(),
    updateStatus: vi.fn(),
    reconnect: vi.fn(),
  }),
}));

import { useChatDetail } from './useChatQueries';
import { applyMessageCreated, __resetConversationLiveState } from './conversationLive';
import { queryKeys } from './queryKeys';

const CHAT_ID = 'sess-1';

function chatDetailPayload() {
  return {
    id: CHAT_ID,
    sessionId: CHAT_ID,
    tenantId: 't1',
    status: 'handoff', // backend vocabulary — must be normalized on entry
    messages: [],
  };
}

function conflictError(code: string): AxiosError {
  const err = new AxiosError('Conflict', 'ERR_BAD_REQUEST');
  err.response = {
    status: 409,
    statusText: 'Conflict',
    headers: {},
    config: { headers: new AxiosHeaders() } as never,
    data: { success: false, error: { code, message: 'Another operator owns this conversation' } },
  };
  return err;
}

let queryClient: QueryClient;

function makeWrapper() {
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

async function setup() {
  apiGet.mockResolvedValue(chatDetailPayload());
  const view = renderHook(() => useChatDetail(CHAT_ID), { wrapper: makeWrapper() });
  await waitFor(() => expect(view.result.current.chat).not.toBeNull());
  return view;
}

beforeEach(() => {
  vi.clearAllMocks();
  __resetConversationLiveState();
});

describe('useChatDetail.sendMessage', () => {
  it('normalizes the detail status into the portal vocabulary on fetch', async () => {
    const { result } = await setup();
    expect(result.current.chat?.status).toBe('handsoff');
  });

  it('creates ONE optimistic→reconciled message and folds in the auto-claim', async () => {
    const { result } = await setup();

    let resolvePost!: (v: unknown) => void;
    apiPost.mockImplementation(() => new Promise((resolve) => { resolvePost = resolve; }));

    let sendPromise!: Promise<unknown>;
    act(() => {
      sendPromise = result.current.sendMessage('  hello there  ');
    });

    // Optimistic PENDING bubble is in the thread immediately.
    await waitFor(() => expect(result.current.messages).toHaveLength(1));
    expect(result.current.messages[0]).toMatchObject({
      content: 'hello there',
      sender: 'agent',
      deliveryState: 'pending',
    });
    const clientMessageId = result.current.messages[0].clientMessageId!;
    expect(clientMessageId).toBeTruthy();
    expect(apiPost).toHaveBeenCalledWith(`/chats/${CHAT_ID}/messages`, {
      clientMessageId,
      content: 'hello there',
    });

    await act(async () => {
      resolvePost({
        outcome: 'sent',
        autoClaimed: true,
        message: { id: 'srv-1', createdAt: '2026-08-14T12:00:00.000Z' },
        conversation: {
          sessionId: CHAT_ID,
          tenantId: 't1',
          status: 'active',
          ownership: 'human',
          ownershipVersion: 2,
          assignedAgentId: 'me',
        },
      });
      await expect(sendPromise).resolves.toEqual({ status: 'sent' });
    });

    // Reconciled: ONE message, server id, delivered. (waitFor: React Query
    // batches subscriber notifications, so the re-render lands async.)
    await waitFor(() => expect(result.current.messages[0]?.id).toBe('srv-1'));
    expect(result.current.messages).toHaveLength(1);
    expect(result.current.messages[0]).toMatchObject({
      id: 'srv-1',
      clientMessageId,
      deliveryState: 'sent',
    });
    // The auto-claim flipped ownership on the open thread (no follow-up GET).
    await waitFor(() =>
      expect(result.current.chat).toMatchObject({
        status: 'human',
        ownership: 'human',
        assignedAgentId: 'me',
      }),
    );
    expect(apiGet).toHaveBeenCalledTimes(1); // the initial detail fetch only
  });

  it('does not double-add when the socket message:created copy arrives before the POST resolves', async () => {
    const { result } = await setup();

    let resolvePost!: (v: unknown) => void;
    apiPost.mockImplementation(() => new Promise((resolve) => { resolvePost = resolve; }));

    let sendPromise!: Promise<unknown>;
    act(() => {
      sendPromise = result.current.sendMessage('race me');
    });
    await waitFor(() => expect(result.current.messages).toHaveLength(1));
    const clientMessageId = result.current.messages[0].clientMessageId!;

    // The socket copy lands first, carrying the clientMessageId in metadata
    // (the wire field the server dedupes on).
    act(() => {
      applyMessageCreated(queryClient, {
        sessionId: CHAT_ID,
        conversationRevision: 100,
        message: {
          id: 'srv-2',
          sessionId: CHAT_ID,
          type: 'text',
          content: 'race me',
          senderType: 'agent',
          sender: 'agent',
          status: 'sent',
          createdAt: '2026-08-14T12:00:00.000Z',
          timestamp: '2026-08-14T12:00:00.000Z',
          metadata: { clientMessageId },
        },
      });
    });
    // Reconciled in the cache, not appended.
    await waitFor(() => expect(result.current.messages[0]?.id).toBe('srv-2'));
    expect(result.current.messages).toHaveLength(1);

    await act(async () => {
      resolvePost({
        outcome: 'sent',
        autoClaimed: false,
        message: { id: 'srv-2', createdAt: '2026-08-14T12:00:00.000Z' },
      });
      await sendPromise;
    });

    await waitFor(() =>
      expect(result.current.messages[0]).toMatchObject({
        id: 'srv-2',
        clientMessageId,
        deliveryState: 'sent',
      }),
    );
    expect(result.current.messages).toHaveLength(1);
  });

  it('409: removes the bubble (message NOT persisted) and reports conflict so the caller keeps the draft', async () => {
    const { result } = await setup();
    apiPost.mockRejectedValue(conflictError('conversation_already_claimed'));

    let outcome: unknown;
    await act(async () => {
      outcome = await result.current.sendMessage('my draft');
    });

    expect(outcome).toMatchObject({ status: 'conflict', code: 'conversation_already_claimed' });
    // Bubble gone, nothing fake in the thread.
    await waitFor(() => expect(result.current.messages).toHaveLength(0));
  });

  it('403 operator_not_in_tenant: same keep-draft conflict as a 409', async () => {
    const { result } = await setup();
    const err = conflictError('operator_not_in_tenant');
    err.response!.status = 403;
    err.response!.statusText = 'Forbidden';
    apiPost.mockRejectedValue(err);

    let outcome: unknown;
    await act(async () => {
      outcome = await result.current.sendMessage('my draft');
    });

    expect(outcome).toMatchObject({ status: 'conflict', code: 'operator_not_in_tenant' });
    await waitFor(() => expect(result.current.messages).toHaveLength(0));
  });

  it('network failure: bubble flips to FAILED; retry re-sends the SAME clientMessageId and never double-inserts', async () => {
    const { result } = await setup();
    apiPost.mockRejectedValueOnce(new AxiosError('Network Error', 'ERR_NETWORK'));

    await act(async () => {
      await expect(result.current.sendMessage('flaky')).resolves.toMatchObject({ status: 'failed' });
    });
    await waitFor(() => expect(result.current.messages[0]?.deliveryState).toBe('failed'));
    expect(result.current.messages).toHaveLength(1);
    const clientMessageId = result.current.messages[0].clientMessageId!;

    // Retry: server dedupes on clientMessageId ('duplicate' outcome is a success).
    apiPost.mockResolvedValueOnce({
      outcome: 'duplicate',
      autoClaimed: false,
      message: { id: 'srv-3', createdAt: '2026-08-14T12:05:00.000Z' },
    });
    await act(async () => {
      await expect(result.current.retryMessage(clientMessageId)).resolves.toEqual({ status: 'sent' });
    });

    expect(apiPost).toHaveBeenCalledTimes(2);
    expect(apiPost.mock.calls[0][1]).toMatchObject({ clientMessageId, content: 'flaky' });
    expect(apiPost.mock.calls[1][1]).toMatchObject({ clientMessageId, content: 'flaky' });
    await waitFor(() =>
      expect(result.current.messages[0]).toMatchObject({ id: 'srv-3', deliveryState: 'sent' }),
    );
    expect(result.current.messages).toHaveLength(1);
  });

  it('a retry that 409s KEEPS the bubble (the text stays recoverable)', async () => {
    const { result } = await setup();

    // First send fails on the network — bubble goes FAILED, draft cleared by
    // the composer (the bubble is now the only copy of the text).
    apiPost.mockRejectedValueOnce(new AxiosError('Network Error', 'ERR_NETWORK'));
    await act(async () => {
      await result.current.sendMessage('precious text');
    });
    await waitFor(() => expect(result.current.messages[0]?.deliveryState).toBe('failed'));
    const clientMessageId = result.current.messages[0].clientMessageId!;

    // The retry hits a 409 — another operator took the conversation.
    apiPost.mockRejectedValueOnce(conflictError('conversation_already_claimed'));
    let outcome: unknown;
    await act(async () => {
      outcome = await result.current.retryMessage(clientMessageId);
    });

    expect(outcome).toMatchObject({ status: 'conflict', code: 'conversation_already_claimed' });
    // The bubble is NOT removed: still there, still retryable, text intact.
    await waitFor(() => expect(result.current.messages).toHaveLength(1));
    expect(result.current.messages[0]).toMatchObject({
      clientMessageId,
      content: 'precious text',
      deliveryState: 'failed',
    });
  });

  it('a late rejection never downgrades a bubble the socket already confirmed', async () => {
    const { result } = await setup();

    let rejectPost!: (e: unknown) => void;
    apiPost.mockImplementation(() => new Promise((_resolve, reject) => { rejectPost = reject; }));

    let sendPromise!: Promise<unknown>;
    act(() => {
      sendPromise = result.current.sendMessage('confirmed meanwhile');
    });
    await waitFor(() => expect(result.current.messages).toHaveLength(1));
    const clientMessageId = result.current.messages[0].clientMessageId!;

    // The socket confirms the message (identity match) while the POST hangs.
    act(() => {
      applyMessageCreated(queryClient, {
        sessionId: CHAT_ID,
        conversationRevision: 100,
        message: {
          id: 'srv-late',
          sessionId: CHAT_ID,
          type: 'text',
          content: 'confirmed meanwhile',
          senderType: 'agent',
          sender: 'agent',
          status: 'sent',
          createdAt: '2026-08-14T12:00:00.000Z',
          timestamp: '2026-08-14T12:00:00.000Z',
          metadata: { clientMessageId },
        },
      });
    });
    await waitFor(() => expect(result.current.messages[0]?.deliveryState).toBe('sent'));

    // The POST then dies on the network — the confirmed bubble must NOT flip
    // to FAILED.
    await act(async () => {
      rejectPost(new AxiosError('Network Error', 'ERR_NETWORK'));
      await expect(sendPromise).resolves.toMatchObject({ status: 'failed' });
    });
    expect(result.current.messages[0]).toMatchObject({
      id: 'srv-late',
      deliveryState: 'sent',
    });
  });

  it('a duplicate clientMessageId resolution against an already-present server copy does not double-insert', async () => {
    const { result } = await setup();

    // The server copy is already in the thread (e.g. reconnect refetch landed it).
    queryClient.setQueryData(queryKeys.chats.detail(CHAT_ID), (old: unknown) => ({
      ...(old as Record<string, unknown>),
      messages: [
        {
          id: 'srv-4',
          chatId: CHAT_ID,
          type: 'text',
          content: 'already here',
          sender: 'agent',
          isRead: true,
          createdAt: '2026-08-14T12:00:00.000Z',
        },
        {
          id: 'client-x',
          clientMessageId: 'client-x',
          chatId: CHAT_ID,
          type: 'text',
          content: 'already here',
          sender: 'agent',
          isRead: true,
          createdAt: '2026-08-14T12:00:00.000Z',
          deliveryState: 'failed',
        },
      ],
    }));

    apiPost.mockResolvedValueOnce({
      outcome: 'duplicate',
      autoClaimed: false,
      message: { id: 'srv-4', createdAt: '2026-08-14T12:00:00.000Z' },
    });
    await act(async () => {
      await expect(result.current.retryMessage('client-x')).resolves.toEqual({ status: 'sent' });
    });

    // The leftover optimistic bubble was dropped in favour of the server copy.
    await waitFor(() => expect(result.current.messages).toHaveLength(1));
    expect(result.current.messages[0]).toMatchObject({ id: 'srv-4', deliveryState: 'sent' });
  });

  it('seeds an empty detail cache so an optimistic send does not vanish', async () => {
    apiGet.mockImplementation(() => new Promise(() => {}));
    apiPost.mockResolvedValue({
      outcome: 'sent',
      autoClaimed: false,
      message: { id: 'srv-empty', createdAt: '2026-08-14T12:00:00.000Z' },
    });
    const view = renderHook(() => useChatDetail(CHAT_ID), { wrapper: makeWrapper() });

    await act(async () => {
      await expect(view.result.current.sendMessage('still here')).resolves.toEqual({ status: 'sent' });
    });

    const detail = queryClient.getQueryData<{ messages: Array<{ content: string }> }>(
      queryKeys.chats.detail(CHAT_ID),
    );
    expect(detail?.messages.some((m) => m.content === 'still here')).toBe(true);
  });
});
