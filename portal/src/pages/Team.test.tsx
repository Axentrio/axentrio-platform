import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const { agentsRef, perfRef } = vi.hoisted(() => ({
  agentsRef: { current: [] as Array<Record<string, unknown>> },
  perfRef: { current: {} as Record<string, unknown> },
}));

vi.mock('../queries/useAgentQueries', () => ({
  useAgentList: () => ({ data: agentsRef.current, isLoading: false }),
  useAgentShifts: () => ({ data: { shifts: [] } }),
  useUpdateAgent: () => ({ mutate: vi.fn(), isPending: false }),
  useOptimisticUpdateAgentStatus: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock('../queries/useTenantQueries', () => ({
  useTenantMembers: () => ({ data: [], isLoading: false }),
  useTenantInvites: () => ({ data: [] }),
  useInviteMember: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }),
  useResendInvite: () => ({ mutate: vi.fn(), isPending: false }),
  useCancelInvite: () => ({ mutate: vi.fn(), isPending: false }),
  useOptimisticUpdateMemberRole: () => ({ mutate: vi.fn(), isPending: false }),
  useOptimisticDeactivateMember: () => ({ mutate: vi.fn(), isPending: false }),
  useOptimisticReactivateMember: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock('@services/apiClient', () => ({
  api: { get: vi.fn(async () => perfRef.current), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() },
  extractApiErrorMessage: () => null,
}));

import Team from './Team';

function agent(id: string) {
  return {
    id,
    name: `Agent ${id}`,
    email: `${id}@x.test`,
    role: 'agent',
    status: 'online',
    skills: [],
    maxConcurrentChats: 3,
    currentChatCount: 0,
    createdAt: '2026-06-01T00:00:00Z',
  };
}

function renderUI() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <Team />
    </QueryClientProvider>,
  );
}

async function switchTab(name: RegExp) {
  await userEvent.setup().click(screen.getByRole('tab', { name }));
}

beforeEach(() => {
  agentsRef.current = [];
  perfRef.current = { totalChatsHandled: 4, avgResponseTimeSeconds: 0, satisfactionScore: 0, currentChatCount: 1 };
});

describe('Team — zero agents (the common SMB case)', () => {
  it('hides the KPI row entirely instead of fabricating zeros', () => {
    renderUI();
    expect(screen.queryByText(/total agents/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/avg csat/i)).not.toBeInTheDocument();
  });

  it('explains agents on the Agents tab instead of a header-only table', async () => {
    renderUI();
    await switchTab(/agents/i);
    expect(screen.getByText(/no agents yet/i)).toBeInTheDocument();
    expect(screen.getByText(/take over conversations when the ai hands off/i)).toBeInTheDocument();
  });

  it('shows contextual empty states on Shifts and Performance', async () => {
    renderUI();
    await switchTab(/shifts/i);
    expect(screen.getByText(/add an agent first/i)).toBeInTheDocument();
    await switchTab(/performance/i);
    expect(screen.getByText(/once agents are handling handed-off conversations/i)).toBeInTheDocument();
  });
});

describe('Team — with agents', () => {
  beforeEach(() => {
    agentsRef.current = [agent('a1'), agent('a2')];
  });

  it('shows the honest KPI row ("Chats handled", not MTD) and hides CSAT while uncollected', async () => {
    renderUI();
    expect(await screen.findByText('Total Agents')).toBeInTheDocument();
    expect(screen.getByText('Chats handled')).toBeInTheDocument();
    expect(screen.queryByText(/\(MTD\)/)).not.toBeInTheDocument();
    expect(screen.queryByText(/avg csat/i)).not.toBeInTheDocument(); // satisfactionScore 0 everywhere
  });

  it('restores the CSAT card once satisfaction data exists', async () => {
    perfRef.current = { totalChatsHandled: 4, avgResponseTimeSeconds: 9, satisfactionScore: 4.2, currentChatCount: 1 };
    renderUI();
    expect(await screen.findByText('Avg CSAT')).toBeInTheDocument();
    expect(screen.getByText('4.2')).toBeInTheDocument();
  });

  it('performance table keeps only the populated columns', async () => {
    renderUI();
    await switchTab(/performance/i);
    expect(screen.getByText(/total chats/i)).toBeInTheDocument();
    expect(screen.queryByText(/avg response/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/csat score/i)).not.toBeInTheDocument();
  });
});
