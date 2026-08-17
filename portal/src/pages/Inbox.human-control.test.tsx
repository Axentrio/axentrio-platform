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
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { AxiosError, AxiosHeaders } from 'axios';
import type { Chat } from '@app-types/index';

const { apiGet, apiPost, registerHandlersMock, capturedHandlers } = vi.hoisted(() => ({
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
  useHandoffsQuery: () => ({ handoffs: [], pendingCount: 0 }),
  useAcceptHandoff: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useRejectHandoff: () => ({ mutateAsync: vi.fn(), isPending: false }),
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
  tenantSettingsRef.current = undefined;
  __resetConversationLiveState();
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
    await user.click(await screen.findByText('For 2 hours'));

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

  it('posts the modeless legacy body for "Until I hand back — AI stays blocked"', async () => {
    apiPost.mockResolvedValue(claimedResponse({ mode: 'indefinite' }));
    const user = userEvent.setup();
    renderInbox(makeChat({ ownership: 'handoff_requested' }));

    await user.click(await screen.findByRole('button', { name: /Take Over/ }));
    await user.click(await screen.findByText('Until I hand back — AI stays blocked'));

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
    expect(await screen.findByRole('menuitem', { name: /For 4 hours/i })).toHaveAttribute(
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
    await user.click(await screen.findByText('For 8 hours'));

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
    await user.click(await screen.findByText('Until I hand back — AI stays blocked'));

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
    await user.click(await screen.findByText('For 8 hours'));

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
    await user.click(await screen.findByText('Until I hand back — AI stays blocked'));

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
    await user.click(await screen.findByText('Until I hand back — AI stays blocked'));

    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(toast.error).toHaveBeenCalledWith(
      expect.stringMatching(/already taken over/i),
    );
  });
});
