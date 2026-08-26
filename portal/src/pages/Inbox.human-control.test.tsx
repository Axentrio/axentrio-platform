/**
 * Inbox-level tests for the B-PR5b timed human-control UX — the wire payloads
 * and the badge lifecycle, end to end through the real Inbox handlers.
 *
 * Fixtures use the REAL backend contract: a taken-over chat is
 * ownership:'human_owned' with status 'handoff' (deriveStatusFromOwnership
 * maps human_owned → 'handoff'; the portal normalizes it to 'handsoff').
 * The human-control UI gates on OWNERSHIP, never on status.
 *
 * Covered:
 *  - the action-bar Take Over menu posts { mode:'timed', hours:N } for a
 *    duration and a MODELESS body (idempotencyKey only) for "Until I return
 *    it to AI" (the pre-B-PR5a shape);
 *  - "Change duration" re-POSTs /takeover with an EXPLICIT { mode, hours? }
 *    (a same-owner re-claim with a mode is a policy update; indefinite
 *    converts a timed control), and the controls are SERIALIZED — disabled
 *    while a takeover/policy command is in flight;
 *  - the badge shows for ownership:'human_owned', hides when an upsert
 *    returns ownership to 'bot_owned', and a DELAYED stale-ownership upsert
 *    cannot resurrect it (the pane gets the sanitized patch);
 *  - an expired deadline renders "resuming…" and the client issues NO release
 *    (the server's expiry worker owns the flip).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, act, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { AxiosError, AxiosHeaders } from 'axios';
import type { Chat } from '@app-types/index';

const { apiGet, apiPost, registerHandlersMock, capturedHandlers, handoffState } = vi.hoisted(() => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  registerHandlersMock: vi.fn(),
  capturedHandlers: {
    current: null as null | {
      onConversationUpsert?: (event: unknown) => void;
      onMessageCreated?: (event: unknown) => void;
      onConnect?: () => void;
      onDisconnect?: () => void;
    },
  },
  handoffState: {
    handoffs: [] as Array<{
      id: string;
      chatId: string;
      tenantId: string;
      userId: string;
      userName: string;
      priority: 'medium';
      reason: 'user_request';
      status: 'pending';
      requestedAt: string;
      waitTime: number;
      messageCount: number;
    }>,
    pendingCount: 0,
    acceptMutate: vi.fn(),
    rejectMutate: vi.fn(),
  },
}));

vi.mock('@services/apiClient', () => ({
  api: {
    get: apiGet,
    post: apiPost,
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
    download: vi.fn(),
  },
  handleApiError: (e: unknown) => e,
}));

vi.mock('@websocket/SocketContext', () => ({
  useSocket: () => ({
    isConnected: true,
    isConnecting: false,
    registerHandlers: registerHandlersMock,
    unregisterHandlers: vi.fn(),
    emit: vi.fn(),
    socket: null,
  }),
}));

vi.mock('@websocket/notificationSound', () => ({
  useNotificationSound: () => ({
    playMessage: vi.fn(),
    playHandoff: vi.fn(),
    isMuted: false,
    toggleMute: vi.fn(),
    setVolume: vi.fn(),
  }),
}));

vi.mock('../queries/useHandoffQueries', () => ({
  useHandoffsQuery: () => ({
    handoffs: handoffState.handoffs,
    pendingCount: handoffState.pendingCount,
  }),
  useAcceptHandoff: () => ({ mutateAsync: handoffState.acceptMutate, isPending: false }),
  useRejectHandoff: () => ({ mutateAsync: handoffState.rejectMutate, isPending: false }),
}));

const tenantSettingsRef = vi.hoisted(() => ({
  current: undefined as { settings?: { inbox?: { defaultTakeoverHours?: number | 'indefinite' } } } | undefined,
}));

vi.mock('../queries/useTenantQueries', () => ({
  useTenantSettings: () => ({ data: tenantSettingsRef.current }),
}));

// The list + window internals are not under test — keep the page light.
vi.mock('@components/ChatStream', () => ({ ChatStream: () => null }));
vi.mock('@components/ChatWindow', () => ({
  ChatWindow: () => <div data-testid="chat-window" />,
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

const authRef = vi.hoisted(() => ({ role: 'admin' as string }));
vi.mock('@auth/useAppAuth', () => ({
  useAppAuth: () => ({ user: { role: authRef.role } }),
}));

import Inbox from './Inbox';
import { toast } from 'sonner';
import { __resetConversationLiveState } from '../queries/conversationLive';

// ---------------------------------------------------------------------------
// Fixtures + harness
// ---------------------------------------------------------------------------

function makeChat(overrides: Partial<Chat> = {}): Chat {
  return {
    id: 'c1',
    sessionId: 'c1',
    tenantId: 't1',
    userId: 'v1',
    userName: 'Visitor',
    // Backend vocabulary on the wire; normalizeChatDetail maps it to
    // the portal's 'handsoff' on the deep-link path.
    status: 'handoff' as Chat['status'],
    messages: [],
    metadata: { source: 'widget' },
    createdAt: '2026-08-15T09:00:00.000Z',
    updatedAt: '2026-08-15T09:00:00.000Z',
    ...overrides,
  };
}

/** A taken-over chat: human_owned + status 'handoff' (the REAL contract). */
function makeOwnedChat(overrides: Partial<Chat> = {}): Chat {
  return makeChat({ ownership: 'human_owned', assignedAgentId: 'a1', ...overrides });
}

/** A committed takeover response summary (backend vocabulary): the claim
 *  commits ownership 'human_owned' and deriveStatusFromOwnership keeps the
 *  status at 'handoff'. */
function claimedResponse(policy: {
  mode: 'timed' | 'indefinite' | null;
  hours?: number;
  until?: string | null;
}) {
  return {
    outcome: 'claimed',
    conversation: {
      sessionId: 'c1',
      tenantId: 't1',
      status: 'handoff',
      ownership: 'human_owned',
      ownershipVersion: 5,
      assignedAgentId: 'a1',
      humanControlMode: policy.mode,
      humanControlDurationHours: policy.hours ?? null,
      humanControlUntil: policy.until ?? null,
      humanControlStartedAt: new Date().toISOString(),
      openHandoffId: null,
    },
  };
}

function renderInbox(chat: Chat) {
  // Deep-link selection: ?chat=c1 makes Inbox GET the chat and open it.
  apiGet.mockResolvedValue(chat);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/inbox?chat=c1']}>
        <Inbox />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { view, queryClient };
}

beforeEach(() => {
  vi.clearAllMocks();
  authRef.role = 'admin';
  tenantSettingsRef.current = undefined;
  __resetConversationLiveState();
  handoffState.handoffs = [];
  handoffState.pendingCount = 0;
  handoffState.acceptMutate.mockReset();
  handoffState.rejectMutate.mockReset();
  capturedHandlers.current = null;
  registerHandlersMock.mockImplementation((handlers) => {
    capturedHandlers.current = handlers;
    return 'h1';
  });
});

// ---------------------------------------------------------------------------
// Takeover menu payloads
// ---------------------------------------------------------------------------

describe('Inbox takeover duration menu', () => {
  it('posts { mode:"timed", hours:N } for a duration pick', async () => {
    const until = new Date(Date.now() + 2 * 3_600_000).toISOString();
    apiPost.mockResolvedValue(claimedResponse({ mode: 'timed', hours: 2, until }));
    const user = userEvent.setup();
    renderInbox(makeChat({ ownership: 'handoff_requested' }));

    await user.click(await screen.findByRole('button', { name: /Take Over/ }));
    await user.click(await screen.findByText('Return to AI in 2 hours'));

    await waitFor(() => expect(apiPost).toHaveBeenCalledTimes(1));
    expect(apiPost).toHaveBeenCalledWith('/chats/c1/takeover', {
      idempotencyKey: expect.any(String),
      mode: 'timed',
      hours: 2,
    });

    // The committed policy reaches the pane: the countdown badge appears.
    const badge = await screen.findByTestId('human-control-badge');
    expect(badge).toHaveTextContent(/resumes in (2h 0m|1h 59m)/);
  });

  it('posts the modeless legacy body for "Block AI — until I release"', async () => {
    apiPost.mockResolvedValue(claimedResponse({ mode: 'indefinite' }));
    const user = userEvent.setup();
    renderInbox(makeChat({ ownership: 'handoff_requested' }));

    await user.click(await screen.findByRole('button', { name: /Take Over/ }));
    await user.click(await screen.findByText('Block AI — until I release'));

    await waitFor(() => expect(apiPost).toHaveBeenCalledTimes(1));
    const [url, body] = apiPost.mock.calls[0];
    expect(url).toBe('/chats/c1/takeover');
    expect(Object.keys(body)).toEqual(['idempotencyKey']);

    // Indefinite control → the plain "you have control" badge.
    const badge = await screen.findByTestId('human-control-badge');
    expect(badge).toHaveAttribute('data-state', 'indefinite');
  });

  it('marks the tenant default duration in the Take Over menu', async () => {
    tenantSettingsRef.current = { settings: { inbox: { defaultTakeoverHours: 4 } } };
    const user = userEvent.setup();
    renderInbox(makeChat({ ownership: 'handoff_requested' }));

    await user.click(await screen.findByRole('button', { name: /Take Over/ }));
    expect(await screen.findByRole('menuitem', { name: /Return to AI in 4 hours/i })).toHaveAttribute(
      'data-default',
      'true',
    );
  });
});

// ---------------------------------------------------------------------------
// Change duration
// ---------------------------------------------------------------------------

describe('Inbox change duration', () => {
  it('re-POSTs /takeover with the new explicit mode/hours (indefinite converts)', async () => {
    const until = new Date(Date.now() + 30 * 60_000).toISOString();
    const user = userEvent.setup();
    renderInbox(
      makeOwnedChat({
        humanControlMode: 'timed',
        humanControlDurationHours: 1,
        humanControlUntil: until,
      }),
    );

    const newUntil = new Date(Date.now() + 8 * 3_600_000).toISOString();
    apiPost.mockResolvedValueOnce(claimedResponse({ mode: 'timed', hours: 8, until: newUntil }));
    await user.click(await screen.findByRole('button', { name: /Change duration/ }));
    await user.click(await screen.findByText('Return to AI in 8 hours'));

    await waitFor(() => expect(apiPost).toHaveBeenCalledTimes(1));
    expect(apiPost).toHaveBeenNthCalledWith(1, '/chats/c1/takeover', {
      idempotencyKey: expect.any(String),
      mode: 'timed',
      hours: 8,
    });
    // The badge re-arms onto the new deadline.
    await waitFor(() =>
      expect(screen.getByTestId('human-control-badge')).toHaveTextContent(
        /resumes in (8h 0m|7h 59m)/,
      ),
    );

    // Converting to indefinite sends the EXPLICIT mode (a modeless same-owner
    // re-claim would not update the policy).
    apiPost.mockResolvedValueOnce(claimedResponse({ mode: 'indefinite' }));
    await user.click(screen.getByRole('button', { name: /Change duration/ }));
    await user.click(await screen.findByText('Block AI — until I release'));

    await waitFor(() => expect(apiPost).toHaveBeenCalledTimes(2));
    expect(apiPost).toHaveBeenNthCalledWith(2, '/chats/c1/takeover', {
      idempotencyKey: expect.any(String),
      mode: 'indefinite',
    });
    await waitFor(() =>
      expect(screen.getByTestId('human-control-badge')).toHaveAttribute(
        'data-state',
        'indefinite',
      ),
    );
  });

  it('serializes policy commands: the control is disabled while a change is in flight', async () => {
    const until = new Date(Date.now() + 30 * 60_000).toISOString();
    const user = userEvent.setup();
    renderInbox(
      makeOwnedChat({
        humanControlMode: 'timed',
        humanControlDurationHours: 1,
        humanControlUntil: until,
      }),
    );

    // A deferred POST: the change stays on the wire until we resolve it.
    let resolvePost!: (value: unknown) => void;
    apiPost.mockImplementationOnce(
      () => new Promise((resolve) => { resolvePost = resolve; }),
    );

    const trigger = await screen.findByRole('button', { name: /Change duration/ });
    await user.click(trigger);
    await user.click(await screen.findByText('Return to AI in 8 hours'));

    // In flight: the trigger is disabled — a rapid second change cannot race
    // the first (same ownershipVersion, so the caches could not order them).
    await waitFor(() => expect(trigger).toBeDisabled());
    expect(apiPost).toHaveBeenCalledTimes(1);

    const newUntil = new Date(Date.now() + 8 * 3_600_000).toISOString();
    await act(async () => {
      resolvePost(claimedResponse({ mode: 'timed', hours: 8, until: newUntil }));
    });
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Change duration/ })).toBeEnabled(),
    );
  });
});

// ---------------------------------------------------------------------------
// Badge lifecycle
// ---------------------------------------------------------------------------

describe('Inbox human-control badge', () => {
  it('shows for ownership:"human_owned" (status stays handoff), hides on bot_owned, and a stale upsert cannot resurrect it', async () => {
    const until = new Date(Date.now() + 30 * 60_000).toISOString();
    renderInbox(
      makeOwnedChat({
        humanControlMode: 'timed',
        humanControlDurationHours: 1,
        humanControlUntil: until,
      }),
    );

    // Ownership — not status — gates the UI: the chat's status is 'handsoff'.
    const badge = await screen.findByTestId('human-control-badge');
    expect(badge).toHaveTextContent(/AI paused - resumes in (30:00|29:5\d)/);
    expect(screen.getByRole('button', { name: /Change duration/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Take Over/ })).not.toBeInTheDocument();

    // The expiry worker flips ownership back → the upsert clears the fields
    // and the badge goes away. No client-side release involved.
    act(() => {
      capturedHandlers.current?.onConversationUpsert?.({
        conversation: {
          id: 'c1',
          sessionId: 'c1',
          tenantId: 't1',
          status: 'bot',
          ownership: 'bot_owned',
          ownershipVersion: 9,
          assignedAgentId: null,
          humanControlMode: null,
          humanControlDurationHours: null,
          humanControlUntil: null,
        },
        revision: 1_000,
      });
    });
    await waitFor(() =>
      expect(screen.queryByTestId('human-control-badge')).not.toBeInTheDocument(),
    );

    // FIX 2 regression: a DELAYED pre-expiry upsert (higher revision, STALE
    // ownershipVersion) must not resurrect the badge — the pane receives the
    // sanitized patch, with the ownership-bearing fields stripped.
    act(() => {
      capturedHandlers.current?.onConversationUpsert?.({
        conversation: {
          id: 'c1',
          sessionId: 'c1',
          tenantId: 't1',
          status: 'handoff',
          ownership: 'human_owned',
          ownershipVersion: 8, // older than the applied 9
          assignedAgentId: 'a1',
          humanControlMode: 'timed',
          humanControlDurationHours: 1,
          humanControlUntil: until,
          lastMessage: 'still merges',
        },
        revision: 2_000, // NEWER revision — the clock cannot save us here
      });
    });
    expect(screen.queryByTestId('human-control-badge')).not.toBeInTheDocument();
    expect(apiPost).not.toHaveBeenCalled();
  });

  it('shows "resuming…" past the deadline and never issues a client-side release', async () => {
    renderInbox(
      makeOwnedChat({
        humanControlMode: 'timed',
        humanControlDurationHours: 1,
        humanControlUntil: new Date(Date.now() - 1_000).toISOString(),
      }),
    );

    const badge = await screen.findByTestId('human-control-badge');
    expect(badge).toHaveTextContent('AI resuming…');
    expect(badge).toHaveAttribute('data-state', 'resuming');
    // The server owns the expiry: the portal must not POST anything.
    expect(apiPost).not.toHaveBeenCalled();
  });
});

function takeoverError(status: number, code: string, details?: Record<string, unknown>): AxiosError {
  const err = new AxiosError(code, 'ERR_BAD_REQUEST');
  err.response = {
    status,
    statusText: status === 403 ? 'Forbidden' : status === 400 ? 'Bad Request' : 'Conflict',
    headers: {},
    config: { headers: new AxiosHeaders() } as never,
    data: { success: false, error: { code, message: code, details } },
  };
  return err;
}

describe('Inbox takeover failure toasts', () => {
  it('tells an operator with no support_agents row to ask an admin', async () => {
    apiPost.mockRejectedValue(takeoverError(403, 'operator_not_in_tenant'));
    const user = userEvent.setup();
    renderInbox(makeChat({ ownership: 'handoff_requested' }));

    await user.click(await screen.findByRole('button', { name: /Take Over/ }));
    await user.click(await screen.findByText('Block AI — until I release'));

    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(toast.error).toHaveBeenCalledWith(
      expect.stringMatching(/ask an admin to add you as a support agent/i),
    );
  });

  it('names that another operator already took the conversation', async () => {
    apiPost.mockRejectedValue(
      takeoverError(409, 'conversation_already_claimed', { assignedAgentId: 'op-other' }),
    );
    const user = userEvent.setup();
    renderInbox(makeChat({ ownership: 'handoff_requested' }));

    await user.click(await screen.findByRole('button', { name: /Take Over/ }));
    await user.click(await screen.findByText('Block AI — until I release'));

    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(toast.error).toHaveBeenCalledWith(
      expect.stringMatching(/already taken over/i),
    );
  });

  it('gives conversation_closed its own toast', async () => {
    apiPost.mockRejectedValue(takeoverError(409, 'conversation_closed'));
    const user = userEvent.setup();
    renderInbox(makeChat({ ownership: 'bot_owned', status: 'bot' }));

    await user.click(await screen.findByRole('button', { name: /Take Over/ }));
    await user.click(await screen.findByText('Block AI — until I release'));

    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(toast.error).toHaveBeenCalledWith('This conversation is closed.');
  });

  it('maps Accept handoff errors through the same takeoverFailureOf codes', async () => {
    handoffState.pendingCount = 1;
    handoffState.handoffs = [{
      id: 'h1',
      chatId: 'c1',
      tenantId: 't1',
      userId: 'v1',
      userName: 'Visitor',
      priority: 'medium',
      reason: 'user_request',
      status: 'pending',
      requestedAt: '2026-08-15T09:00:00.000Z',
      waitTime: 12,
      messageCount: 2,
    }];
    handoffState.acceptMutate.mockRejectedValue(takeoverError(409, 'conversation_closed'));

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/inbox?filter=handsoff']}>
          <Inbox />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /Accept/i }));
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(toast.error).toHaveBeenCalledWith('This conversation is closed.');
  });
});

describe('Inbox filter deep-link', () => {
  it('opens the Handoff queue from ?filter=handoff (/queue alias)', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/inbox?filter=handoff']}>
          <Inbox />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    expect(await screen.findByText('No pending handoffs')).toBeInTheDocument();
  });

  it('opens the Handoff queue from ?filter=handsoff', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/inbox?filter=handsoff']}>
          <Inbox />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    expect(await screen.findByText('No pending handoffs')).toBeInTheDocument();
  });
});

describe('Inbox takeover visibility', () => {
  it('offers Take Over on a bot-owned chat, not only during handoff', async () => {
    renderInbox(makeChat({ ownership: 'bot_owned', status: 'bot' }));
    expect(await screen.findByRole('button', { name: /Take Over/ })).toBeInTheDocument();
  });

  it('hides Take Over on a closed chat', async () => {
    renderInbox(makeChat({ ownership: 'bot_owned', status: 'closed' }));
    await screen.findByTestId('chat-window');
    expect(screen.queryByRole('button', { name: /Take Over/ })).not.toBeInTheDocument();
  });
});

describe('Inbox super-admin reset', () => {
  it('hides Reset for a tenant admin on a bot-owned chat', async () => {
    authRef.role = 'admin';
    renderInbox(makeChat({ ownership: 'bot_owned', status: 'bot' }));
    await screen.findByTestId('chat-window');
    expect(screen.queryByRole('button', { name: /^Reset$/ })).not.toBeInTheDocument();
  });

  it('shows Reset for a super admin on a bot-owned chat', async () => {
    authRef.role = 'super_admin';
    renderInbox(makeChat({ ownership: 'bot_owned', status: 'bot', channel: 'whatsapp' }));
    expect(await screen.findByRole('button', { name: /^Reset$/ })).toBeInTheDocument();
  });

  it('hides Reset when a super admin already owns the chat (Close covers that)', async () => {
    authRef.role = 'super_admin';
    renderInbox(makeOwnedChat());
    await screen.findByTestId('chat-window');
    expect(screen.queryByRole('button', { name: /^Reset$/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Close$/ })).toBeInTheDocument();
  });

  it('hides Reset on a closed chat', async () => {
    authRef.role = 'super_admin';
    renderInbox(makeChat({ ownership: 'bot_owned', status: 'closed' }));
    await screen.findByTestId('chat-window');
    expect(screen.queryByRole('button', { name: /^Reset$/ })).not.toBeInTheDocument();
  });

  it('hides Reset on a widget chat (the widget has its own control)', async () => {
    authRef.role = 'super_admin';
    renderInbox(makeChat({ ownership: 'bot_owned', status: 'bot', channel: 'widget' }));
    await screen.findByTestId('chat-window');
    expect(screen.queryByRole('button', { name: /^Reset$/ })).not.toBeInTheDocument();
  });

  it('POSTs /chats/:id/close after confirm', async () => {
    authRef.role = 'super_admin';
    apiPost.mockResolvedValue({ outcome: 'closed', conversation: { sessionId: 'c1', status: 'closed' } });
    const user = userEvent.setup();
    renderInbox(makeChat({ ownership: 'bot_owned', status: 'bot', channel: 'whatsapp' }));

    await user.click(await screen.findByRole('button', { name: /^Reset$/ }));
    const dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: /^Reset$/ }));

    await waitFor(() => expect(apiPost).toHaveBeenCalledTimes(1));
    expect(apiPost).toHaveBeenCalledWith('/chats/c1/close', {
      idempotencyKey: expect.any(String),
    });
  });
});

describe('Inbox transfer modal', () => {
  it('opens on the paginated { agents } payload instead of crashing', async () => {
    // GET /agents answers { agents: [...], meta } after the apiClient strips
    // the success envelope. Mapping that object directly crashed the whole
    // page (".map is not a function") the moment Transfer opened.
    // renderInbox() stamps apiGet.mockResolvedValue(chat) for the deep-link
    // GET — install the paginated /agents mock AFTER that, so it is not
    // overwritten.
    const user = userEvent.setup();
    renderInbox(makeOwnedChat());
    await screen.findByRole('button', { name: 'Transfer' });
    apiGet.mockImplementation((url: string) => {
      if (url === '/agents') {
        return Promise.resolve({
          agents: [
            { id: 'a2', name: 'Ann Other', status: 'online', currentChatCount: 0, maxConcurrentChats: 5 },
          ],
        });
      }
      return Promise.resolve(makeOwnedChat());
    });

    await user.click(screen.getByRole('button', { name: 'Transfer' }));

    expect(await screen.findByText('Transfer to teammate')).toBeInTheDocument();
    expect(await screen.findByText(/Ann/)).toBeInTheDocument();
    expect(screen.queryByText('Something went wrong')).not.toBeInTheDocument();
  });
});

