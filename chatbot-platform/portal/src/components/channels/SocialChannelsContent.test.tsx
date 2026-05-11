import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
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
  createdAt: string;
  updatedAt: string;
};

const { connectionsRef } = vi.hoisted(() => ({
  connectionsRef: { current: [] as Connection[] },
}));

vi.mock('../../queries/useChannelQueries', () => ({
  useChannelConnections: () => ({ data: connectionsRef.current, isLoading: false }),
  useConnectTelegram: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useMetaOAuthUrl: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useMetaOAuthPages: () => ({ data: undefined }),
  useConnectMeta: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useDisconnectChannel: () => ({ mutate: vi.fn() }),
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
});
