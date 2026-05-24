/**
 * Tests for NotifyMeButton (M1, subscription/feature-access epic).
 *
 * - Renders the "Notify me" CTA initially.
 * - Click fires POST /demand-signals/notify-me with {feature, context}.
 * - 200 → flips to "Notified" + success toast.
 * - 429 → flips to "Notified" + info toast (already-requested case).
 * - 500 → error toast, button remains enabled (still clickable).
 * - localStorage `notifyMe:<feature>` persists notified state across mounts.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import { AxiosError, AxiosHeaders } from 'axios';

const { apiPost, toastSuccess, toastError, toastInfo } = vi.hoisted(() => ({
  apiPost: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  toastInfo: vi.fn(),
}));

vi.mock('../../services/apiClient', () => ({
  api: {
    get: vi.fn(),
    post: apiPost,
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
}));

vi.mock('sonner', () => ({
  toast: { success: toastSuccess, error: toastError, info: toastInfo },
}));

import { NotifyMeButton } from './NotifyMeButton';

function renderUI(props: Partial<React.ComponentProps<typeof NotifyMeButton>> = {}) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <NotifyMeButton feature="bookings" {...props} />
    </QueryClientProvider>,
  );
}

function makeAxiosError(status: number): AxiosError {
  const err = new AxiosError('upstream error', String(status));
  err.response = {
    status,
    statusText: 'x',
    data: {},
    headers: {},
    config: { headers: new AxiosHeaders() },
  };
  return err;
}

beforeEach(() => {
  apiPost.mockReset();
  toastSuccess.mockReset();
  toastError.mockReset();
  toastInfo.mockReset();
  // Clean slate per test — previous notified state would short-circuit clicks.
  window.localStorage.clear();
});

describe('NotifyMeButton', () => {
  it('renders the "Notify me" label initially', () => {
    renderUI();
    expect(screen.getByRole('button', { name: /Notify me/i })).toBeInTheDocument();
  });

  it('POSTs /demand-signals/notify-me with {feature, context} on click', async () => {
    apiPost.mockResolvedValueOnce({});
    const user = userEvent.setup();
    renderUI({ feature: 'bookings', context: { source: 'sidebar' } });

    await user.click(screen.getByRole('button', { name: /Notify me/i }));

    expect(apiPost).toHaveBeenCalledTimes(1);
    expect(apiPost).toHaveBeenCalledWith('/demand-signals/notify-me', {
      feature: 'bookings',
      context: { source: 'sidebar' },
    });
  });

  it('toggles to "Notified" state and shows a success toast on 2xx', async () => {
    apiPost.mockResolvedValueOnce({});
    const user = userEvent.setup();
    renderUI();

    await user.click(screen.getByRole('button', { name: /Notify me/i }));

    expect(await screen.findByRole('button', { name: /Notified/i })).toBeInTheDocument();
    expect(toastSuccess).toHaveBeenCalledTimes(1);
    expect(toastError).not.toHaveBeenCalled();
  });

  it('treats HTTP 429 as already-requested: notified state + info toast', async () => {
    apiPost.mockRejectedValueOnce(makeAxiosError(429));
    const user = userEvent.setup();
    renderUI();

    await user.click(screen.getByRole('button', { name: /Notify me/i }));

    expect(await screen.findByRole('button', { name: /Notified/i })).toBeInTheDocument();
    expect(toastInfo).toHaveBeenCalledTimes(1);
    expect(toastError).not.toHaveBeenCalled();
  });

  it('shows an error toast and keeps the button clickable on HTTP 500', async () => {
    apiPost.mockRejectedValueOnce(makeAxiosError(500));
    const user = userEvent.setup();
    renderUI();

    const button = screen.getByRole('button', { name: /Notify me/i });
    await user.click(button);

    // Error toast fires.
    expect(toastError).toHaveBeenCalledTimes(1);
    // Button stays in the unnotified state (still labelled "Notify me") and
    // is not disabled — the user can retry.
    expect(screen.getByRole('button', { name: /Notify me/i })).toBeEnabled();
  });

  it('persists notified state in localStorage across renders', async () => {
    apiPost.mockResolvedValueOnce({});
    const user = userEvent.setup();
    const { unmount } = renderUI({ feature: 'bookings' });

    await user.click(screen.getByRole('button', { name: /Notify me/i }));
    expect(await screen.findByRole('button', { name: /Notified/i })).toBeInTheDocument();
    expect(window.localStorage.getItem('notifyMe:bookings')).toBe('1');

    unmount();

    // Fresh mount — should pick up the persisted flag without any new API call.
    apiPost.mockClear();
    renderUI({ feature: 'bookings' });
    expect(screen.getByRole('button', { name: /Notified/i })).toBeInTheDocument();
    expect(apiPost).not.toHaveBeenCalled();
  });
});
