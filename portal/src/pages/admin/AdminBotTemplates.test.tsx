import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import AdminBotTemplates from './AdminBotTemplates';

// Mutable health-query state so each test drives the all-clear vs stranded branch.
const { state } = vi.hoisted(() => ({
  state: {
    health: { data: { bots: [], count: 0 }, isLoading: false, isError: false } as {
      data: unknown; isLoading: boolean; isError: boolean;
    },
  },
}));

vi.mock('@/queries/useBotTemplatesQueries', () => {
  const m = () => ({ mutate: () => {}, mutateAsync: async () => ({}), isPending: false });
  return {
    useAdminBotTemplates: () => ({ data: [], isLoading: false, isError: false }),
    useCreateBotTemplate: m,
    useUnavailableTemplates: () => state.health,
  };
});

const renderPage = () => render(
  <MemoryRouter>
    <AdminBotTemplates />
  </MemoryRouter>,
);

describe('AdminBotTemplates — template health panel (L9)', () => {
  it('shows the all-clear when no bots are stranded', () => {
    state.health = { data: { bots: [], count: 0 }, isLoading: false, isError: false };
    renderPage();
    expect(screen.getByText('Template health')).toBeInTheDocument();
    expect(screen.getByText('Every bound template resolves — no bots are stranded.')).toBeInTheDocument();
  });

  it('lists stranded bots with tenant, template, and the reason badge', () => {
    state.health = {
      data: {
        count: 1,
        bots: [{
          botId: 'b1', tenantId: 't1', botName: 'Front desk', templateId: 'tpl-x',
          pinnedVersion: 'latest', tenantName: 'Acme', reason: 'missing_or_archived',
        }],
      },
      isLoading: false,
      isError: false,
    };
    renderPage();
    expect(screen.getByText('Front desk')).toBeInTheDocument();
    expect(screen.getByText('Acme')).toBeInTheDocument();
    expect(screen.getByText('Missing or archived')).toBeInTheDocument();
    expect(screen.getByText('1 stranded')).toBeInTheDocument();
  });
});
