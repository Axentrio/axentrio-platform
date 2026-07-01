import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import AdminModuleDetail from './AdminModuleDetail';

vi.mock('../../queries/useBotTemplatesQueries', () => ({
  useAdminModules: () => ({
    data: [
      {
        module: { id: 'm1', name: 'Salon Booking Concierge', description: 'Book the next slot.', skillIds: ['booking'] },
        versions: [{ id: 'v1', moduleId: 'm1', version: 1, prose: 'Greet warmly.', status: 'draft', lockVersion: 0 }],
      },
    ],
    isLoading: false,
    isError: false,
  }),
  useAdminSkills: () => ({ data: [{ id: 'booking', displayName: 'Booking' }] }),
  useEditModule: () => ({ mutate: vi.fn(), isPending: false }),
  useEditModuleDraftVersion: () => ({ mutate: vi.fn(), isPending: false }),
  useCreateModuleDraftVersion: () => ({ mutate: vi.fn(), isPending: false }),
  usePublishModuleVersion: () => ({ mutate: vi.fn(), isPending: false }),
  useTemplateTestChat: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

const renderPage = () =>
  render(
    <MemoryRouter initialEntries={['/admin/modules/m1']}>
      <Routes>
        <Route path="/admin/modules/:id" element={<AdminModuleDetail />} />
      </Routes>
    </MemoryRouter>,
  );

describe('AdminModuleDetail', () => {
  it('lets you edit the catalog, author a draft, and test the module', () => {
    renderPage();
    expect(screen.getByRole('heading', { name: 'Salon Booking Concierge' })).toBeInTheDocument();
    // Editable catalog
    expect(screen.getByLabelText('Name')).toHaveValue('Salon Booking Concierge');
    // Draft prose is editable + publishable
    expect(screen.getByRole('button', { name: /save draft/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /publish v1/i })).toBeInTheDocument();
    // Test panel present
    expect(screen.getByRole('heading', { name: /test this module/i })).toBeInTheDocument();
  });
});
