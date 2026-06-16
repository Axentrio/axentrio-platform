import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { SocialChannelsContent } from './SocialChannelsContent';

type Connection = {
  id: string;
  tenantId: string;
  channel: 'telegram' | 'messenger' | 'instagram';
  status: 'active' | 'disconnected' | 'error' | 'pending_setup';
  label: string | null;
  platformAccountId: string | null;
  config: Record<string, unknown>;
  lastHealthCheckAt: string | null;
  lastError: string | null;
  lastInboundAt: string | null;
  lastOutboundAt: string | null;
  createdAt: string;
  updatedAt: string;
};

const { connectionsRef, healthCheckMutate } = vi.hoisted(() => ({
  connectionsRef: { current: [] as Connection[] },
  healthCheckMutate: vi.fn(),
}));

vi.mock('../../queries/useChannelQueries', () => ({
  useChannelConnections: () => ({ data: connectionsRef.current, isLoading: false }),
  useConnectWhatsApp: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useMetaOAuthUrl: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useMetaOAuthPages: () => ({ data: undefined }),
  useConnectMeta: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useDisconnectChannel: () => ({ mutate: vi.fn() }),
  useUpdateChannelBot: () => ({ mutate: vi.fn(), isPending: false }),
  useUpdateChannelAutoCapture: () => ({ mutate: vi.fn(), isPending: false }),
  useHealthCheckChannel: () => ({
    mutate: healthCheckMutate,
    isPending: false,
    variables: undefined,
  }),
}));

vi.mock('@/queries/useBotsQueries', () => ({
  useBots: () => ({ data: { bots: [], used: 0, limit: null } }),
}));

// Channel entitlements: all on by default (Pro-like) so existing behaviors
// are unchanged; locked-state tests can flip entries.
const { entitledRef } = vi.hoisted(() => ({
  entitledRef: { current: {} as Record<string, boolean> },
}));
vi.mock('../../queries/useEntitlementsQueries', () => ({
  useHasFeature: (key: string) => entitledRef.current[key] ?? true,
  // Channel locks now key off the ceiling (useIsEntitled). No tenant toggles in
  // these tests → ceiling == effective, same mock.
  useIsEntitled: (key: string) => entitledRef.current[key] ?? true,
}));

// The component invalidates the entitlements query on mount; no provider in
// these tests, so stub the query client surface it touches.
vi.mock('@tanstack/react-query', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-query')>();
  return { ...actual, useQueryClient: () => ({ invalidateQueries: vi.fn() }) };
});

function renderUI() {
  return render(
    <MemoryRouter>
      <SocialChannelsContent />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  entitledRef.current = {};
  connectionsRef.current = [];
  healthCheckMutate.mockReset();
});

describe('SocialChannelsContent', () => {
  it('shows the empty state when no channels are connected', () => {
    renderUI();
    expect(screen.getByText(/no channels connected yet/i)).toBeInTheDocument();
    expect(
      screen.getByText(/connect a facebook page or whatsapp number to get started/i),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /facebook/i })).toBeInTheDocument();
  });

  it('renders a connected account with its status badge', () => {
    connectionsRef.current = [
      {
        id: 'conn-1',
        tenantId: 't-1',
        channel: 'telegram',
        status: 'active',
        label: 'Support Bot',
        platformAccountId: '12345',
        config: {},
        lastHealthCheckAt: null,
        lastError: null,
        lastInboundAt: null,
        lastOutboundAt: null,
        createdAt: '2026-05-12T00:00:00Z',
        updatedAt: '2026-05-12T00:00:00Z',
      },
    ];
    renderUI();
    expect(screen.getByText('Support Bot')).toBeInTheDocument();
    // The telegram connect button was removed; "Telegram" now appears only as the
    // row label of the existing connection.
    expect(screen.getAllByText('Telegram').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('active')).toBeInTheDocument();
    expect(screen.getByText(/1 channel connected/i)).toBeInTheDocument();
  });

  it('renders activity timestamps when lastInboundAt and lastOutboundAt are present', () => {
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    connectionsRef.current = [
      {
        id: 'conn-1',
        tenantId: 't-1',
        channel: 'telegram',
        status: 'active',
        label: 'Support Bot',
        platformAccountId: '12345',
        config: {},
        lastHealthCheckAt: null,
        lastError: null,
        lastInboundAt: oneHourAgo,
        lastOutboundAt: tenMinAgo,
        createdAt: '2026-05-12T00:00:00Z',
        updatedAt: '2026-05-12T00:00:00Z',
      },
    ];
    renderUI();
    expect(screen.getByText(/Received\s+1h ago/i)).toBeInTheDocument();
    expect(screen.getByText(/Sent\s+10m ago/i)).toBeInTheDocument();
  });

  it('locks connect buttons and shows plan-locked on connections when channels are unentitled', () => {
    entitledRef.current = {
      channelTelegram: false,
      channelWhatsapp: false,
      channelMessenger: false,
      channelInstagram: false,
    };
    connectionsRef.current = [
      {
        id: 'conn-1',
        tenantId: 't-1',
        channel: 'telegram',
        status: 'active',
        label: 'Support Bot',
        platformAccountId: '12345',
        config: {},
        lastHealthCheckAt: null,
        lastError: null,
        lastInboundAt: null,
        lastOutboundAt: null,
        createdAt: '2026-05-12T00:00:00Z',
        updatedAt: '2026-05-12T00:00:00Z',
      },
    ];
    renderUI();
    expect(screen.getByRole('button', { name: /facebook/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /whatsapp/i })).toBeDisabled();
    // Connected-but-locked row explains why it went quiet (D4).
    expect(screen.getByText(/plan locked/i)).toBeInTheDocument();
  });

  it('fires the health-check mutation when the refresh button is clicked', async () => {
    const user = userEvent.setup();
    connectionsRef.current = [
      {
        id: 'conn-1',
        tenantId: 't-1',
        channel: 'telegram',
        status: 'active',
        label: 'Support Bot',
        platformAccountId: '12345',
        config: {},
        lastHealthCheckAt: null,
        lastError: null,
        lastInboundAt: null,
        lastOutboundAt: null,
        createdAt: '2026-05-12T00:00:00Z',
        updatedAt: '2026-05-12T00:00:00Z',
      },
    ];
    renderUI();
    const checkBtn = screen.getByRole('button', { name: /check connection health/i });
    await user.click(checkBtn);
    expect(healthCheckMutate).toHaveBeenCalledWith('conn-1');
  });
});
