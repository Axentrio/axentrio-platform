import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route, Link } from 'react-router-dom';
import { MobileNavDrawer } from './MobileNavDrawer';

vi.mock('./Sidebar', () => ({
  Sidebar: () => <div data-testid="sidebar-stub">Sidebar</div>,
}));

function renderDrawer(open: boolean, onClose = vi.fn()) {
  return {
    onClose,
    ...render(
      <MemoryRouter initialEntries={['/inbox']}>
        <MobileNavDrawer open={open} onClose={onClose} />
        <Routes>
          <Route path="/inbox" element={<Link to="/bookings">Go to bookings</Link>} />
          <Route path="/bookings" element={<div>Bookings</div>} />
        </Routes>
      </MemoryRouter>,
    ),
  };
}

describe('MobileNavDrawer', () => {
  afterEach(() => {
    document.body.style.overflow = '';
  });

  it('renders nothing when closed', () => {
    renderDrawer(false);
    expect(screen.queryByRole('dialog', { name: 'Navigation' })).not.toBeInTheDocument();
  });

  it('renders the sidebar dialog when open', () => {
    renderDrawer(true);
    expect(screen.getByRole('dialog', { name: 'Navigation' })).toBeInTheDocument();
    expect(screen.getByTestId('sidebar-stub')).toBeInTheDocument();
  });

  it('closes on backdrop click', async () => {
    const user = userEvent.setup();
    const { onClose } = renderDrawer(true);
    onClose.mockClear();
    await user.click(document.querySelector('[aria-hidden="true"]') as Element);
    expect(onClose).toHaveBeenCalled();
  });

  it('closes on Escape', async () => {
    const user = userEvent.setup();
    const { onClose } = renderDrawer(true);
    onClose.mockClear();
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalled();
  });

  it('closes when the route changes', async () => {
    const user = userEvent.setup();
    const { onClose } = renderDrawer(true);
    onClose.mockClear();
    await user.click(screen.getByRole('link', { name: 'Go to bookings' }));
    expect(onClose).toHaveBeenCalled();
  });

  it('locks body scroll while open', () => {
    const { unmount } = renderDrawer(true);
    expect(document.body.style.overflow).toBe('hidden');
    unmount();
    expect(document.body.style.overflow).not.toBe('hidden');
  });
});
