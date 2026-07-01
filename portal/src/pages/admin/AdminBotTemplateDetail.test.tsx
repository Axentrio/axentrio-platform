import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import AdminBotTemplateDetail from './AdminBotTemplateDetail';

// Mutable query state so a single test can drive the loading → loaded transition
// (the exact shape that surfaced the hooks-after-early-return crash, React #310).
// `flags` toggles the composable-templates editor per-test (default OFF = legacy).
const { state, updateSpy, createVersionSpy, publishSpy, flags } = vi.hoisted(() => ({
  state: { detail: { data: undefined, isLoading: true, isError: false } as { data: unknown; isLoading: boolean; isError: boolean } },
  updateSpy: vi.fn(async () => ({})),
  createVersionSpy: vi.fn(async () => ({ version: { version: 2, lockVersion: 0 } })),
  publishSpy: vi.fn(async () => ({ version: { version: 2 } })),
  flags: { composable: false },
}));

// Flag mock — the editor reads COMPOSABLE_TEMPLATES_ENABLED at render via a live
// binding, so the getter lets each test pick legacy (OFF) vs composable (ON).
vi.mock('@/config/featureFlags', () => ({
  get COMPOSABLE_TEMPLATES_ENABLED() { return flags.composable; },
  CAPABILITY_READINESS_ENABLED: false,
}));

beforeEach(() => {
  flags.composable = false; // default: legacy editor (existing tests)
});

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
    useAdminModules: () => ({
      data: [
        {
          module: { id: 'mod1', name: 'Booking flow', description: null, skillIds: ['booking'] },
          versions: [{ id: 'mv1', moduleId: 'mod1', version: 1, prose: '', status: 'published', lockVersion: 0 }],
        },
      ],
    }),
    useAdminSkills: () => ({
      data: [{ id: 'booking', displayName: 'Bookings', description: null, readinessHint: null, feature: 'bookings', provides: ['create_booking'], needsSetup: true }],
    }),
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

describe('AdminBotTemplateDetail — Composition card (flag ON, view mode)', () => {
  it('shows general prompt + the bound module → its skill from the published version', () => {
    flags.composable = true;
    state.detail = {
      data: {
        ...MOCK_DETAIL,
        versions: [
          {
            ...MOCK_DETAIL.versions[0],
            body: 'You are a dental assistant.',
            selectedModuleRefs: [{ moduleId: 'mod1', moduleVersion: 1 }],
          },
        ],
      },
      isLoading: false,
      isError: false,
    };
    renderPage();

    // The card names itself, echoes the prompt (also shown in the Current-prompt
    // pane, hence 2), and resolves the ref chain: module 'mod1' → name "Booking
    // flow" → skill 'booking' → display "Bookings".
    expect(screen.getByText('Composition')).toBeInTheDocument();
    expect(screen.getAllByText(/You are a dental assistant/).length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText('Booking flow')).toBeInTheDocument();
    expect(screen.getByText('Bookings')).toBeInTheDocument();
  });

  it('flags a legacy direct binding (skill via expectedModules, no module) instead of implying a module produced it', () => {
    flags.composable = true;
    state.detail = {
      data: {
        ...MOCK_DETAIL,
        // legacy shape: skill bound directly via expectedModules, no selectedModuleRefs
        versions: [{ ...MOCK_DETAIL.versions[0], expectedModules: ['booking'], selectedModuleRefs: null }],
      },
      isLoading: false,
      isError: false,
    };
    renderPage();
    // The skill still shows (it's real at runtime) — but marked "direct", with the
    // Modules column explaining the legacy binding rather than a false "prompt-only".
    expect(screen.getByText('Bookings')).toBeInTheDocument();
    expect(screen.getByText('direct')).toBeInTheDocument();
    expect(screen.getByText(/legacy binding from before modules/i)).toBeInTheDocument();
    expect(screen.queryByText(/prompt-only/i)).not.toBeInTheDocument();
  });

  it('reads "prompt-only" when the published version binds no modules', () => {
    flags.composable = true;
    state.detail = { data: MOCK_DETAIL, isLoading: false, isError: false };
    renderPage();
    expect(screen.getByText('Composition')).toBeInTheDocument();
    expect(screen.getByText('None — this template is prompt-only.')).toBeInTheDocument();
  });
});

describe('AdminBotTemplateDetail — composable-templates editor (flag ON)', () => {
  it('renders the module multi-select and saves selectedModuleRefs on publish', async () => {
    flags.composable = true;
    createVersionSpy.mockClear();
    publishSpy.mockClear();
    state.detail = { data: MOCK_DETAIL, isLoading: false, isError: false };
    renderPage();

    fireEvent.click(screen.getByRole('button', { name: /new draft/i }));

    // The module multi-select renders the published module as a checkbox option,
    // and the legacy free-text "Expected modules" control is gone.
    const moduleOption = screen.getByRole('checkbox', { name: /booking flow/i });
    expect(moduleOption).toBeInTheDocument();
    expect(screen.queryByText(/expected modules/i)).not.toBeInTheDocument();

    fireEvent.click(moduleOption);
    fireEvent.click(screen.getByRole('button', { name: /^publish$/i }));

    // The version save pins the selected module to its latest published version.
    await waitFor(() =>
      expect(createVersionSpy).toHaveBeenCalledWith(
        expect.objectContaining({ selectedModuleRefs: [{ moduleId: 'mod1', moduleVersion: 1 }] }),
      ),
    );
    await waitFor(() => expect(publishSpy).toHaveBeenCalledWith(2));
  });
});
