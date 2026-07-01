import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import AdminModules from './AdminModules';

// The page is entirely behind the composable-templates flag, so force it on.
vi.mock('@/config/featureFlags', () => ({ COMPOSABLE_TEMPLATES_ENABLED: true }));

vi.mock('../../queries/useBotTemplatesQueries', () => ({
  useAdminModules: () => ({
    data: [
      {
        module: { id: 'm1', name: 'Salon Booking Concierge', description: 'Book the next slot.', skillIds: ['booking'] },
        versions: [{ version: 1, status: 'draft' }],
      },
    ],
    isLoading: false,
    isError: false,
  }),
  useAdminSkills: () => ({ data: [{ id: 'booking', displayName: 'Booking' }] }),
  useCreateModule: () => ({ mutateAsync: vi.fn(), isPending: false }),
  usePublishModuleVersion: () => ({ mutate: vi.fn(), isPending: false }),
}));

const renderPage = () => render(<MemoryRouter><AdminModules /></MemoryRouter>);

describe('AdminModules', () => {
  it('renders the list with the module name, bound skill, and version status', () => {
    renderPage();
    expect(screen.getByRole('heading', { name: 'Modules' })).toBeInTheDocument();
    expect(screen.getByText('Salon Booking Concierge')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /new module/i })).toBeInTheDocument();
    // The row shows the version status; editing/publishing happens on the detail page.
    expect(screen.getByText('draft')).toBeInTheDocument();
  });

  it('surfaces engineered skills as a read-only reference', () => {
    renderPage();
    expect(screen.getByText(/Skills \(engineered/i)).toBeInTheDocument();
  });
});
