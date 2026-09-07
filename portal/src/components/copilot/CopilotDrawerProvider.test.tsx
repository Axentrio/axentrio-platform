import { describe, expect, it, vi } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { useEffect } from 'react';
import { CopilotDrawerProvider, useCopilotDrawer } from './CopilotDrawerProvider';

const { sendHandler, signals } = vi.hoisted(() => {
  const captured: AbortSignal[] = [];
  return {
    signals: captured,
    // Never settles: models a stream that is still running at unmount.
    sendHandler: vi.fn((args: { signal: AbortSignal }) => {
      captured.push(args.signal);
      return new Promise<void>(() => {});
    }),
  };
});

vi.mock('@/queries/useReadinessQueries', () => ({
  useBotReadiness: () => ({ data: { capabilities: [] } }),
}));

vi.mock('@/queries/useCopilotQueries', () => ({
  useSendCopilotMessageHandler: () => sendHandler,
  useClearCopilotConversation: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

vi.mock('@/queries/useEntitlementsQueries', () => ({
  useHasFeature: () => true,
}));

function Sender() {
  const { open, isOpen, send } = useCopilotDrawer();
  useEffect(() => {
    open();
  }, [open]);
  useEffect(() => {
    // The provider aborts any stream started while the drawer is closed.
    if (isOpen) void send('hello');
  }, [isOpen, send]);
  return null;
}

describe('CopilotDrawerProvider', () => {
  it('aborts the in-flight copilot stream when it unmounts', async () => {
    const view = render(
      <CopilotDrawerProvider>
        <Sender />
      </CopilotDrawerProvider>,
    );

    await waitFor(() => expect(signals).toHaveLength(1));
    expect(signals[0].aborted).toBe(false);

    view.unmount();

    expect(signals[0].aborted).toBe(true);
  });
});
