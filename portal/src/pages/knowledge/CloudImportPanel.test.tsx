import { describe, expect, it, vi, afterEach } from 'vitest';
import { act, render, screen, fireEvent } from '@testing-library/react';
import CloudImportPanel from './CloudImportPanel';

// The panel polls the Google connect popup with setInterval. Everything the
// component needs from the query layer is stubbed so the only live timers in
// the test are the ones the popup watcher creates.
const { refetch } = vi.hoisted(() => ({ refetch: vi.fn() }));

vi.mock('@/queries/useKnowledgeQueries', () => ({
  useStorageConnections: () => ({ data: [], refetch }),
  useStoragePickerConfig: () => ({ data: { clientId: null, pickerApiKey: null } }),
  useStorageConnectUrl: () => ({
    mutateAsync: vi.fn().mockResolvedValue({ startUrl: 'https://accounts.google.test/o' }),
    isPending: false,
  }),
  useStartCloudImport: () => ({ mutateAsync: vi.fn() }),
  useDisconnectStorage: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useStorageImportJobs: () => ({ data: [], refetch: vi.fn() }),
  useOneDriveConnectUrl: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useKnowledgeStats: () => ({ data: undefined }),
}));

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('CloudImportPanel popup watchers', () => {
  it('stops polling the Google connect popup when the panel unmounts', async () => {
    vi.useFakeTimers();
    const popup = { closed: false, close: vi.fn() } as unknown as Window;
    vi.spyOn(window, 'open').mockReturnValue(popup);

    const view = render(<CloudImportPanel onImported={vi.fn()} />);
    const connectButtons = screen.getAllByRole('button', { name: /connect/i });

    await act(async () => {
      fireEvent.click(connectButtons[0]);
    });

    expect(window.open).toHaveBeenCalled();
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    view.unmount();

    expect(vi.getTimerCount()).toBe(0);
  });
});
