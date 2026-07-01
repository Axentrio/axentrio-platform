import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import AdminStudio from './AdminStudio';

vi.mock('@/config/featureFlags', () => ({ COMPOSABLE_TEMPLATES_ENABLED: true }));
vi.mock('./AdminBotTemplates', () => ({ default: () => <div>TEMPLATES_LIB</div> }));
vi.mock('./AdminModules', () => ({ default: () => <div>MODULES_LIB</div> }));
vi.mock('@/components/admin/SkillsReference', () => ({ SkillsReference: () => <div>SKILLS_REF</div> }));

describe('AdminStudio', () => {
  it('is one surface with a tab per composition layer; Templates is the default', () => {
    render(
      <MemoryRouter initialEntries={['/admin/studio']}>
        <AdminStudio />
      </MemoryRouter>,
    );
    expect(screen.getByRole('heading', { name: 'Bot Studio' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /templates/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /modules/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /skills/i })).toBeInTheDocument();
    // Default tab content is mounted.
    expect(screen.getByText('TEMPLATES_LIB')).toBeInTheDocument();
  });
});
