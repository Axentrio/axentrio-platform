import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import AdminBotTemplateDetail from './AdminBotTemplateDetail';

// Mutable query state so a single test can drive the loading → loaded transition
// (the exact shape that surfaced the hooks-after-early-return crash, React #310).
const { state } = vi.hoisted(() => ({
  state: { detail: { data: undefined, isLoading: true, isError: false } as { data: unknown; isLoading: boolean; isError: boolean } },
}));

const MOCK_DETAIL = {
  template: { id: 't1', key: 'plumber', displayName: 'Plumber Booking Bot', status: 'active', category: null, description: 'Books plumbers', availableToAllTenants: true, createdAt: '', updatedAt: '' },
  versions: [
    { id: 'v1', templateId: 't1', version: 1, body: 'You are {botName}.', changelog: 'init', expectedModules: [], config: {}, status: 'published', publishedAt: '', publishedBy: '', lockVersion: 0, createdAt: '', updatedAt: '' },
  ],
  grantedTenantIds: [],
  usage: { bots: 2, tenants: 1 },
  moduleCatalog: [{ id: 'booking', displayName: 'Booking' }],
};

vi.mock('@/queries/useBotTemplatesQueries', () => {
  const m = () => ({ mutate: () => {}, mutateAsync: async () => ({}), isPending: false });
  return {
    useAdminBotTemplateDetail: () => state.detail,
    useUpdateBotTemplate: m,
    useArchiveBotTemplate: m,
    useCreateTemplateVersion: m,
    useEditTemplateVersion: m,
    usePublishTemplateVersion: m,
    useUnpublishTemplateVersion: m,
    useDeleteTemplateVersion: m,
    useRollbackTemplate: m,
    useUpdateTemplateGrants: m,
    useTemplateTestChat: m,
    forceConflict: () => null,
  };
});

vi.mock('@/queries/useAdminQueries', () => ({
  useAdminTenantsAll: () => ({ data: [] }),
}));

const renderPage = () => render(
  <MemoryRouter initialEntries={['/admin/bot-templates/t1']}>
    <AdminBotTemplateDetail />
  </MemoryRouter>,
);

describe('AdminBotTemplateDetail', () => {
  it('renders the loaded template without crashing (current prompt + usage)', () => {
    state.detail = { data: MOCK_DETAIL, isLoading: false, isError: false };
    renderPage();
    expect(screen.getByText('Plumber Booking Bot')).toBeInTheDocument();
    expect(screen.getByText('Current prompt')).toBeInTheDocument();
    // usage badge (i18n: "{{bots}} bot(s) · {{tenants}} tenant(s)")
    expect(screen.getByText(/2 bot\(s\) · 1 tenant\(s\)/)).toBeInTheDocument();
  });

  it('survives the loading → loaded transition (guards against hooks-order regressions)', () => {
    // Loading first: only hooks above the early return run.
    state.detail = { data: undefined, isLoading: true, isError: false };
    const { rerender } = renderPage();
    // Then data arrives — every hook must have been declared above the guards, or
    // React throws #310 (the bug this test exists to catch).
    state.detail = { data: MOCK_DETAIL, isLoading: false, isError: false };
    expect(() =>
      rerender(
        <MemoryRouter initialEntries={['/admin/bot-templates/t1']}>
          <AdminBotTemplateDetail />
        </MemoryRouter>,
      ),
    ).not.toThrow();
    expect(screen.getByText('Plumber Booking Bot')).toBeInTheDocument();
  });
});
