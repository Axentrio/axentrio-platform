import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import AdminBotTemplates from './AdminBotTemplates';

// Mutable query state so each test drives health (all-clear vs stranded) and the
// template list (tier grouping) independently.
const { state, createSpy } = vi.hoisted(() => ({
  state: {
    health: { data: { bots: [], count: 0 }, isLoading: false, isError: false } as {
      data: unknown; isLoading: boolean; isError: boolean;
    },
    templates: [] as unknown[],
  },
  createSpy: vi.fn(async () => ({ template: { id: 'new1' } })),
}));

vi.mock('@/queries/useBotTemplatesQueries', () => {
  return {
    useAdminBotTemplates: () => ({ data: state.templates, isLoading: false, isError: false }),
    useCreateBotTemplate: () => ({ mutate: () => {}, mutateAsync: createSpy, isPending: false }),
    useUnavailableTemplates: () => state.health,
    useAdminSkills: () => ({ data: [{ id: 'booking', displayName: 'Bookings' }] }),
  };
});

beforeEach(() => {
  state.templates = [];
  state.health = { data: { bots: [], count: 0 }, isLoading: false, isError: false };
});

const tpl = (over: Record<string, unknown>) => ({
  id: 'x', key: 'k', displayName: 'X', category: null, description: null, tier: 'essential',
  availableToAllTenants: true, status: 'active', skills: [], versionCount: 0, draftCount: 0, latestPublishedVersion: null,
  ...over,
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

describe('AdminBotTemplates — tiered tables', () => {
  it('groups each template under its own tier table, with no crossover', () => {
    state.templates = [
      tpl({ id: 'e1', displayName: 'Ess Bot', tier: 'essential' }),
      tpl({ id: 'p1', displayName: 'Pro Bot', tier: 'pro' }),
    ];
    renderPage();

    const proSection = screen.getByRole('heading', { name: 'Pro' }).closest('section')!;
    expect(within(proSection).getByText('Pro Bot')).toBeInTheDocument();
    expect(within(proSection).queryByText('Ess Bot')).not.toBeInTheDocument();

    const essSection = screen.getByRole('heading', { name: 'Essential' }).closest('section')!;
    expect(within(essSection).getByText('Ess Bot')).toBeInTheDocument();

    // Enterprise has none → its create-invitation shows instead of a table.
    expect(screen.getByText(/No Enterprise templates yet/i)).toBeInTheDocument();
  });

  it('sends the chosen tier on create', async () => {
    createSpy.mockClear();
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: /create template/i }));
    const dialog = screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText(/key/i), { target: { value: 'pro-x' } });
    fireEvent.change(within(dialog).getByLabelText(/display name/i), { target: { value: 'Pro X' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Pro' }));
    fireEvent.click(within(dialog).getByRole('button', { name: /create template/i }));
    await waitFor(() => expect(createSpy).toHaveBeenCalledWith(expect.objectContaining({ tier: 'pro' })));
  });
});

describe('AdminBotTemplates — create dialog vertical', () => {
  it('captures Vertical and sends it as category on create', async () => {
    state.health = { data: { bots: [], count: 0 }, isLoading: false, isError: false };
    createSpy.mockClear();
    renderPage();

    // Open the create dialog from the header action.
    fireEvent.click(screen.getByRole('button', { name: /create template/i }));
    const dialog = screen.getByRole('dialog');

    fireEvent.change(within(dialog).getByLabelText(/key/i), { target: { value: 'plumber-x' } });
    fireEvent.change(within(dialog).getByLabelText(/display name/i), { target: { value: 'Plumber X' } });
    fireEvent.change(within(dialog).getByLabelText(/vertical/i), { target: { value: 'plumber' } });

    fireEvent.click(within(dialog).getByRole('button', { name: /create template/i }));

    await waitFor(() =>
      expect(createSpy).toHaveBeenCalledWith(expect.objectContaining({ category: 'plumber' })),
    );
  });
});
