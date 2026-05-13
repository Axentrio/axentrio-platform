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
  useConnectTelegram: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useMetaOAuthUrl: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useMetaOAuthPages: () => ({ data: undefined }),
  useConnectMeta: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useDisconnectChannel: () => ({ mutate: vi.fn() }),
  useHealthCheckChannel: () => ({
    mutate: healthCheckMutate,
    isPending: false,
    variables: undefined,
  }),
}));

function renderUI() {
  return render(
    <MemoryRouter>
      <SocialChannelsContent />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  connectionsRef.current = [];
  healthCheckMutate.mockReset();
});

describe('SocialChannelsContent', () => {
  it('shows the empty state when no channels are connected', () => {
    renderUI();
    expect(screen.getByText(/no channels connected yet/i)).toBeInTheDocument();
    expect(
      screen.getByText(/connect a telegram bot or facebook page to get started/i),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /telegram/i })).toBeInTheDocument();
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
    // "Telegram" appears in both the connect button and the row label.
    expect(screen.getAllByText('Telegram').length).toBeGreaterThanOrEqual(2);
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

  it('shows the BotFather quick-start help in the Telegram modal', async () => {
    const user = userEvent.setup();
    renderUI();
    await user.click(screen.getByRole('button', { name: /telegram/i }));
    // Disclosure summary is visible immediately.
    expect(screen.getByText(/Don't have a bot token yet/i)).toBeInTheDocument();
    // Link to BotFather is present and points at the right URL with safe rel.
    const link = screen.getByRole('link', { name: /@BotFather/i });
    expect(link).toHaveAttribute('href', 'https://t.me/BotFather');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link.getAttribute('rel') ?? '').toMatch(/noopener/);
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
