import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const { apiGet, hasFeatureRef } = vi.hoisted(() => ({
  apiGet: vi.fn(),
  hasFeatureRef: { current: true },
}));

vi.mock('@/services/apiClient', () => ({ api: { get: apiGet } }));
vi.mock('@/queries/useEntitlementsQueries', () => ({
  useHasFeature: () => hasFeatureRef.current,
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { ExportMenu } from './ExportMenu';

beforeEach(() => {
  apiGet.mockReset();
  hasFeatureRef.current = true;
  // jsdom lacks blob URL plumbing — stub it.
  globalThis.URL.createObjectURL = vi.fn(() => 'blob:x');
  globalThis.URL.revokeObjectURL = vi.fn();
});

describe('ExportMenu (Enterprise, P3 D7)', () => {
  it('renders nothing without aiBusinessInsights', () => {
    hasFeatureRef.current = false;
    const { container } = render(<ExportMenu />);
    expect(container).toBeEmptyDOMElement();
  });

  it('downloads the chosen dataset via GET /analytics/export', async () => {
    const user = userEvent.setup();
    apiGet.mockResolvedValue(new Blob(['created_at\n'], { type: 'text/csv' }));
    render(<ExportMenu />);

    await user.click(screen.getByRole('button', { name: /export csv/i }));
    await user.click(await screen.findByText(/leads/i));

    await waitFor(() =>
      expect(apiGet).toHaveBeenCalledWith(
        '/analytics/export?dataset=leads&format=csv',
        { responseType: 'blob' },
      ),
    );
  });
});
