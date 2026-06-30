import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import AdminBotTemplateDetail from './AdminBotTemplateDetail';

// Mutable query state so a single test can drive the loading → loaded transition
// (the exact shape that surfaced the hooks-after-early-return crash, React #310).
const { state, updateSpy, createVersionSpy, publishSpy } = vi.hoisted(() => ({
  state: { detail: { data: undefined, isLoading: true, isError: false } as { data: unknown; isLoading: boolean; isError: boolean } },
  updateSpy: vi.fn(async () => ({})),
  createVersionSpy: vi.fn(async () => ({ version: { version: 2, lockVersion: 0 } })),
  publishSpy: vi.fn(async () => ({ version: { version: 2 } })),
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
  const m = () => ({ mutate: () => {}, mutateAsync: async () => ({}), reset: () => {}, isPending: false });
  return {
    useAdminBotTemplateDetail: () => state.detail,
    useUpdateBotTemplate: () => ({ mutate: () => {}, mutateAsync: updateSpy, isPending: false }),
    useArchiveBotTemplate: m,
    useCreateTemplateVersion: () => ({ mutate: () => {}, mutateAsync: createVersionSpy, isPending: false }),
    useEditTemplateVersion: m,
    usePublishTemplateVersion: () => ({ mutate: () => {}, mutateAsync: publishSpy, isPending: false }),
    useUnpublishTemplateVersion: m,
    useDeleteTemplateVersion: m,
    useRollbackTemplate: m,
    useUpdateTemplateGrants: m,
    useTemplateTestChat: m,
    usePreviewLedger: m,
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

  it('shows the Vertical field prefilled from category and saves it', async () => {
    updateSpy.mockClear();
    state.detail = {
      data: { ...MOCK_DETAIL, template: { ...MOCK_DETAIL.template, category: 'plumber' } },
      isLoading: false,
      isError: false,
    };
    renderPage();

    const vertical = screen.getByLabelText(/vertical/i);
    expect(vertical).toHaveValue('plumber');

    fireEvent.change(vertical, { target: { value: 'hairdresser' } });
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() =>
      expect(updateSpy).toHaveBeenCalledWith(expect.objectContaining({ category: 'hairdresser' })),
    );
  });
});

describe('AdminBotTemplateDetail — two-pane authoring editor', () => {
  it('opens a two-pane editor with the prompt body and live-ledger context shown together', () => {
    state.detail = { data: MOCK_DETAIL, isLoading: false, isError: false };
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: /new draft/i }));
    // Body and the scenario-preview pane are visible at once — the whole point of
    // the two-pane layout (the preview is no longer buried behind an accordion).
    expect(screen.getByLabelText('Prompt body')).toBeInTheDocument();
    expect(screen.getByText(/preview a scenario/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^publish$/i })).toBeInTheDocument();
  });

  it('Publish saves the draft then publishes that version', async () => {
    createVersionSpy.mockClear();
    publishSpy.mockClear();
    state.detail = { data: MOCK_DETAIL, isLoading: false, isError: false };
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: /new draft/i }));
    fireEvent.click(screen.getByRole('button', { name: /^publish$/i }));
    await waitFor(() => expect(createVersionSpy).toHaveBeenCalled());
    await waitFor(() => expect(publishSpy).toHaveBeenCalledWith(2));
  });
});
